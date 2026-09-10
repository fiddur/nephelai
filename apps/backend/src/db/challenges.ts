import type { ChallengeAggregation, ChallengeSourceType, ChartDataBucket } from '@aurboda/api-spec'

import { randomBytes } from 'node:crypto'

/**
 * Challenges + memberships (host DB) and participations (joiner DB).
 *
 * Challenges live in the host user's database; remote members are referenced by
 * their public base-URL identity and pulled via a capability data endpoint.
 * A user's *participations* (challenges they joined elsewhere) live in their own
 * database, each backed by an unguessable `data_token`.
 */
import { query } from './connection.ts'
import { getSharedDashboardBySlug } from './shared-dashboards.ts'

export type ChallengeBucketSize = 'auto' | '1d' | '1w' | '1M'

export interface ChallengeSpecFields {
  source_type: ChallengeSourceType
  pattern: string
  activity_type_id: string | null
  aggregation: ChallengeAggregation
  unit: string
  bucket_size: ChallengeBucketSize
}

export interface ChallengeRecord {
  id: string
  slug: string
  name: string
  is_public: boolean
  spec: ChallengeSpecFields
  start_ts: Date
  end_ts: Date
  timezone: string
  join_token: string
  /** Post the final standings (winner tagged) to the host's feed when the window closes. */
  announce_winner: boolean
  /** When the completion sweep published (or deliberately skipped) the result; null while pending. */
  result_published_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface ChallengeInput {
  name: string
  is_public: boolean
  spec: ChallengeSpecFields
  start_ts: Date
  end_ts: Date
  timezone: string
  announce_winner: boolean
}

export interface ChallengePatch {
  name?: string
  is_public?: boolean
  spec?: ChallengeSpecFields
  start_ts?: Date
  end_ts?: Date
  timezone?: string
  announce_winner?: boolean
}

export interface ChallengeMemberRecord {
  id: string
  challenge_id: string
  identity_base_url: string
  display_name: string
  kind: 'local' | 'remote'
  local_user: string | null
  data_endpoint_url: string | null
  status: 'active' | 'withdrawn'
  joined_at: Date
  last_fetched_at: Date | null
  /** When this member's underlying data was last updated (reported by the member). */
  data_last_updated: Date | null
  cached_total: number | null
  cached_buckets: ChartDataBucket[] | null
  last_error: string | null
}

export interface ChallengeMemberInput {
  identity_base_url: string
  display_name: string
  kind: 'local' | 'remote'
  local_user?: string | null
  data_endpoint_url?: string | null
}

export interface ChallengeParticipationRecord {
  id: string
  challenge_url: string
  host_identity: string
  name: string
  spec: ChallengeSpecFields
  start_ts: Date
  end_ts: Date
  timezone: string
  data_token: string
  status: 'active' | 'withdrawn'
  created_at: Date
}

export interface ChallengeParticipationInput {
  challenge_url: string
  host_identity: string
  name: string
  spec: ChallengeSpecFields
  start_ts: Date
  end_ts: Date
  timezone: string
}

const CHALLENGE_COLUMNS =
  'id, slug, name, is_public, source_type, pattern, activity_type_id, aggregation, unit, bucket_size, start_ts, end_ts, timezone, join_token, announce_winner, result_published_at, created_at, updated_at'

const MEMBER_COLUMNS =
  'id, challenge_id, identity_base_url, display_name, kind, local_user, data_endpoint_url, status, joined_at, last_fetched_at, data_last_updated, cached_total, cached_buckets, last_error'

const PARTICIPATION_COLUMNS =
  'id, challenge_url, host_identity, name, source_type, pattern, activity_type_id, aggregation, unit, bucket_size, start_ts, end_ts, timezone, data_token, status, created_at'

interface ChallengeRow {
  id: string
  slug: string
  name: string
  is_public: boolean
  source_type: ChallengeSourceType
  pattern: string
  activity_type_id: string | null
  aggregation: ChallengeAggregation
  unit: string
  bucket_size: ChallengeBucketSize
  start_ts: Date
  end_ts: Date
  timezone: string
  join_token: string
  announce_winner: boolean
  result_published_at: Date | null
  created_at: Date
  updated_at: Date
}

const toSpec = (row: ChallengeRow | ParticipationRow): ChallengeSpecFields => ({
  activity_type_id: row.activity_type_id,
  aggregation: row.aggregation,
  bucket_size: row.bucket_size,
  pattern: row.pattern,
  source_type: row.source_type,
  unit: row.unit,
})

const mapChallenge = (row: ChallengeRow): ChallengeRecord => ({
  announce_winner: row.announce_winner,
  created_at: row.created_at,
  end_ts: row.end_ts,
  id: row.id,
  is_public: row.is_public,
  join_token: row.join_token,
  name: row.name,
  result_published_at: row.result_published_at,
  slug: row.slug,
  spec: toSpec(row),
  start_ts: row.start_ts,
  timezone: row.timezone,
  updated_at: row.updated_at,
})

interface MemberRow extends Omit<ChallengeMemberRecord, 'cached_buckets'> {
  cached_buckets: ChartDataBucket[] | null
}

const mapMember = (row: MemberRow): ChallengeMemberRecord => ({ ...row })

interface ParticipationRow {
  id: string
  challenge_url: string
  host_identity: string
  name: string
  source_type: ChallengeSourceType
  pattern: string
  activity_type_id: string | null
  aggregation: ChallengeAggregation
  unit: string
  bucket_size: ChallengeBucketSize
  start_ts: Date
  end_ts: Date
  timezone: string
  data_token: string
  status: 'active' | 'withdrawn'
  created_at: Date
}

const mapParticipation = (row: ParticipationRow): ChallengeParticipationRecord => ({
  challenge_url: row.challenge_url,
  created_at: row.created_at,
  data_token: row.data_token,
  end_ts: row.end_ts,
  host_identity: row.host_identity,
  id: row.id,
  name: row.name,
  spec: toSpec(row),
  start_ts: row.start_ts,
  status: row.status,
  timezone: row.timezone,
})

const randomToken = (bytes: number): string => randomBytes(bytes).toString('base64url')

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: string }).code === '23505'

// ===========================================================================
// Challenges (host)
// ===========================================================================

export const listChallenges = async (user: string): Promise<ChallengeRecord[]> => {
  const result = await query<ChallengeRow>(
    user,
    `SELECT ${CHALLENGE_COLUMNS} FROM challenges ORDER BY created_at DESC`,
  )
  return result.rows.map(mapChallenge)
}

export const listPublicChallenges = async (user: string): Promise<ChallengeRecord[]> => {
  const result = await query<ChallengeRow>(
    user,
    `SELECT ${CHALLENGE_COLUMNS} FROM challenges WHERE is_public = true ORDER BY created_at DESC`,
  )
  return result.rows.map(mapChallenge)
}

export const getChallengeById = async (user: string, id: string): Promise<ChallengeRecord | null> => {
  const result = await query<ChallengeRow>(
    user,
    `SELECT ${CHALLENGE_COLUMNS} FROM challenges WHERE id = $1`,
    [id],
  )
  return result.rows.length ? mapChallenge(result.rows[0]) : null
}

export const getChallengeBySlug = async (user: string, slug: string): Promise<ChallengeRecord | null> => {
  const result = await query<ChallengeRow>(
    user,
    `SELECT ${CHALLENGE_COLUMNS} FROM challenges WHERE slug = $1`,
    [slug],
  )
  return result.rows.length ? mapChallenge(result.rows[0]) : null
}

/** True if a slug is free across BOTH challenges and shared dashboards for this user. */
const slugIsFree = async (user: string, slug: string): Promise<boolean> =>
  (await getChallengeBySlug(user, slug)) === null && (await getSharedDashboardBySlug(user, slug)) === null

export const createChallenge = async (user: string, input: ChallengeInput): Promise<ChallengeRecord> => {
  const joinToken = randomToken(24)
  const maxAttempts = 5
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const slug = randomToken(7)
    // Cheap pre-check across both slug namespaces; UNIQUE handles the race.
    if (!(await slugIsFree(user, slug))) continue
    try {
      const result = await query<ChallengeRow>(
        user,
        `INSERT INTO challenges
           (slug, name, is_public, source_type, pattern, activity_type_id, aggregation, unit, bucket_size, start_ts, end_ts, timezone, join_token, announce_winner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${CHALLENGE_COLUMNS}`,
        [
          slug,
          input.name,
          input.is_public,
          input.spec.source_type,
          input.spec.pattern,
          input.spec.activity_type_id,
          input.spec.aggregation,
          input.spec.unit,
          input.spec.bucket_size,
          input.start_ts,
          input.end_ts,
          input.timezone,
          joinToken,
          input.announce_winner,
        ],
      )
      return mapChallenge(result.rows[0])
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }
  throw new Error(`Failed to generate a unique challenge slug after ${maxAttempts} attempts`)
}

export const updateChallenge = async (
  user: string,
  id: string,
  patch: ChallengePatch,
): Promise<ChallengeRecord | null> => {
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1
  const set = (col: string, value: unknown) => {
    sets.push(`${col} = $${idx++}`)
    params.push(value)
  }

  if (patch.name !== undefined) set('name', patch.name)
  if (patch.is_public !== undefined) set('is_public', patch.is_public)
  if (patch.start_ts !== undefined) set('start_ts', patch.start_ts)
  if (patch.end_ts !== undefined) set('end_ts', patch.end_ts)
  if (patch.timezone !== undefined) set('timezone', patch.timezone)
  if (patch.announce_winner !== undefined) set('announce_winner', patch.announce_winner)
  if (patch.spec !== undefined) {
    set('source_type', patch.spec.source_type)
    set('pattern', patch.spec.pattern)
    set('activity_type_id', patch.spec.activity_type_id)
    set('aggregation', patch.spec.aggregation)
    set('unit', patch.spec.unit)
    set('bucket_size', patch.spec.bucket_size)
  }

  if (sets.length === 0) return getChallengeById(user, id)

  sets.push('updated_at = NOW()')
  params.push(id)
  const result = await query<ChallengeRow>(
    user,
    `UPDATE challenges SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${CHALLENGE_COLUMNS}`,
    params,
  )
  return result.rows.length ? mapChallenge(result.rows[0]) : null
}

export const deleteChallenge = async (user: string, id: string): Promise<boolean> => {
  const result = await query(user, `DELETE FROM challenges WHERE id = $1`, [id])
  return (result.rowCount ?? 0) > 0
}

/**
 * Hosted challenges that want a winner announcement and haven't had one yet,
 * whose window closed within `(endedAfter, endedBefore]` — the completion
 * sweep's work list. The upper bound is the grace period; the lower bound is
 * what keeps the sweep from ever announcing history: rows that pre-date the
 * feature (the column backfills `announce_winner = true` onto every existing
 * challenge) or that were skipped for days must never fan out as fresh news.
 * Oldest end first so a backlog drains in order.
 */
export const listChallengesAwaitingResult = async (
  user: string,
  window: { endedAfter: Date; endedBefore: Date },
): Promise<ChallengeRecord[]> => {
  const result = await query<ChallengeRow>(
    user,
    `SELECT ${CHALLENGE_COLUMNS} FROM challenges
     WHERE announce_winner = true AND result_published_at IS NULL
       AND end_ts <= $1 AND end_ts > $2
     ORDER BY end_ts ASC`,
    [window.endedBefore, window.endedAfter],
  )
  return result.rows.map(mapChallenge)
}

/**
 * Stamp a challenge's result as published (or deliberately skipped, e.g. nobody
 * scored) so the sweep never announces it twice. Returns false if there was no
 * such pending challenge — a concurrent sweep already claimed it.
 */
export const markChallengeResultPublished = async (user: string, id: string): Promise<boolean> => {
  const result = await query(
    user,
    `UPDATE challenges SET result_published_at = NOW() WHERE id = $1 AND result_published_at IS NULL`,
    [id],
  )
  return (result.rowCount ?? 0) > 0
}

// ===========================================================================
// Members (host)
// ===========================================================================

export const listChallengeMembers = async (
  user: string,
  challengeId: string,
): Promise<ChallengeMemberRecord[]> => {
  const result = await query<MemberRow>(
    user,
    `SELECT ${MEMBER_COLUMNS} FROM challenge_members WHERE challenge_id = $1 ORDER BY joined_at ASC`,
    [challengeId],
  )
  return result.rows.map(mapMember)
}

export const getChallengeMemberByIdentity = async (
  user: string,
  challengeId: string,
  identityBaseUrl: string,
): Promise<ChallengeMemberRecord | null> => {
  const result = await query<MemberRow>(
    user,
    `SELECT ${MEMBER_COLUMNS} FROM challenge_members WHERE challenge_id = $1 AND identity_base_url = $2`,
    [challengeId, identityBaseUrl],
  )
  return result.rows.length ? mapMember(result.rows[0]) : null
}

/** Insert or update a member by (challenge, identity). */
export const upsertChallengeMember = async (
  user: string,
  challengeId: string,
  input: ChallengeMemberInput,
): Promise<ChallengeMemberRecord> => {
  const result = await query<MemberRow>(
    user,
    `INSERT INTO challenge_members
       (challenge_id, identity_base_url, display_name, kind, local_user, data_endpoint_url, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active')
     ON CONFLICT (challenge_id, identity_base_url)
     DO UPDATE SET display_name = EXCLUDED.display_name,
                   kind = EXCLUDED.kind,
                   local_user = EXCLUDED.local_user,
                   data_endpoint_url = EXCLUDED.data_endpoint_url,
                   status = 'active'
     RETURNING ${MEMBER_COLUMNS}`,
    [
      challengeId,
      input.identity_base_url,
      input.display_name,
      input.kind,
      input.local_user ?? null,
      input.data_endpoint_url ?? null,
    ],
  )
  return mapMember(result.rows[0])
}

export const removeChallengeMember = async (
  user: string,
  challengeId: string,
  memberId: string,
): Promise<boolean> => {
  const result = await query(user, `DELETE FROM challenge_members WHERE id = $1 AND challenge_id = $2`, [
    memberId,
    challengeId,
  ])
  return (result.rowCount ?? 0) > 0
}

/**
 * Persist a freshly fetched series (or the error) for a member.
 *
 * `last_fetched_at` records when *we* fetched; `data_last_updated` is the
 * member-reported timestamp of their latest data point (null if none), which is
 * what standings surface as "last updated". On a failed fetch, pass the previous
 * `data_last_updated` to keep the last-known value.
 */
export const updateChallengeMemberCache = async (
  user: string,
  memberId: string,
  data: {
    total: number | null
    buckets: ChartDataBucket[] | null
    error: string | null
    dataLastUpdated: Date | null
  },
): Promise<void> => {
  await query(
    user,
    `UPDATE challenge_members
       SET cached_total = $1, cached_buckets = $2::jsonb, last_error = $3,
           data_last_updated = $4, last_fetched_at = NOW()
     WHERE id = $5`,
    [
      data.total,
      data.buckets ? JSON.stringify(data.buckets) : null,
      data.error,
      data.dataLastUpdated,
      memberId,
    ],
  )
}

// ===========================================================================
// Participations (joiner)
// ===========================================================================

export const createChallengeParticipation = async (
  user: string,
  input: ChallengeParticipationInput,
): Promise<ChallengeParticipationRecord> => {
  const dataToken = randomToken(24)
  const result = await query<ParticipationRow>(
    user,
    // Joining clears any leave-tombstone for the same URL, so leave → rejoin →
    // leave works and the second leave suppresses it again (#1093).
    `WITH cleared AS (
       DELETE FROM challenge_left WHERE challenge_url = $1
     )
     INSERT INTO challenge_participations
       (challenge_url, host_identity, name, source_type, pattern, activity_type_id, aggregation, unit, bucket_size, start_ts, end_ts, timezone, data_token)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING ${PARTICIPATION_COLUMNS}`,
    [
      input.challenge_url,
      input.host_identity,
      input.name,
      input.spec.source_type,
      input.spec.pattern,
      input.spec.activity_type_id,
      input.spec.aggregation,
      input.spec.unit,
      input.spec.bucket_size,
      input.start_ts,
      input.end_ts,
      input.timezone,
      dataToken,
    ],
  )
  return mapParticipation(result.rows[0])
}

export const listChallengeParticipations = async (user: string): Promise<ChallengeParticipationRecord[]> => {
  const result = await query<ParticipationRow>(
    user,
    `SELECT ${PARTICIPATION_COLUMNS} FROM challenge_participations ORDER BY created_at DESC`,
  )
  return result.rows.map(mapParticipation)
}

export const getParticipationById = async (
  user: string,
  id: string,
): Promise<ChallengeParticipationRecord | null> => {
  const result = await query<ParticipationRow>(
    user,
    `SELECT ${PARTICIPATION_COLUMNS} FROM challenge_participations WHERE id = $1`,
    [id],
  )
  return result.rows.length ? mapParticipation(result.rows[0]) : null
}

export const getParticipationByToken = async (
  user: string,
  token: string,
): Promise<ChallengeParticipationRecord | null> => {
  const result = await query<ParticipationRow>(
    user,
    `SELECT ${PARTICIPATION_COLUMNS} FROM challenge_participations WHERE data_token = $1`,
    [token],
  )
  return result.rows.length ? mapParticipation(result.rows[0]) : null
}

export const getParticipationByUrl = async (
  user: string,
  challengeUrl: string,
): Promise<ChallengeParticipationRecord | null> => {
  const result = await query<ParticipationRow>(
    user,
    `SELECT ${PARTICIPATION_COLUMNS} FROM challenge_participations WHERE challenge_url = $1 LIMIT 1`,
    [challengeUrl],
  )
  return result.rows.length ? mapParticipation(result.rows[0]) : null
}

/**
 * Leave a challenge: the participation row is hard-deleted and the challenge
 * URL kept as a tombstone in `challenge_left`, so discovery never suggests
 * again what the user deliberately walked away from (#1093). Written inside the
 * delete statement, the way `deleteFeedPost` records an auto-share suppression.
 *
 * Pass `tombstone: false` for a delete that is *not* a leave — the rollback of
 * a join the host rejected — which must leave the challenge discoverable.
 */
export const deleteChallengeParticipation = async (
  user: string,
  id: string,
  options: { tombstone?: boolean } = {},
): Promise<boolean> => {
  if (options.tombstone === false) {
    const result = await query(user, `DELETE FROM challenge_participations WHERE id = $1`, [id])
    return (result.rowCount ?? 0) > 0
  }
  const result = await query<{ id: string }>(
    user,
    `WITH deleted AS (
       DELETE FROM challenge_participations WHERE id = $1
       RETURNING id, challenge_url
     ), tomb AS (
       INSERT INTO challenge_left (challenge_url)
       SELECT challenge_url FROM deleted
       ON CONFLICT (challenge_url) DO NOTHING
     )
     SELECT id FROM deleted`,
    [id],
  )
  return result.rows.length > 0
}

/** Challenge URLs the user has left — discovery's "don't suggest this again" set. */
export const listLeftChallengeUrls = async (user: string): Promise<string[]> => {
  const result = await query<{ challenge_url: string }>(user, `SELECT challenge_url FROM challenge_left`)
  return result.rows.map((row) => row.challenge_url)
}
