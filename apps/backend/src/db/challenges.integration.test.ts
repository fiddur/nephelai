import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration tests for challenges CRUD, members, and participations.
 */
import type { ChallengeSpecFields } from './challenges.ts'

import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import {
  createChallenge,
  createChallengeParticipation,
  deleteChallenge,
  deleteChallengeParticipation,
  getChallengeById,
  getChallengeBySlug,
  getChallengeMemberByIdentity,
  getParticipationByToken,
  getParticipationByUrl,
  listChallengeMembers,
  listChallengeParticipations,
  listChallenges,
  listChallengesAwaitingResult,
  listLeftChallengeUrls,
  listPublicChallenges,
  markChallengeResultPublished,
  removeChallengeMember,
  updateChallenge,
  updateChallengeMemberCache,
  upsertChallengeMember,
} from './challenges.ts'
import { createSharedDashboard } from './shared-dashboards.ts'

const CONTAINER_TIMEOUT = 120_000

const spec: ChallengeSpecFields = {
  activity_type_id: null,
  aggregation: 'sum',
  bucket_size: '1d',
  pattern: 'steps',
  source_type: 'metric',
  unit: 'steps',
}

const sampleInput = (name: string, isPublic = false, announceWinner = true) => ({
  announce_winner: announceWinner,
  end_ts: new Date('2026-06-08T00:00:00Z'),
  is_public: isPublic,
  name,
  spec,
  start_ts: new Date('2026-06-01T00:00:00Z'),
  timezone: 'Europe/Stockholm',
})

describe('Challenges integration', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('creates with a slug + join_token and round-trips by slug', async () => {
    const user = getTestUser()
    const created = await createChallenge(user, sampleInput('Step war'))

    expect(created.slug).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(created.join_token).toBeTruthy()
    expect(created.spec).toEqual(spec)
    expect(created.start_ts.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(created.announce_winner).toBe(true)
    expect(created.result_published_at).toBeNull()

    const bySlug = await getChallengeBySlug(user, created.slug)
    expect(bySlug?.id).toBe(created.id)
    expect(await getChallengeBySlug(user, 'nope')).toBeNull()
  })

  test('slug does not collide with a shared dashboard slug', async () => {
    const user = getTestUser()
    const dash = await createSharedDashboard(user, {
      config: { sections: [], version: 1 },
      is_public: false,
      name: 'D',
    })
    // Create several challenges; none should ever reuse the dashboard's slug.
    const slugs = new Set<string>([dash.slug])
    for (let i = 0; i < 5; i++) {
      const c = await createChallenge(user, sampleInput(`C${i}`))
      expect(slugs.has(c.slug)).toBe(false)
      slugs.add(c.slug)
    }
  })

  test('lists all and public-only', async () => {
    const user = getTestUser()
    await createChallenge(user, sampleInput('pub', true))
    await createChallenge(user, sampleInput('priv', false))
    expect((await listChallenges(user)).length).toBe(2)
    const pub = await listPublicChallenges(user)
    expect(pub.map((c) => c.name)).toEqual(['pub'])
  })

  test('updates spec + visibility, deletes', async () => {
    const user = getTestUser()
    const c = await createChallenge(user, sampleInput('x'))
    const updated = await updateChallenge(user, c.id, {
      is_public: true,
      spec: {
        ...spec,
        aggregation: 'count',
        unit: 'sessions',
        pattern: 'exercise',
        source_type: 'activity_type',
      },
    })
    expect(updated?.slug).toBe(c.slug)
    expect(updated?.is_public).toBe(true)
    expect(updated?.spec.aggregation).toBe('count')
    expect(updated?.spec.source_type).toBe('activity_type')

    expect(await deleteChallenge(user, c.id)).toBe(true)
    expect(await getChallengeBySlug(user, c.slug)).toBeNull()
  })

  test('upserts members (idempotent by identity), caches data, removes', async () => {
    const user = getTestUser()
    const c = await createChallenge(user, sampleInput('m'))

    const m1 = await upsertChallengeMember(user, c.id, {
      display_name: 'alice',
      identity_base_url: 'https://aurboda.net/u/alice',
      kind: 'local',
      local_user: 'alice',
    })
    // Re-join with a new display name updates the same row.
    const m1b = await upsertChallengeMember(user, c.id, {
      display_name: 'Alice A.',
      identity_base_url: 'https://aurboda.net/u/alice',
      kind: 'local',
      local_user: 'alice',
    })
    expect(m1b.id).toBe(m1.id)

    await upsertChallengeMember(user, c.id, {
      data_endpoint_url: 'https://foo.bar/challenge-data/tok',
      display_name: 'bob',
      identity_base_url: 'https://foo.bar/u/bob',
      kind: 'remote',
    })

    let members = await listChallengeMembers(user, c.id)
    expect(members.length).toBe(2)
    expect(members.find((m) => m.identity_base_url.includes('alice'))?.display_name).toBe('Alice A.')

    const reportedUpdate = new Date('2026-06-02T09:30:00.000Z')
    await updateChallengeMemberCache(user, m1.id, {
      buckets: [{ bucket_start: '2026-06-01T00:00:00.000Z', value: 1000 }],
      dataLastUpdated: reportedUpdate,
      error: null,
      total: 1000,
    })
    members = await listChallengeMembers(user, c.id)
    const cached = members.find((m) => m.id === m1.id)
    expect(cached?.cached_total).toBe(1000)
    expect(cached?.cached_buckets).toEqual([{ bucket_start: '2026-06-01T00:00:00.000Z', value: 1000 }])
    expect(cached?.last_fetched_at).not.toBeNull()
    // data_last_updated is the member-reported data time, independent of the fetch time.
    expect(cached?.data_last_updated?.toISOString()).toBe(reportedUpdate.toISOString())

    expect(await removeChallengeMember(user, c.id, m1.id)).toBe(true)
    expect((await listChallengeMembers(user, c.id)).length).toBe(1)
  })

  test('cascade deletes members with the challenge', async () => {
    const user = getTestUser()
    const c = await createChallenge(user, sampleInput('casc'))
    await upsertChallengeMember(user, c.id, {
      display_name: 'a',
      identity_base_url: 'https://x/u/a',
      kind: 'local',
      local_user: 'a',
    })
    await deleteChallenge(user, c.id)
    expect((await listChallengeMembers(user, c.id)).length).toBe(0)
  })

  test('gets a challenge by id and reports missing ones', async () => {
    const user = getTestUser()
    const c = await createChallenge(user, sampleInput('byid'))
    expect((await getChallengeById(user, c.id))?.slug).toBe(c.slug)
    expect(await getChallengeById(user, '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  test('finds a member by identity (for the register-back hijack guard)', async () => {
    const user = getTestUser()
    const c = await createChallenge(user, sampleInput('byidentity'))
    await upsertChallengeMember(user, c.id, {
      display_name: 'alice',
      identity_base_url: 'https://aurboda.net/u/alice',
      kind: 'local',
      local_user: 'alice',
    })
    const found = await getChallengeMemberByIdentity(user, c.id, 'https://aurboda.net/u/alice')
    expect(found?.kind).toBe('local')
    expect(await getChallengeMemberByIdentity(user, c.id, 'https://other/u/x')).toBeNull()
  })

  test('looks up + deletes a participation by url (join idempotency support)', async () => {
    const user = getTestUser()
    const url = 'https://aurboda.net/u/alice/byurl1'
    const p = await createChallengeParticipation(user, {
      challenge_url: url,
      end_ts: new Date('2026-06-08T00:00:00Z'),
      host_identity: 'https://aurboda.net/u/alice',
      name: 'C',
      spec,
      start_ts: new Date('2026-06-01T00:00:00Z'),
      timezone: 'UTC',
    })
    expect((await getParticipationByUrl(user, url))?.id).toBe(p.id)
    expect(await getParticipationByUrl(user, 'https://aurboda.net/u/alice/nope')).toBeNull()

    expect(await deleteChallengeParticipation(user, p.id)).toBe(true)
    expect(await getParticipationByUrl(user, url)).toBeNull()
    expect(await deleteChallengeParticipation(user, p.id)).toBe(false)
  })

  test('leaving tombstones the challenge url; rejoining clears it, leaving again re-records it', async () => {
    const user = getTestUser()
    const url = 'https://aurboda.net/u/alice/left-and-back'
    const join = async () =>
      createChallengeParticipation(user, {
        challenge_url: url,
        end_ts: new Date('2026-06-08T00:00:00Z'),
        host_identity: 'https://aurboda.net/u/alice',
        name: 'C',
        spec,
        start_ts: new Date('2026-06-01T00:00:00Z'),
        timezone: 'UTC',
      })

    const first = await join()
    expect(await listLeftChallengeUrls(user)).toEqual([])

    expect(await deleteChallengeParticipation(user, first.id)).toBe(true)
    expect(await listLeftChallengeUrls(user)).toEqual([url])

    const second = await join()
    expect(await listLeftChallengeUrls(user)).toEqual([])

    expect(await deleteChallengeParticipation(user, second.id)).toBe(true)
    expect(await listLeftChallengeUrls(user)).toEqual([url])
  })

  test('a rolled-back join (tombstone: false) leaves the challenge discoverable', async () => {
    const user = getTestUser()
    const p = await createChallengeParticipation(user, {
      challenge_url: 'https://aurboda.net/u/alice/rejected-join',
      end_ts: new Date('2026-06-08T00:00:00Z'),
      host_identity: 'https://aurboda.net/u/alice',
      name: 'C',
      spec,
      start_ts: new Date('2026-06-01T00:00:00Z'),
      timezone: 'UTC',
    })
    expect(await deleteChallengeParticipation(user, p.id, { tombstone: false })).toBe(true)
    expect(await listLeftChallengeUrls(user)).toEqual([])
    expect(await deleteChallengeParticipation(user, p.id, { tombstone: false })).toBe(false)
  })

  test('creates a participation with a data token and looks it up', async () => {
    const user = getTestUser()
    const p = await createChallengeParticipation(user, {
      challenge_url: 'https://aurboda.net/u/alice/abc123',
      end_ts: new Date('2026-06-08T00:00:00Z'),
      host_identity: 'https://aurboda.net/u/alice',
      name: 'Step war',
      spec,
      start_ts: new Date('2026-06-01T00:00:00Z'),
      timezone: 'Europe/Stockholm',
    })

    expect(p.data_token).toBeTruthy()
    expect((await listChallengeParticipations(user)).length).toBe(1)
    const byToken = await getParticipationByToken(user, p.data_token)
    expect(byToken?.id).toBe(p.id)
    expect(byToken?.spec).toEqual(spec)
    expect(await getParticipationByToken(user, 'missing')).toBeNull()
  })

  test('announce_winner is stored, patchable, and drives the pending-result list', async () => {
    const user = getTestUser()
    const quiet = await createChallenge(user, sampleInput('quiet', false, false))
    expect(quiet.announce_winner).toBe(false)
    const loud = await createChallenge(user, sampleInput('loud'))

    // Both ended (2026-06-08) inside the window; only the announcing one is listed.
    const window = {
      endedAfter: new Date('2026-06-05T00:00:00Z'),
      endedBefore: new Date('2026-06-09T00:00:00Z'),
    }
    expect((await listChallengesAwaitingResult(user, window)).map((c) => c.id)).toEqual([loud.id])
    // Neither has ended before an earlier upper bound.
    expect(
      await listChallengesAwaitingResult(user, { ...window, endedBefore: new Date('2026-06-07T00:00:00Z') }),
    ).toEqual([])
    // Ended too long ago (before the lower bound): never announced retroactively.
    expect(
      await listChallengesAwaitingResult(user, { ...window, endedAfter: new Date('2026-06-08T00:00:00Z') }),
    ).toEqual([])

    const patched = await updateChallenge(user, quiet.id, { announce_winner: true })
    expect(patched?.announce_winner).toBe(true)
    expect((await listChallengesAwaitingResult(user, window)).map((c) => c.id).sort()).toEqual(
      [loud.id, quiet.id].sort(),
    )
  })

  test('markChallengeResultPublished claims once and drops the challenge from the pending list', async () => {
    const user = getTestUser()
    const c = await createChallenge(user, sampleInput('done'))
    const window = {
      endedAfter: new Date('2026-06-05T00:00:00Z'),
      endedBefore: new Date('2026-06-09T00:00:00Z'),
    }
    expect(await markChallengeResultPublished(user, c.id)).toBe(true)
    expect(await markChallengeResultPublished(user, c.id)).toBe(false)
    expect((await getChallengeById(user, c.id))?.result_published_at).toBeInstanceOf(Date)
    expect(await listChallengesAwaitingResult(user, window)).toEqual([])
  })
})
