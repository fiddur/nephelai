import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration tests for the two reaction stores: the user's OWN outbound
 * likes/boosts (`feed_reaction`) and the inbound reactions on their own posts
 * (`feed_post_reaction`).
 */
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import {
  countFeedPostReactions,
  getFeedReaction,
  insertFeedReaction,
  listFeedPostReactions,
  listFeedReactionsForObjects,
  removeFeedPostReaction,
  removeFeedPostReactionByActivity,
  removeFeedReaction,
  upsertFeedPostReaction,
} from './feed-reactions.ts'
import { createFeedPost, deleteFeedPost } from './feed.ts'

const CONTAINER_TIMEOUT = 120_000
const NOTE = 'https://mastodon.example/notes/1'
const ALICE = 'https://mastodon.example/users/alice'
const BOB = 'https://remote.example/users/bob'

const reaction = () => ({
  actor_uri: ALICE,
  inbox_uri: `${ALICE}/inbox`,
  kind: 'like' as const,
  object_uri: NOTE,
  shared_inbox_uri: 'https://mastodon.example/inbox',
})

const post = (user: string) =>
  createFeedPost(user, {
    activity_id: null,
    include_chart: false,
    include_map: false,
    included_metrics: [],
    series_metrics: [],
    visibility: 'public',
  })

describe('Feed reaction stores integration', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  describe('feed_reaction (the user’s own likes / boosts)', () => {
    test('stores a reaction with the cached author inbox and reports it as inserted', async () => {
      const user = getTestUser()
      const row = await insertFeedReaction(user, reaction())
      expect(row.inserted).toBe(true)
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(row.kind).toBe('like')
      expect(row.inbox_uri).toBe(`${ALICE}/inbox`)
      expect((await getFeedReaction(user, 'like', NOTE))?.id).toBe(row.id)
    })

    test('re-inserting the same (kind, object) returns the SAME row, not inserted', async () => {
      const user = getTestUser()
      const first = await insertFeedReaction(user, reaction())
      const second = await insertFeedReaction(user, reaction())
      // The stable id is what keeps the delivered activity id (and its #undo)
      // pointing at one activity — and `inserted: false` is what stops a second
      // delivery.
      expect(second.id).toBe(first.id)
      expect(second.inserted).toBe(false)
    })

    test('like and boost of the same post are independent rows', async () => {
      const user = getTestUser()
      await insertFeedReaction(user, reaction())
      await insertFeedReaction(user, { ...reaction(), kind: 'announce' })
      expect(await getFeedReaction(user, 'like', NOTE)).not.toBeNull()
      expect(await getFeedReaction(user, 'announce', NOTE)).not.toBeNull()
    })

    test('removing returns the row (with its inbox) so the Undo can still be addressed', async () => {
      const user = getTestUser()
      const inserted = await insertFeedReaction(user, reaction())
      const removed = await removeFeedReaction(user, 'like', NOTE)
      expect(removed?.id).toBe(inserted.id)
      expect(removed?.inbox_uri).toBe(`${ALICE}/inbox`)
      expect(await getFeedReaction(user, 'like', NOTE)).toBeNull()
      expect(await removeFeedReaction(user, 'like', NOTE)).toBeNull()
    })

    test('listFeedReactionsForObjects batches the timeline page’s lookup', async () => {
      const user = getTestUser()
      await insertFeedReaction(user, reaction())
      await insertFeedReaction(user, { ...reaction(), kind: 'announce', object_uri: `${NOTE}-other` })
      const rows = await listFeedReactionsForObjects(user, [NOTE, `${NOTE}-other`, `${NOTE}-none`])
      expect(rows).toHaveLength(2)
      expect(rows).toContainEqual({ kind: 'like', object_uri: NOTE })
      expect(rows).toContainEqual({ kind: 'announce', object_uri: `${NOTE}-other` })
      expect(await listFeedReactionsForObjects(user, [])).toEqual([])
    })
  })

  describe('feed_post_reaction (who reacted to the user’s posts)', () => {
    test('records a reaction with its presentation snapshot and lists it', async () => {
      const user = getTestUser()
      const created = await post(user)
      await upsertFeedPostReaction(user, {
        activity_uri: 'https://mastodon.example/users/alice#likes/3',
        actor_uri: ALICE,
        avatar_url: 'https://mastodon.example/avatars/alice.png',
        display_name: 'Alice',
        handle: '@alice@mastodon.example',
        kind: 'like',
        post_id: created.id,
      })
      const rows = await listFeedPostReactions(user, created.id, 100)
      expect(rows).toHaveLength(1)
      expect(rows[0].handle).toBe('@alice@mastodon.example')
      expect(rows[0].kind).toBe('like')
    })

    test('a redelivery refreshes the snapshot in place rather than duplicating', async () => {
      const user = getTestUser()
      const created = await post(user)
      await upsertFeedPostReaction(user, {
        actor_uri: ALICE,
        display_name: 'Alice',
        kind: 'like',
        post_id: created.id,
      })
      await upsertFeedPostReaction(user, {
        actor_uri: ALICE,
        display_name: 'Alice Cooper',
        kind: 'like',
        post_id: created.id,
      })
      const rows = await listFeedPostReactions(user, created.id, 100)
      expect(rows).toHaveLength(1)
      expect(rows[0].display_name).toBe('Alice Cooper')
    })

    test('removal is scoped to the reacting actor and to the kind', async () => {
      const user = getTestUser()
      const created = await post(user)
      await upsertFeedPostReaction(user, { actor_uri: ALICE, kind: 'like', post_id: created.id })
      await upsertFeedPostReaction(user, { actor_uri: BOB, kind: 'like', post_id: created.id })
      await upsertFeedPostReaction(user, { actor_uri: ALICE, kind: 'announce', post_id: created.id })

      expect(await removeFeedPostReaction(user, created.id, 'like', ALICE)).toBe(true)
      const rows = await listFeedPostReactions(user, created.id, 100)
      expect(rows.map((r) => `${r.kind}:${r.actor_uri}`).sort()).toEqual([`announce:${ALICE}`, `like:${BOB}`])
    })

    test('removal by the remote activity id (a bare-id Undo) is scoped to its actor', async () => {
      const user = getTestUser()
      const created = await post(user)
      const activityUri = 'https://mastodon.example/users/alice#likes/3'
      await upsertFeedPostReaction(user, {
        activity_uri: activityUri,
        actor_uri: ALICE,
        kind: 'like',
        post_id: created.id,
      })
      // Somebody else's Undo naming that id must not evict Alice's reaction.
      expect(await removeFeedPostReactionByActivity(user, activityUri, BOB)).toBe(false)
      expect(await removeFeedPostReactionByActivity(user, activityUri, ALICE)).toBe(true)
      expect(await listFeedPostReactions(user, created.id, 100)).toHaveLength(0)
    })

    test('countFeedPostReactions tallies a whole page by post + kind in one query', async () => {
      const user = getTestUser()
      const first = await post(user)
      const second = await post(user)
      await upsertFeedPostReaction(user, { actor_uri: ALICE, kind: 'like', post_id: first.id })
      await upsertFeedPostReaction(user, { actor_uri: BOB, kind: 'like', post_id: first.id })
      await upsertFeedPostReaction(user, { actor_uri: BOB, kind: 'announce', post_id: first.id })

      const counts = await countFeedPostReactions(user, [first.id, second.id])
      expect(counts).toContainEqual({ count: 2, kind: 'like', post_id: first.id })
      expect(counts).toContainEqual({ count: 1, kind: 'announce', post_id: first.id })
      // A post nobody reacted to is simply absent.
      expect(counts.filter((c) => c.post_id === second.id)).toEqual([])
      expect(await countFeedPostReactions(user, [])).toEqual([])
    })

    test('deleting a post drops its reactions in the same statement', async () => {
      const user = getTestUser()
      const created = await post(user)
      await upsertFeedPostReaction(user, { actor_uri: ALICE, kind: 'like', post_id: created.id })
      expect(await deleteFeedPost(user, created.id)).toBe(true)
      expect(await listFeedPostReactions(user, created.id, 100)).toHaveLength(0)
    })
  })
})
