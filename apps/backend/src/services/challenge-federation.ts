/**
 * Cross-instance challenge federation — server-to-server HTTP.
 *
 * The first real cross-instance traffic in Aurboda. A joining instance fetches
 * the challenge spec from the host, creates a local participation backing a
 * capability data endpoint, and registers itself back to the host. The host
 * later pulls each remote member's data endpoint to build standings.
 *
 * Trust model: a member's instance is trusted to report honest numbers
 * (Strava-style). Capability tokens + the unguessable slug are the only gates.
 */
import {
  type ChallengeDataResponse,
  challengeDataResponseSchema,
  type PublicChallenge,
  publicChallengeResponseSchema,
  type WellKnownAurboda,
  wellKnownAurbodaSchema,
} from '@aurboda/api-spec'
import { isAxiosError } from 'axios'

import { isValidUsername } from '../api/auth-routes.ts'
import {
  type ChallengeParticipationRecord,
  createChallengeParticipation,
  deleteChallengeParticipation,
  getChallengeBySlug,
  getParticipationByUrl,
  upsertChallengeMember,
} from '../db/index.ts'
import { safeFetchGet, safeFetchPost } from './safe-fetch.ts'
import { buildProfileUrl } from './share-urls.ts'

export type JoinChallengeErrorKind = 'invalid_url' | 'not_found' | 'federation'

/** Error subclass so callers can map join failures to HTTP statuses. */
export class JoinChallengeError extends Error {
  readonly kind: JoinChallengeErrorKind

  constructor(message: string, kind: JoinChallengeErrorKind) {
    super(message)
    this.name = 'JoinChallengeError'
    this.kind = kind
  }
}

const trimSlashes = (s: string): string => s.replace(/\/+$/, '')
const joinUrl = (base: string, path: string): string => `${trimSlashes(base)}/${path.replace(/^\/+/, '')}`

/**
 * The one spelling of a public challenge link we store and compare by: no query
 * string or fragment (a pasted `?embed=1` link is the same challenge), no
 * trailing slashes, scheme and host lowercased, default port dropped. Null for
 * anything that isn't an http(s) URL.
 *
 * Everything that keys off a challenge URL — the joined-participation row, the
 * left-tombstone, discovery's "already mine" set — runs through this, so the
 * same challenge pasted two ways is still one challenge. Rows written before
 * this existed are not migrated; readers canonicalise what they load.
 */
export const canonicalChallengeUrl = (url: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.search = ''
  parsed.hash = ''
  return trimSlashes(parsed.toString())
}

export interface ParsedChallengeUrl {
  base: string
  username: string
  slug: string
}

/** Parse a public challenge URL `<base>/u/<username>/<slug>` (base may have a sub-path). */
export const parseChallengeUrl = (url: string): ParsedChallengeUrl | null => {
  const marker = '/u/'
  const i = url.indexOf(marker)
  if (i < 0) return null
  const base = trimSlashes(url.slice(0, i))
  const [username, slug] = url
    .slice(i + marker.length)
    .split('/')
    .filter(Boolean)
  if (!base || !username || !slug) return null
  return { base, slug, username }
}

/** Discover an instance's federation metadata from its base URL. */
export const discoverInstance = async (base: string): Promise<WellKnownAurboda> => {
  const res = await safeFetchGet(joinUrl(base, '.well-known/aurboda'))
  const wellKnown = wellKnownAurbodaSchema.parse(res.data)
  if (wellKnown.product !== 'aurboda' || !wellKnown.federation) {
    throw new Error('Host does not support Aurboda federation')
  }
  return wellKnown
}

/** Fetch a challenge spec from a host's public resolver; throws if not a challenge. */
export const fetchChallengeSpec = async (
  apiBase: string,
  username: string,
  slug: string,
): Promise<PublicChallenge> => {
  const res = await safeFetchGet(
    joinUrl(apiBase, `public/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`),
  )
  const parsed = publicChallengeResponseSchema.safeParse(res.data)
  if (!parsed.success || parsed.data.type !== 'challenge' || !parsed.data.challenge) {
    throw new Error('URL is not an Aurboda challenge')
  }
  return parsed.data.challenge
}

/** Register a member back to the host instance. */
export const registerMemberWithHost = async (
  apiBase: string,
  username: string,
  slug: string,
  body: { identity_base_url: string; display_name: string; data_endpoint_url: string; join_token: string },
): Promise<void> => {
  try {
    await safeFetchPost(
      joinUrl(apiBase, `public/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/members`),
      body,
    )
  } catch (error) {
    // The host signals rejection with a non-2xx status (axios throws). Surface the
    // host's own message (e.g. "Challenge is full") rather than a generic status.
    if (isAxiosError(error)) {
      const hostError = (error.response?.data as { error?: string } | undefined)?.error
      throw new Error(hostError ?? 'Host rejected the join')
    }
    throw error
  }
}

/** Fetch a remote member's data endpoint (SSRF-guarded). */
export const fetchMemberData = async (dataEndpointUrl: string): Promise<ChallengeDataResponse> => {
  const res = await safeFetchGet(dataEndpointUrl)
  return challengeDataResponseSchema.parse(res.data)
}

export interface JoinRemoteDeps {
  user: string
  challengeUrl: string
  parsed: ParsedChallengeUrl
  ourWebHost: string
  ourApiBase: string
}

/**
 * Join a challenge hosted on another instance: discover host, fetch spec, create
 * a local participation + data endpoint, and register back. Returns the
 * participation (its `data_token` backs `/challenge-data/:token`).
 */
export const joinRemoteChallenge = async ({
  user,
  challengeUrl,
  parsed,
  ourWebHost,
  ourApiBase,
}: JoinRemoteDeps): Promise<ChallengeParticipationRecord> => {
  const wellKnown = await discoverInstance(parsed.base)
  const spec = await fetchChallengeSpec(wellKnown.api_base, parsed.username, parsed.slug)

  const participation = await createChallengeParticipation(user, {
    challenge_url: challengeUrl,
    end_ts: new Date(spec.end_ts),
    host_identity: spec.host_identity,
    name: spec.name,
    spec: {
      activity_type_id: spec.spec.activity_type_id ?? null,
      aggregation: spec.spec.aggregation,
      bucket_size: spec.spec.bucket_size,
      pattern: spec.spec.pattern ?? null,
      source_type: spec.spec.source_type,
      unit: spec.spec.unit,
    },
    start_ts: new Date(spec.start_ts),
    timezone: spec.timezone,
  })

  try {
    await registerMemberWithHost(wellKnown.api_base, parsed.username, parsed.slug, {
      data_endpoint_url: joinUrl(
        ourApiBase,
        `challenge-data/${encodeURIComponent(user)}/${participation.data_token}`,
      ),
      display_name: user,
      identity_base_url: buildProfileUrl(ourWebHost, user),
      join_token: spec.join_token,
    })
  } catch (error) {
    // Roll back the local participation if the host wouldn't accept us. This is
    // a failed join, not a leave: no tombstone, or discovery would stop
    // offering a challenge the user never got into.
    await deleteChallengeParticipation(user, participation.id, { tombstone: false }).catch(() => {})
    throw error
  }

  return participation
}

export interface JoinChallengeDeps {
  user: string
  challengeUrl: string
  webHost: string
  apiBaseUrl: string
}

/**
 * Join a challenge by URL. If the host is this instance, join directly (no
 * HTTP); otherwise federate. Always records a local participation so the
 * challenge shows in the joiner's "my challenges".
 */
export const joinChallenge = async ({
  user,
  challengeUrl,
  webHost,
  apiBaseUrl,
}: JoinChallengeDeps): Promise<ChallengeParticipationRecord> => {
  // Canonicalise before parsing: a pasted link may carry `?embed=1`, which
  // would otherwise end up glued to the slug.
  const normalizedUrl = canonicalChallengeUrl(challengeUrl)
  const parsed = normalizedUrl === null ? null : parseChallengeUrl(normalizedUrl)
  // Validate the username at this username→DB boundary, matching every other one.
  if (normalizedUrl === null || !parsed || !isValidUsername(parsed.username)) {
    throw new JoinChallengeError('Not a valid challenge URL', 'invalid_url')
  }

  // Idempotent: joining the same challenge again returns the existing record
  // instead of creating a duplicate participation (with a second data token).
  const existing = await getParticipationByUrl(user, normalizedUrl).catch(() => null)
  if (existing) return existing

  // Local shortcut: the host is this instance.
  if (parsed.base === trimSlashes(webHost)) {
    const challenge = await getChallengeBySlug(parsed.username, parsed.slug).catch(() => null)
    if (!challenge) throw new JoinChallengeError('Challenge not found', 'not_found')
    await upsertChallengeMember(parsed.username, challenge.id, {
      display_name: user,
      identity_base_url: buildProfileUrl(webHost, user),
      kind: 'local',
      local_user: user,
    })
    return createChallengeParticipation(user, {
      challenge_url: normalizedUrl,
      end_ts: challenge.end_ts,
      host_identity: buildProfileUrl(webHost, parsed.username),
      name: challenge.name,
      spec: challenge.spec,
      start_ts: challenge.start_ts,
      timezone: challenge.timezone,
    })
  }

  try {
    return await joinRemoteChallenge({
      challengeUrl: normalizedUrl,
      ourApiBase: apiBaseUrl,
      ourWebHost: webHost,
      parsed,
      user,
    })
  } catch (error) {
    throw new JoinChallengeError(
      error instanceof Error ? error.message : 'Failed to join challenge',
      'federation',
    )
  }
}
