import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration tests for the shared feed service: resolving a stored feed post's
 * activity to its *merged span* (the window the detail view + share dialog show),
 * and serialising an enriched feed post. Backed by a real DB so the merge
 * (`resolveActivityWindow` → `getOverlappingActivities`) actually runs.
 */
import { deleteActivity, insertActivity } from '../db/activities/index.ts'
import { query } from '../db/connection.ts'
import { createFeedPost, type FeedPostInput } from '../db/feed.ts'
import { insertLocations } from '../db/locations.ts'
import { insertTimeSeries } from '../db/time-series.ts'
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import { resolveStructuredContent } from './feed-structured.ts'
import { expandFeedActivityWindow, getFeedPage, resolveFeedActivity, serializeFeedPost } from './feed.ts'

const CONTAINER_TIMEOUT = 120_000

// Two overlapping same-type activities merge into one 08:00–09:00 span; the
// anchor's own window is only 08:00–08:40.
const ANCHOR_START = new Date('2026-07-01T08:00:00Z')
const ANCHOR_END = new Date('2026-07-01T08:40:00Z')
const OTHER_START = new Date('2026-07-01T08:20:00Z')
const MERGED_END = new Date('2026-07-01T09:00:00Z')

const insertAnchor = (user: string): Promise<string> =>
  insertActivity(user, {
    activity_type: 'exercise',
    end_time: ANCHOR_END,
    source: 'garmin',
    start_time: ANCHOR_START,
    title: 'Merged run',
  })

const insertOverlap = (user: string): Promise<string> =>
  insertActivity(user, {
    activity_type: 'exercise',
    end_time: MERGED_END,
    source: 'strava',
    start_time: OTHER_START,
    title: 'Second half',
  })

const postInput = (activityId: string | null, overrides: Partial<FeedPostInput> = {}): FeedPostInput => ({
  activity_id: activityId,
  include_chart: false,
  include_map: false,
  included_metrics: ['duration'],
  series_metrics: [],
  visibility: 'public',
  ...overrides,
})

describe('feed service', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  describe('resolveFeedActivity', () => {
    test('expands a merged anchor to the full merged span (#881)', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      await insertOverlap(user)

      const resolved = await resolveFeedActivity(user, anchorId)
      expect(resolved?.start_time.toISOString()).toBe(ANCHOR_START.toISOString())
      expect(resolved?.end_time?.toISOString()).toBe(MERGED_END.toISOString())
      expect(resolved?.title).toBe('Merged run')
      expect(resolved?.activity_type).toBe('exercise')
    })

    test('passes a lone (non-overlapping) activity through with its own window', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user) // no overlapping activity

      const resolved = await resolveFeedActivity(user, anchorId)
      expect(resolved?.start_time.toISOString()).toBe(ANCHOR_START.toISOString())
      expect(resolved?.end_time?.toISOString()).toBe(ANCHOR_END.toISOString())
    })

    test('returns null for a missing/deleted activity', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      await deleteActivity(user, anchorId)
      expect(await resolveFeedActivity(user, anchorId)).toBeNull()
      expect(await resolveFeedActivity(user, '00000000-0000-0000-0000-000000000000')).toBeNull()
    })
  })

  describe('expandFeedActivityWindow', () => {
    test('expands an in-hand activity to its merged span', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      await insertOverlap(user)

      // Simulate the share path (activity already loaded for its 404 check).
      const anchor = {
        activity_type: 'exercise' as const,
        end_time: ANCHOR_END,
        id: anchorId,
        source: 'garmin' as const,
        start_time: ANCHOR_START,
        title: 'Merged run',
      }
      const resolved = await expandFeedActivityWindow(user, anchor)
      expect(resolved.end_time?.toISOString()).toBe(MERGED_END.toISOString())
    })
  })

  describe('serializeFeedPost', () => {
    test('enriches a post with the activity title, type, and merged window (#891)', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      await insertOverlap(user)
      const post = await createFeedPost(user, postInput(anchorId))

      const dto = await serializeFeedPost(user, post)
      expect(dto.activity_id).toBe(anchorId)
      expect(dto.activity_title).toBe('Merged run')
      expect(dto.activity_type).toBe('exercise')
      expect(dto.activity_start_time).toBe(ANCHOR_START.toISOString())
      expect(dto.activity_end_time).toBe(MERGED_END.toISOString())
      // Rendered `content` HTML (as federated) with the title headline (#884 §1).
      expect(dto.content).toContain('<strong>Merged run</strong>')
      // The activity-date line is part of the federated content (#998).
      expect(dto.content).toMatch(/<p>\w{3}, \d+ \w{3} \d{4}/)
      // Typed resolved scalars back the web's native stat grid (#997).
      expect(dto.metrics).toEqual([expect.objectContaining({ key: 'duration', value: expect.any(Number) })])
      // Base fields still present.
      expect(dto.included_metrics).toEqual(['duration'])
      expect(dto.visibility).toBe('public')
    })

    test('carries the personal message into the DTO and the federated content (#995)', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      const post = await createFeedPost(user, {
        ...postInput(anchorId),
        message: 'So wonderful\nsense of freedom!',
      })

      const dto = await serializeFeedPost(user, post)
      expect(dto.message).toBe('So wonderful\nsense of freedom!')
      expect(dto.content).toContain('<p>So wonderful<br>sense of freedom!</p>')
    })

    test('includeStructured attaches the peer-identical structured payload (#1008)', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      const post = await createFeedPost(user, { ...postInput(anchorId), message: 'Native!' })

      // Default: no structured payload (public profile / MCP weight).
      const plain = await serializeFeedPost(user, post)
      expect(plain.structured).toBeUndefined()

      const dto = await serializeFeedPost(user, post, { includeStructured: true })
      expect(dto.structured?.kind).toBe('activity')
      if (dto.structured?.kind !== 'activity') throw new Error('expected an activity payload')
      expect(dto.structured.activity_type).toBe('exercise')
      expect(dto.structured.message).toBe('Native!')
      expect(dto.structured.start_time).toBe(ANCHOR_START.toISOString())
      // Same typed scalars as the flat `metrics` field — one resolution feeds both.
      expect(dto.structured.metrics).toEqual(dto.metrics)
      // No series opted in → empty, never undefined.
      expect(dto.structured.series).toEqual([])
    })

    test('structured payload matches the public structured endpoint exactly, series and route included (#1001 parity)', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      // Real data behind both the opted-in series and the route (#1011).
      await insertTimeSeries(user, [
        { metric: 'heart_rate', source: 'garmin', time: new Date('2026-07-01T08:05:00Z'), value: 140 },
        { metric: 'heart_rate', source: 'garmin', time: new Date('2026-07-01T08:10:00Z'), value: 150 },
        { metric: 'heart_rate', source: 'garmin', time: new Date('2026-07-01T08:15:00Z'), value: 145 },
      ])
      await insertLocations(user, [
        { lat: 59.33, lon: 18.06, source: 'garmin', time: new Date('2026-07-01T08:05:00Z') },
        { lat: 59.34, lon: 18.07, source: 'garmin', time: new Date('2026-07-01T08:15:00Z') },
      ])
      const post = await createFeedPost(user, {
        ...postInput(anchorId, { include_map: true }),
        series_metrics: ['heart_rate'],
      })

      const dto = await serializeFeedPost(user, post, { includeStructured: true })
      if (dto.structured?.kind !== 'activity') throw new Error('expected an activity payload')
      // The opted-in series actually resolves (not just the empty-series case).
      expect(dto.structured.series).toEqual([
        expect.objectContaining({ metric: 'heart_rate', samples: expect.any(Array) }),
      ])
      expect(dto.structured.series[0]?.samples.length).toBeGreaterThan(0)
      // The route rides along under the include_map opt-in, endpoints intact (#1011).
      expect(dto.structured.route).toEqual([
        { lat: 59.33, lon: 18.06, t: '2026-07-01T08:05:00.000Z' },
        { lat: 59.34, lon: 18.07, t: '2026-07-01T08:15:00.000Z' },
      ])
      // The owner's payload IS the peer payload — same assembly, byte for byte.
      expect(dto.structured).toEqual(await resolveStructuredContent(user, post))
    })

    test('omits the route when the post does not attach the route map', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      await insertLocations(user, [
        { lat: 59.33, lon: 18.06, source: 'garmin', time: new Date('2026-07-01T08:05:00Z') },
        { lat: 59.34, lon: 18.07, source: 'garmin', time: new Date('2026-07-01T08:15:00Z') },
      ])
      const post = await createFeedPost(user, postInput(anchorId, { include_map: false }))

      const dto = await serializeFeedPost(user, post, { includeStructured: true })
      if (dto.structured?.kind !== 'activity') throw new Error('expected an activity payload')
      expect(dto.structured.route).toBeUndefined()
      expect(await resolveStructuredContent(user, post)).toEqual(dto.structured)
    })

    test('omits activity fields for a non-activity post', async () => {
      const user = getTestUser()
      const post = await createFeedPost(user, postInput(null))
      const dto = await serializeFeedPost(user, post)
      expect(dto.activity_id).toBeNull()
      expect(dto.activity_title).toBeUndefined()
      expect(dto.activity_start_time).toBeUndefined()
    })

    test('omits activity fields when the shared activity was deleted', async () => {
      const user = getTestUser()
      const anchorId = await insertAnchor(user)
      const post = await createFeedPost(user, postInput(anchorId))
      await deleteActivity(user, anchorId)

      const dto = await serializeFeedPost(user, post)
      expect(dto.activity_id).toBe(anchorId)
      expect(dto.activity_title).toBeUndefined()
      expect(dto.activity_start_time).toBeUndefined()
    })
  })

  describe('getFeedPage', () => {
    test('pages newest-first with an opaque cursor; null on the last page (#1012)', async () => {
      const user = getTestUser()
      const ids: string[] = []
      for (let i = 0; i < 3; i++) ids.push((await createFeedPost(user, postInput(null))).id)

      const page1 = await getFeedPage(user, 2, undefined)
      expect(page1.posts.map((p) => p.id)).toEqual([ids[2], ids[1]])
      expect(page1.next_cursor).not.toBeNull()

      const page2 = await getFeedPage(user, 2, page1.next_cursor ?? undefined)
      expect(page2.posts.map((p) => p.id)).toEqual([ids[0]])
      expect(page2.next_cursor).toBeNull()
    })

    test('an exactly-full page carries no cursor (nothing follows it)', async () => {
      const user = getTestUser()
      await createFeedPost(user, postInput(null))
      await createFeedPost(user, postInput(null))

      const page1 = await getFeedPage(user, 2, undefined)
      expect(page1.posts).toHaveLength(2)
      // 2 rows for limit 2: no extra row was fetched, so no next page.
      expect(page1.next_cursor).toBeNull()
    })

    test('walks past posts sharing a millisecond instead of dropping one (#1025)', async () => {
      const user = getTestUser()
      const a = await createFeedPost(user, postInput(null))
      const b = await createFeedPost(user, postInput(null))
      await query(user, 'UPDATE feed_posts SET created_at = $1::timestamptz WHERE id = $2', [
        '2026-08-20 09:00:00.500700+00',
        a.id,
      ])
      await query(user, 'UPDATE feed_posts SET created_at = $1::timestamptz WHERE id = $2', [
        '2026-08-20 09:00:00.500200+00',
        b.id,
      ])

      const page1 = await getFeedPage(user, 1, undefined)
      expect(page1.posts.map((p) => p.id)).toEqual([a.id])
      const page2 = await getFeedPage(user, 1, page1.next_cursor ?? undefined)
      // With a ms-truncated cursor `b` fell into the gap and no page ever showed it.
      expect(page2.posts.map((p) => p.id)).toEqual([b.id])
    })

    test('a malformed cursor falls back to the first page (never a 500)', async () => {
      const user = getTestUser()
      const post = await createFeedPost(user, postInput(null))
      const page = await getFeedPage(user, 10, 'garbage-cursor')
      expect(page.posts.map((p) => p.id)).toEqual([post.id])
    })
  })
})
