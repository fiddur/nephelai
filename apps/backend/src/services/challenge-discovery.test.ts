import type { PublicProfileResponse } from '@aurboda/api-spec'

import { AxiosError, AxiosHeaders } from 'axios'
import { describe, expect, test, vi } from 'vitest'

import type {
  ChallengeParticipationRecord,
  ChallengeRecord,
  ChallengeSpecFields,
  FeedFollowingRecord,
} from '../db/index.ts'

import {
  type ChallengeDiscoveryDeps,
  createApiBaseResolver,
  createChallengeDiscovery,
  isTransientFetchError,
  parseActorUri,
  sortDiscovered,
  toPublicChallengeListItem,
} from './challenge-discovery.ts'
import { specToApi } from './challenge-spec.ts'
import { SafeFetchError } from './safe-fetch.ts'

const WEB_HOST = 'https://home.example'
const NOW = new Date('2026-09-07T12:00:00Z')

const spec: ChallengeSpecFields = {
  activity_type_id: null,
  aggregation: 'sum',
  bucket_size: '1d',
  pattern: 'steps',
  source_type: 'metric',
  unit: 'steps',
}

const followee = (actorUri: string, overrides: Partial<FeedFollowingRecord> = {}): FeedFollowingRecord => ({
  accepted: true,
  actor_uri: actorUri,
  avatar_url: null,
  created_at: NOW,
  display_name: null,
  handle: null,
  id: `f-${actorUri}`,
  inbox_uri: `${actorUri}/inbox`,
  notify_on_post: true,
  shared_inbox_uri: null,
  ...overrides,
})

const record = (slug: string, overrides: Partial<ChallengeRecord> = {}): ChallengeRecord => ({
  announce_winner: true,
  created_at: NOW,
  end_ts: new Date('2026-09-30T22:00:00Z'),
  id: `c-${slug}`,
  is_public: true,
  join_token: 'jt',
  name: `Challenge ${slug}`,
  result_published_at: null,
  slug,
  spec,
  start_ts: new Date('2026-08-31T22:00:00Z'),
  timezone: 'Europe/Stockholm',
  updated_at: NOW,
  ...overrides,
})

const participation = (
  url: string,
  status: 'active' | 'withdrawn' = 'active',
): ChallengeParticipationRecord => ({
  challenge_url: url,
  created_at: NOW,
  data_token: 'dt',
  end_ts: new Date('2026-09-30T22:00:00Z'),
  host_identity: 'https://peer.example/u/alice',
  id: `p-${url}`,
  name: 'joined',
  spec,
  start_ts: new Date('2026-08-31T22:00:00Z'),
  status,
  timezone: 'Europe/Stockholm',
})

/** A peer's profile listing, in the shape the public route serves. */
const profile = (username: string, base: string, records: ChallengeRecord[]): PublicProfileResponse => ({
  challenges: records.map((r) => toPublicChallengeListItem(r, base, username)),
  dashboards: [],
  profile_url: `${base}/u/${username}`,
  success: true,
  username,
})

const deps = (overrides: Partial<ChallengeDiscoveryDeps> = {}): ChallengeDiscoveryDeps => ({
  fetchPeerProfile: async () => ({ challenges: [], success: true }),
  listFollowing: async () => [],
  listHosted: async () => [],
  listLeft: async () => [],
  listLocalPublic: async () => [],
  listParticipations: async () => [],
  now: () => NOW,
  resolveApiBase: async (base) => `${base}/api`,
  webHost: WEB_HOST,
  ...overrides,
})

describe('parseActorUri', () => {
  test('splits the Aurboda actor id shape, base sub-path and encoding included', () => {
    expect(parseActorUri('https://peer.example/users/alice')).toEqual({
      base: 'https://peer.example',
      username: 'alice',
    })
    expect(parseActorUri('https://peer.example/aurboda/users/alice/')).toEqual({
      base: 'https://peer.example/aurboda',
      username: 'alice',
    })
    expect(parseActorUri('https://peer.example/users/a%20b')).toEqual({
      base: 'https://peer.example',
      username: 'a b',
    })
  })

  test('rejects other shapes', () => {
    expect(parseActorUri('https://mastodon.example/@alice')).toBeNull()
    expect(parseActorUri('https://peer.example/users/alice/followers')).toBeNull()
    expect(parseActorUri('https://peer.example/users/')).toBeNull()
    expect(parseActorUri('/users/alice')).toBeNull()
    expect(parseActorUri('https://peer.example/users/%E0%A4%A')).toBeNull()
  })
})

describe('isTransientFetchError', () => {
  const axiosStatus = (status: number): AxiosError => {
    const error = new AxiosError('request failed')
    error.response = {
      config: { headers: new AxiosHeaders() },
      data: null,
      headers: {},
      status,
      statusText: 'x',
    }
    return error
  }

  test('no answer, a server error, a throttle or a blanket 403 are transient', () => {
    expect(isTransientFetchError(new AxiosError('no response'))).toBe(true)
    expect(isTransientFetchError(axiosStatus(500))).toBe(true)
    expect(isTransientFetchError(axiosStatus(503))).toBe(true)
    expect(isTransientFetchError(axiosStatus(429))).toBe(true)
    expect(isTransientFetchError(axiosStatus(403))).toBe(true)
  })

  test('a DNS failure is transient, a refused private address is not', () => {
    expect(isTransientFetchError(new SafeFetchError('Host did not resolve', 'dns'))).toBe(true)
    expect(isTransientFetchError(new SafeFetchError('Refusing to fetch a private…', 'private_address'))).toBe(
      false,
    )
    expect(isTransientFetchError(new SafeFetchError('Invalid URL', 'invalid_url'))).toBe(false)
    expect(
      isTransientFetchError(new SafeFetchError('Only http(s) URLs are allowed', 'unsupported_scheme')),
    ).toBe(false)
  })

  test('node network errors and timeouts are transient, other errors are not', () => {
    for (const code of [
      'ENOTFOUND',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ETIMEDOUT',
    ]) {
      expect(isTransientFetchError(Object.assign(new Error('boom'), { code })), code).toBe(true)
    }
    expect(isTransientFetchError(Object.assign(new Error('nope'), { code: 'EPERM' }))).toBe(false)
    expect(isTransientFetchError(new Error('Peer timed out'))).toBe(true)
    expect(isTransientFetchError(new Error('timeout of 4000ms exceeded'))).toBe(true)
    expect(isTransientFetchError(new Error('Host does not support Aurboda federation'))).toBe(false)
    expect(isTransientFetchError(axiosStatus(404))).toBe(false)
    expect(isTransientFetchError(axiosStatus(418))).toBe(false)
  })
})

describe('createApiBaseResolver', () => {
  test('remembers both an Aurboda answer and a definite no until the TTL passes', async () => {
    const probe = vi.fn(async (base: string) =>
      base.includes('aurboda')
        ? { api_base: `${base}/api/`, kind: 'aurboda' as const }
        : { kind: 'not_aurboda' as const },
    )
    let clock = 0
    const resolve = createApiBaseResolver(probe, 1000, () => clock)

    expect(await resolve('https://aurboda.example')).toBe('https://aurboda.example/api')
    expect(await resolve('https://aurboda.example')).toBe('https://aurboda.example/api')
    expect(await resolve('https://mastodon.example')).toBeNull()
    expect(await resolve('https://mastodon.example')).toBeNull()
    expect(probe).toHaveBeenCalledTimes(2)

    clock = 1001
    await resolve('https://mastodon.example')
    expect(probe).toHaveBeenCalledTimes(3)
  })

  test('concurrent callers for one instance share a single in-flight probe', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(async (base: string) => {
      await gate
      return { api_base: `${base}/api`, kind: 'aurboda' as const }
    })
    const resolve = createApiBaseResolver(probe, 1000, () => 0)

    const both = Promise.all([resolve('https://p.example'), resolve('https://p.example')])
    release()
    expect(await both).toEqual(['https://p.example/api', 'https://p.example/api'])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('a rejected in-flight probe is dropped, so the next call retries', async () => {
    const probe = vi
      .fn<(base: string) => Promise<{ kind: 'aurboda'; api_base: string }>>()
      .mockRejectedValueOnce(new Error('EAI_AGAIN'))
      .mockResolvedValueOnce({ api_base: 'https://p.example/api', kind: 'aurboda' })
    const resolve = createApiBaseResolver(probe, 1000, () => 0)

    const first = resolve('https://p.example')
    const second = resolve('https://p.example')
    await expect(first).rejects.toThrow('EAI_AGAIN')
    await expect(second).rejects.toThrow('EAI_AGAIN')
    expect(probe).toHaveBeenCalledTimes(1)

    expect(await resolve('https://p.example')).toBe('https://p.example/api')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  test('a transient failure is rethrown and not remembered', async () => {
    const probe = vi
      .fn<(base: string) => Promise<{ kind: 'aurboda'; api_base: string }>>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ api_base: 'https://p.example/api', kind: 'aurboda' })
    const resolve = createApiBaseResolver(probe, 1000, () => 0)
    await expect(resolve('https://p.example')).rejects.toThrow('ECONNRESET')
    expect(await resolve('https://p.example')).toBe('https://p.example/api')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('createChallengeDiscovery', () => {
  test('lists a local followee in-process and a remote Aurboda peer over its API base', async () => {
    const fetchPeerProfile = vi.fn(async (apiBase: string, username: string) =>
      profile(username, apiBase.replace(/\/api$/, ''), [record('remote-open')]),
    )
    const listLocalPublic = vi.fn(async (username: string) =>
      username === 'bob' ? [record('bob-open')] : [],
    )
    const discover = createChallengeDiscovery(
      deps({
        fetchPeerProfile,
        listFollowing: async () => [
          followee(`${WEB_HOST}/users/bob`, { display_name: 'Bob', handle: '@bob@home.example' }),
          followee('https://peer.example/users/alice', { handle: '@alice@peer.example' }),
        ],
        listLocalPublic,
      }),
    )

    const result = await discover('me')

    expect(fetchPeerProfile).toHaveBeenCalledWith('https://peer.example/api', 'alice')
    expect(listLocalPublic).toHaveBeenCalledWith('bob')
    expect(result.peers_unreachable).toBe(0)
    expect(
      result.challenges.map((c) => [c.name, c.host_handle, c.host_identity, c.share_url, c.status]),
    ).toEqual([
      [
        'Challenge bob-open',
        '@bob@home.example',
        `${WEB_HOST}/u/bob`,
        `${WEB_HOST}/u/bob/bob-open`,
        'ongoing',
      ],
      [
        'Challenge remote-open',
        '@alice@peer.example',
        'https://peer.example/u/alice',
        'https://peer.example/u/alice/remote-open',
        'ongoing',
      ],
    ])
    expect(result.challenges[0].host_display_name).toBe('Bob')
    expect(result.challenges[0].spec).toEqual({ ...spec, activity_type_id: undefined, pattern: 'steps' })
  })

  test('skips non-Aurboda followees without asking for a profile, and counts peers that fail', async () => {
    const fetchPeerProfile = vi.fn(async () => {
      throw new Error('timeout')
    })
    const discover = createChallengeDiscovery(
      deps({
        fetchPeerProfile,
        listFollowing: async () => [
          followee('https://mastodon.example/users/carol'),
          followee('https://mastodon.example/@dave'),
          followee('https://down.example/users/erin'),
        ],
        resolveApiBase: async (base) => (base === 'https://down.example' ? `${base}/api` : null),
      }),
    )

    const result = await discover('me')

    expect(fetchPeerProfile).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ challenges: [], peers_unreachable: 1 })
  })

  test('a peer whose well-known probe fails transiently counts as unreachable', async () => {
    const discover = createChallengeDiscovery(
      deps({
        listFollowing: async () => [followee('https://flaky.example/users/erin')],
        resolveApiBase: async () => {
          throw new Error('ECONNRESET')
        },
      }),
    )
    expect(await discover('me')).toEqual({ challenges: [], peers_unreachable: 1 })
  })

  test('counts unreachable instances, not followees, when several live on one dead host', async () => {
    const discover = createChallengeDiscovery(
      deps({
        listFollowing: async () => [
          followee('https://down.example/users/alice'),
          followee('https://down.example/users/bob'),
          followee('https://down.example/users/carol'),
          followee('https://other-down.example/users/dave'),
        ],
        resolveApiBase: async () => {
          throw new Error('EHOSTUNREACH')
        },
      }),
    )
    expect(await discover('me')).toEqual({ challenges: [], peers_unreachable: 2 })
  })

  test('never suggests a challenge the user left, until they join it again', async () => {
    const base = 'https://peer.example'
    const discoverWith = (leftUrls: string[]) =>
      createChallengeDiscovery(
        deps({
          fetchPeerProfile: async () => profile('alice', base, [record('walked-away'), record('open')]),
          listFollowing: async () => [followee(`${base}/users/alice`)],
          listLeft: async () => leftUrls,
        }),
      )

    expect((await discoverWith([`${base}/u/alice/walked-away`])('me')).challenges.map((c) => c.name)).toEqual(
      ['Challenge open'],
    )
    // Rejoining clears the tombstone; the challenge is then excluded as joined, not as left.
    expect((await discoverWith([])('me')).challenges.map((c) => c.name)).toEqual([
      'Challenge walked-away',
      'Challenge open',
    ])
  })

  test('matches joined and left challenges canonically, whatever the link looked like', async () => {
    const base = 'https://peer.example'
    const discover = createChallengeDiscovery(
      deps({
        fetchPeerProfile: async () =>
          profile('alice', base, [record('joined'), record('left'), record('open')]),
        listFollowing: async () => [followee(`${base}/users/alice`)],
        listLeft: async () => [`https://PEER.example/u/alice/left#top`],
        listParticipations: async () => [participation(`${base}/u/alice/joined?embed=1`)],
      }),
    )
    expect((await discover('me')).challenges.map((c) => c.name)).toEqual(['Challenge open'])
  })

  test('leaves out what the user hosts, joined or left, what has ended, and what a peer lists without a window', async () => {
    const base = 'https://peer.example'
    const ended = record('ended', {
      end_ts: new Date('2026-09-01T22:00:00Z'),
      start_ts: new Date('2026-08-01T22:00:00Z'),
    })
    const discover = createChallengeDiscovery(
      deps({
        fetchPeerProfile: async () => ({
          challenges: [
            ...profile('alice', base, [record('joined'), record('left'), record('open'), ended]).challenges!,
            { name: 'old peer', share_url: `${base}/u/alice/no-window`, slug: 'no-window' },
          ],
          success: true,
        }),
        listFollowing: async () => [followee(`${base}/users/alice`), followee(`${WEB_HOST}/users/me`)],
        listHosted: async () => [record('mine')],
        listLocalPublic: async () => [record('mine')],
        listParticipations: async () => [
          participation(`${base}/u/alice/joined`),
          participation(`${base}/u/alice/left/`, 'withdrawn'),
        ],
      }),
    )

    const result = await discover('me')
    expect(result.challenges.map((c) => c.name)).toEqual(['Challenge open'])
  })

  test("rejects a listed link that points outside the host's own space on their instance", async () => {
    const base = 'https://peer.example'
    const discover = createChallengeDiscovery(
      deps({
        fetchPeerProfile: async () => ({
          challenges: [
            { ...toPublicChallengeListItem(record('planted'), 'https://evil.example', 'alice') },
            { ...toPublicChallengeListItem(record('other-user'), base, 'mallory') },
            { ...toPublicChallengeListItem(record('fine'), base, 'alice') },
          ],
          success: true,
        }),
        listFollowing: async () => [followee(`${base}/users/alice`)],
      }),
    )
    expect((await discover('me')).challenges.map((c) => c.share_url)).toEqual([`${base}/u/alice/fine`])
  })

  test('a followee on this instance without a database is not an error', async () => {
    const discover = createChallengeDiscovery(
      deps({
        listFollowing: async () => [followee(`${WEB_HOST}/users/ghost`)],
        listLocalPublic: async () => {
          throw Object.assign(new Error('database "aurboda_ghost" does not exist'), { code: '3D000' })
        },
      }),
    )
    expect(await discover('me')).toEqual({ challenges: [], peers_unreachable: 0 })
  })

  test('orders ongoing by end, then upcoming by start', async () => {
    const base = 'https://peer.example'
    const discover = createChallengeDiscovery(
      deps({
        fetchPeerProfile: async () =>
          profile('alice', base, [
            record('starts-later', {
              end_ts: new Date('2026-11-30T23:00:00Z'),
              start_ts: new Date('2026-10-31T23:00:00Z'),
            }),
            record('ends-later', { end_ts: new Date('2026-10-31T23:00:00Z') }),
            record('starts-soon', {
              end_ts: new Date('2026-10-31T23:00:00Z'),
              start_ts: new Date('2026-09-30T22:00:00Z'),
            }),
            record('ends-soon', { end_ts: new Date('2026-09-13T22:00:00Z') }),
          ]),
        listFollowing: async () => [followee(`${base}/users/alice`)],
      }),
    )
    const result = await discover('me')
    expect(result.challenges.map((c) => [c.name, c.status])).toEqual([
      ['Challenge ends-soon', 'ongoing'],
      ['Challenge ends-later', 'ongoing'],
      ['Challenge starts-soon', 'upcoming'],
      ['Challenge starts-later', 'upcoming'],
    ])
  })

  test('sortDiscovered is stable for equal keys', () => {
    const a = {
      end_ts: '2026-10-01T00:00:00Z',
      name: 'a',
      start_ts: '2026-09-01T00:00:00Z',
      status: 'ongoing' as const,
    }
    const b = { ...a, name: 'b' }
    const list = [a, b].map((c) => ({
      ...c,
      host_actor_uri: '',
      host_display_name: null,
      host_handle: null,
      host_identity: '',
      share_url: '',
      spec: specToApi(spec),
      timezone: 'UTC',
    }))
    expect(sortDiscovered(list).map((c) => c.name)).toEqual(['a', 'b'])
  })
})
