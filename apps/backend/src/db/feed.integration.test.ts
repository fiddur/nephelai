import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration tests for feed-post CRUD and the series-authorization window
 * lookup that guards the public `/series` endpoint.
 */
import { cleanTestDb, getTestDbClient, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import { deleteActivity, insertActivity } from './activities/index.ts'
import {
  type ArticlePostInput,
  countPublicFeedPosts,
  createArticlePost,
  createChallengePost,
  createFeedPost,
  createReplyPost,
  deleteFeedPost,
  type FeedPostInput,
  findCoveringSharedSeriesWindow,
  getFeedPostById,
  getFeedTombstone,
  listFeedPosts,
  listPublicFeedPosts,
  listPublicFeedPostsKeyset,
  listPublicFeedPostsPage,
  listReplyPostsTo,
  type ReplyPostInput,
  updateFeedPost,
} from './feed.ts'

const CONTAINER_TIMEOUT = 120_000

const ACTIVITY_START = new Date('2026-07-01T06:30:00Z')
const ACTIVITY_END = new Date('2026-07-01T07:11:00Z')

const insertExercise = (user: string): Promise<string> =>
  insertActivity(user, {
    activity_type: 'exercise',
    end_time: ACTIVITY_END,
    source: 'garmin',
    start_time: ACTIVITY_START,
    title: 'Morning run',
  })

/** Pin a post's `created_at` to an exact µs-precision instant (the keyset key). */
const setCreatedAt = (id: string, ts: string): Promise<unknown> =>
  getTestDbClient().query('UPDATE feed_posts SET created_at = $1::timestamptz WHERE id = $2', [ts, id])

const postInput = (overrides: Partial<FeedPostInput> = {}): FeedPostInput => ({
  activity_id: null,
  include_chart: false,
  include_map: false,
  included_metrics: ['duration', 'distance', 'heart_rate_avg'],
  series_metrics: [],
  visibility: 'public',
  ...overrides,
})

const articleInput = (overrides: Partial<ArticlePostInput> = {}): ArticlePostInput => ({
  article: {
    blocks: [
      { markdown: '# Sleep vs HRV\n\nA look at the last week.', type: 'prose' },
      {
        bucket: '1h',
        caption: 'Resting HR over the week',
        end: '2026-07-07T00:00:00.000Z',
        metric: 'heart_rate',
        start: '2026-07-01T00:00:00.000Z',
        type: 'chart',
      },
    ],
    default_end: '2026-07-07T00:00:00.000Z',
    default_start: '2026-07-01T00:00:00.000Z',
    title: 'A week of sleep and HRV',
  },
  visibility: 'public',
  ...overrides,
})

describe('Feed posts integration', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('creates a post and round-trips by id', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const created = await createFeedPost(
      user,
      postInput({ activity_id: activityId, series_metrics: ['heart_rate'] }),
    )

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.activity_id).toBe(activityId)
    expect(created.included_metrics).toEqual(['duration', 'distance', 'heart_rate_avg'])
    expect(created.series_metrics).toEqual(['heart_rate'])
    expect(created.visibility).toBe('public')
    // An activity share defaults to the `activity` kind and carries no article.
    expect(created.kind).toBe('activity')
    expect(created.article).toBeNull()

    const fetched = await getFeedPostById(user, created.id)
    expect(fetched?.id).toBe(created.id)
    expect(await getFeedPostById(user, '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  test('assigns an unguessable image_token that round-trips (#893)', async () => {
    const user = getTestUser()
    const created = await createFeedPost(user, postInput())
    // Non-empty and unguessable (a UUID by default).
    expect(created.image_token).toMatch(/^[0-9a-f-]{36}$/)
    // Distinct per post, and stable on re-read.
    const other = await createFeedPost(user, postInput())
    expect(other.image_token).not.toBe(created.image_token)
    expect((await getFeedPostById(user, created.id))?.image_token).toBe(created.image_token)
  })

  test('stores, patches, and clears the personal message (#995)', async () => {
    const user = getTestUser()
    // Omitted on create → NULL.
    const bare = await createFeedPost(user, postInput())
    expect(bare.message).toBeNull()

    const created = await createFeedPost(user, postInput({ message: 'Felt great,\nnegative splits!' }))
    expect(created.message).toBe('Felt great,\nnegative splits!')
    expect((await getFeedPostById(user, created.id))?.message).toBe('Felt great,\nnegative splits!')

    // An undefined patch field leaves the message untouched…
    const untouched = await updateFeedPost(user, created.id, { visibility: 'unlisted' })
    expect(untouched?.message).toBe('Felt great,\nnegative splits!')
    // …a string replaces it, and null clears it.
    const replaced = await updateFeedPost(user, created.id, { message: 'Actually just ok' })
    expect(replaced?.message).toBe('Actually just ok')
    const cleared = await updateFeedPost(user, created.id, { message: null })
    expect(cleared?.message).toBeNull()
  })

  test('lists posts newest-first', async () => {
    const user = getTestUser()
    const first = await createFeedPost(user, postInput())
    const second = await createFeedPost(user, postInput())
    const posts = await listFeedPosts(user, 10)
    expect(posts.map((p) => p.id)).toEqual([second.id, first.id])
  })

  test('keyset-paginates by (created_at, id) (#1012)', async () => {
    const user = getTestUser()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await createFeedPost(user, postInput())).id)

    const page1 = await listFeedPosts(user, 2)
    expect(page1.map((p) => p.id)).toEqual([ids[2], ids[1]])

    const last = page1[page1.length - 1]!
    const page2 = await listFeedPosts(user, 2, { created_at: last.cursor_ts, id: last.id })
    expect(page2.map((p) => p.id)).toEqual([ids[0]])
  })

  test('pages losslessly across posts sharing a millisecond (#1025)', async () => {
    const user = getTestUser()
    const a = await createFeedPost(user, postInput())
    const b = await createFeedPost(user, postInput())
    // Same millisecond, different microsecond — the exact case a ms-truncated
    // cursor drops: `b` is `> cursor_ms` and would be skipped by every page.
    await setCreatedAt(a.id, '2026-08-20 09:00:00.500700+00')
    await setCreatedAt(b.id, '2026-08-20 09:00:00.500200+00')

    const page1 = await listFeedPosts(user, 1)
    expect(page1.map((p) => p.id)).toEqual([a.id])
    // The cursor carries Postgres' own µs rendering, not a JS Date.
    expect(page1[0].cursor_ts).toContain('.5007')

    const last = page1[0]
    const page2 = await listFeedPosts(user, 1, { created_at: last.cursor_ts, id: last.id })
    expect(page2.map((p) => p.id)).toEqual([b.id])
  })

  test('updates selected fields and leaves others intact', async () => {
    const user = getTestUser()
    const created = await createFeedPost(user, postInput({ series_metrics: ['heart_rate'] }))

    const updated = await updateFeedPost(user, created.id, {
      series_metrics: ['heart_rate', 'stress_level'],
      visibility: 'unlisted',
    })
    expect(updated?.series_metrics).toEqual(['heart_rate', 'stress_level'])
    expect(updated?.visibility).toBe('unlisted')
    expect(updated?.included_metrics).toEqual(created.included_metrics)

    // Empty patch is a no-op that still returns the current record.
    const noop = await updateFeedPost(user, created.id, {})
    expect(noop?.id).toBe(created.id)
    expect(await updateFeedPost(user, '00000000-0000-0000-0000-000000000000', {})).toBeNull()
  })

  test('deletes a post', async () => {
    const user = getTestUser()
    const created = await createFeedPost(user, postInput())
    expect(await deleteFeedPost(user, created.id)).toBe(true)
    expect(await deleteFeedPost(user, created.id)).toBe(false)
    expect(await getFeedPostById(user, created.id)).toBeNull()
  })

  describe('tombstones on delete', () => {
    test('records a tombstone for a deleted public post', async () => {
      const user = getTestUser()
      const created = await createFeedPost(user, postInput({ visibility: 'public' }))
      expect(await getFeedTombstone(user, created.id)).toBeNull()

      await deleteFeedPost(user, created.id)
      const tomb = await getFeedTombstone(user, created.id)
      expect(tomb).not.toBeNull()
      expect(tomb?.deleted_at).toBeInstanceOf(Date)
    })

    test('records a tombstone for a deleted unlisted post', async () => {
      const user = getTestUser()
      const created = await createFeedPost(user, postInput({ visibility: 'unlisted' }))
      await deleteFeedPost(user, created.id)
      expect(await getFeedTombstone(user, created.id)).not.toBeNull()
    })

    test('does NOT tombstone a deleted followers-only post (its id never resolved publicly)', async () => {
      const user = getTestUser()
      const created = await createFeedPost(user, postInput({ visibility: 'followers' }))
      await deleteFeedPost(user, created.id)
      expect(await getFeedTombstone(user, created.id)).toBeNull()
    })

    test('has no tombstone for a live (never-deleted) post', async () => {
      const user = getTestUser()
      const created = await createFeedPost(user, postInput({ visibility: 'public' }))
      expect(await getFeedTombstone(user, created.id)).toBeNull()
    })
  })

  describe('public outbox listing', () => {
    test('lists public and unlisted posts newest-first, excluding followers-only', async () => {
      const user = getTestUser()
      const pub = await createFeedPost(user, postInput({ visibility: 'public' }))
      const unlisted = await createFeedPost(user, postInput({ visibility: 'unlisted' }))
      await createFeedPost(user, postInput({ visibility: 'followers' }))

      const posts = await listPublicFeedPosts(user)
      expect(posts.map((p) => p.id)).toEqual([unlisted.id, pub.id])
      expect(await countPublicFeedPosts(user)).toBe(2)
    })

    test('are empty when the user has only followers-only posts', async () => {
      const user = getTestUser()
      await createFeedPost(user, postInput({ visibility: 'followers' }))
      expect(await listPublicFeedPosts(user)).toEqual([])
      expect(await countPublicFeedPosts(user)).toBe(0)
    })

    test('listPublicFeedPostsKeyset pages the profile listing by (created_at, id) (#1055)', async () => {
      const user = getTestUser()
      const a = await createFeedPost(user, postInput())
      const b = await createFeedPost(user, postInput())
      const c = await createFeedPost(user, postInput())
      await createFeedPost(user, postInput({ visibility: 'followers' }))

      const page1 = await listPublicFeedPostsKeyset(user, 2)
      expect(page1.map((p) => p.id)).toEqual([c.id, b.id])

      const last = page1[page1.length - 1]
      const page2 = await listPublicFeedPostsKeyset(user, 2, { created_at: last.cursor_ts, id: last.id })
      expect(page2.map((p) => p.id)).toEqual([a.id])
      expect(
        await listPublicFeedPostsKeyset(user, 2, {
          created_at: page2[0].cursor_ts,
          id: page2[0].id,
        }),
      ).toEqual([])
    })

    test('listPublicFeedPostsKeyset hides replies when asked, like the profile tab does', async () => {
      const user = getTestUser()
      const share = await createFeedPost(user, postInput())
      const reply = await createReplyPost(user, {
        in_reply_to_actor_uri: 'https://mastodon.example/users/alice',
        in_reply_to_uri: 'https://mastodon.example/statuses/1',
        message: 'Nice!',
        visibility: 'public',
      })
      expect((await listPublicFeedPostsKeyset(user, 10)).map((p) => p.id)).toEqual([reply.id, share.id])
      expect(
        (await listPublicFeedPostsKeyset(user, 10, undefined, { includeReplies: false })).map((p) => p.id),
      ).toEqual([share.id])
    })

    test('listPublicFeedPostsPage returns newest-first pages by limit/offset', async () => {
      const user = getTestUser()
      const a = await createFeedPost(user, postInput())
      const b = await createFeedPost(user, postInput())
      const c = await createFeedPost(user, postInput())
      // Newest-first: c, b, a
      expect((await listPublicFeedPostsPage(user, 2, 0)).map((p) => p.id)).toEqual([c.id, b.id])
      expect((await listPublicFeedPostsPage(user, 2, 2)).map((p) => p.id)).toEqual([a.id])
      expect(await listPublicFeedPostsPage(user, 2, 4)).toEqual([])
    })
  })

  describe('article posts', () => {
    test('creates an article and round-trips the JSONB payload by id', async () => {
      const user = getTestUser()
      const created = await createArticlePost(user, articleInput())

      expect(created.kind).toBe('article')
      expect(created.activity_id).toBeNull()
      expect(created.included_metrics).toEqual([])
      expect(created.series_metrics).toEqual([])
      expect(created.article?.title).toBe('A week of sleep and HRV')
      expect(created.article?.blocks).toHaveLength(2)
      expect(created.article?.blocks[0]).toEqual({
        markdown: '# Sleep vs HRV\n\nA look at the last week.',
        type: 'prose',
      })
      expect(created.article?.default_start).toBe('2026-07-01T00:00:00.000Z')

      // The parsed JSONB survives a fresh read.
      const fetched = await getFeedPostById(user, created.id)
      expect(fetched?.kind).toBe('article')
      expect(fetched?.article).toEqual(created.article)
    })

    test('replaces the whole article payload on update, touching updated_at', async () => {
      const user = getTestUser()
      const created = await createArticlePost(user, articleInput())

      const nextArticle = {
        blocks: [{ markdown: 'Rewritten.', type: 'prose' as const }],
        title: 'Revised analysis',
      }
      const updated = await updateFeedPost(user, created.id, {
        article: nextArticle,
        visibility: 'unlisted',
      })
      expect(updated?.article).toEqual(nextArticle)
      expect(updated?.article?.default_start).toBeUndefined() // replaced, not merged
      expect(updated?.visibility).toBe('unlisted')
      expect(updated?.updated_at.getTime()).toBeGreaterThanOrEqual(created.updated_at.getTime())
    })

    test('appears in the owner feed and the public outbox listings', async () => {
      const user = getTestUser()
      const article = await createArticlePost(user, articleInput({ visibility: 'public' }))
      expect((await listFeedPosts(user, 10)).map((p) => p.id)).toContain(article.id)
      const publicPosts = await listPublicFeedPosts(user)
      expect(publicPosts.map((p) => p.id)).toContain(article.id)
      expect(publicPosts.find((p) => p.id === article.id)?.article?.title).toBe('A week of sleep and HRV')
    })

    test('a followers-only article stays out of the public outbox', async () => {
      const user = getTestUser()
      await createArticlePost(user, articleInput({ visibility: 'followers' }))
      expect(await listPublicFeedPosts(user)).toEqual([])
    })
  })

  describe('findCoveringSharedSeriesWindow', () => {
    const within = { end: new Date('2026-07-01T07:00:00Z'), start: new Date('2026-07-01T06:40:00Z') }

    test('resolves when a public post shares the series and the activity covers the range', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(user, postInput({ activity_id: activityId, series_metrics: ['heart_rate'] }))

      const window = await findCoveringSharedSeriesWindow(user, 'heart_rate', within.start, within.end)
      expect(window?.start_time.toISOString()).toBe(ACTIVITY_START.toISOString())
      expect(window?.end_time.toISOString()).toBe(ACTIVITY_END.toISOString())
    })

    test('resolves for an unlisted post', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(
        user,
        postInput({ activity_id: activityId, series_metrics: ['heart_rate'], visibility: 'unlisted' }),
      )
      expect(
        await findCoveringSharedSeriesWindow(user, 'heart_rate', within.start, within.end),
      ).not.toBeNull()
    })

    test('does NOT resolve a metric that was only shared as a scalar (not a series)', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(
        user,
        postInput({ activity_id: activityId, included_metrics: ['heart_rate'], series_metrics: [] }),
      )
      expect(await findCoveringSharedSeriesWindow(user, 'heart_rate', within.start, within.end)).toBeNull()
    })

    test('does NOT resolve for a followers-only post', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(
        user,
        postInput({ activity_id: activityId, series_metrics: ['heart_rate'], visibility: 'followers' }),
      )
      expect(await findCoveringSharedSeriesWindow(user, 'heart_rate', within.start, within.end)).toBeNull()
    })

    test('does NOT resolve a window that extends outside the activity', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(user, postInput({ activity_id: activityId, series_metrics: ['heart_rate'] }))

      // Ends after the activity ends.
      const outside = { end: new Date('2026-07-01T08:00:00Z'), start: within.start }
      expect(await findCoveringSharedSeriesWindow(user, 'heart_rate', outside.start, outside.end)).toBeNull()
    })

    test('does NOT resolve a different metric', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(user, postInput({ activity_id: activityId, series_metrics: ['heart_rate'] }))
      expect(await findCoveringSharedSeriesWindow(user, 'stress_level', within.start, within.end)).toBeNull()
    })

    test('does NOT resolve once the activity is soft-deleted', async () => {
      const user = getTestUser()
      const activityId = await insertExercise(user)
      await createFeedPost(user, postInput({ activity_id: activityId, series_metrics: ['heart_rate'] }))
      await deleteActivity(user, activityId)
      expect(await findCoveringSharedSeriesWindow(user, 'heart_rate', within.start, within.end)).toBeNull()
    })
  })

  describe('challenge posts (#994)', () => {
    test('createChallengePost stores the payload + note and lists like any post', async () => {
      const user = getTestUser()
      const post = await createChallengePost(user, {
        challenge: { name: 'August 10k', url: 'https://aurboda.example/u/me/aug10k' },
        message: 'Join me!',
        visibility: 'unlisted',
      })
      expect(post.kind).toBe('challenge')
      expect(post.challenge).toEqual({ name: 'August 10k', url: 'https://aurboda.example/u/me/aug10k' })
      expect(post.message).toBe('Join me!')
      expect(post.activity_id).toBeNull()
      expect(post.article).toBeNull()

      const fetched = await getFeedPostById(user, post.id)
      expect(fetched?.challenge).toEqual(post.challenge)
      expect((await listFeedPosts(user, 10)).map((p) => p.id)).toContain(post.id)
      // Public/unlisted challenge shares appear on the outbox listing like any post.
      expect((await listPublicFeedPosts(user)).map((p) => p.id)).toContain(post.id)
    })
  })
  describe('reply posts', () => {
    const TARGET = 'https://mastodon.example/users/alice/statuses/9'
    const TARGET_ACTOR = 'https://mastodon.example/users/alice'
    const replyInput = (over: Partial<ReplyPostInput> = {}): ReplyPostInput => ({
      in_reply_to_actor_uri: TARGET_ACTOR,
      in_reply_to_handle: '@alice@mastodon.example',
      in_reply_to_uri: TARGET,
      message: 'Nice run!',
      visibility: 'unlisted',
      ...over,
    })

    test('creates a reply and round-trips its target by id', async () => {
      const user = getTestUser()
      const post = await createReplyPost(user, replyInput())

      expect(post.kind).toBe('reply')
      expect(post.in_reply_to_uri).toBe(TARGET)
      expect(post.in_reply_to_actor_uri).toBe(TARGET_ACTOR)
      expect(post.in_reply_to_handle).toBe('@alice@mastodon.example')
      expect(post.message).toBe('Nice run!')
      expect(post.activity_id).toBeNull()
      expect(post.article).toBeNull()
      expect(post.challenge).toBeNull()

      const fetched = await getFeedPostById(user, post.id)
      expect(fetched?.in_reply_to_uri).toBe(TARGET)
      expect((await listFeedPosts(user, 10)).map((p) => p.id)).toContain(post.id)
    })

    test('stores a null handle when none was snapshotted', async () => {
      const user = getTestUser()
      const post = await createReplyPost(user, replyInput({ in_reply_to_handle: null }))
      expect(post.in_reply_to_handle).toBeNull()
    })

    test('listReplyPostsTo returns only this target’s replies, oldest first', async () => {
      const user = getTestUser()
      const first = await createReplyPost(user, replyInput({ message: 'one' }))
      const second = await createReplyPost(user, replyInput({ message: 'two' }))
      await createReplyPost(user, replyInput({ in_reply_to_uri: `${TARGET}9`, message: 'elsewhere' }))
      // A non-reply post pointing nowhere must never be picked up.
      await createFeedPost(user, postInput())

      const replies = await listReplyPostsTo(user, TARGET)
      expect(replies.map((p) => p.id)).toEqual([first.id, second.id])
    })

    test('listReplyPostsTo is empty for a target with no replies', async () => {
      const user = getTestUser()
      expect(await listReplyPostsTo(user, TARGET)).toEqual([])
    })

    test('the outbox lists replies; the profile listing (includeReplies false) hides them', async () => {
      const user = getTestUser()
      const share = await createFeedPost(user, postInput({ visibility: 'public' }))
      const reply = await createReplyPost(user, replyInput())

      expect((await listPublicFeedPostsPage(user, 10, 0)).map((p) => p.id)).toEqual([reply.id, share.id])
      expect(
        (await listPublicFeedPostsPage(user, 10, 0, { includeReplies: false })).map((p) => p.id),
      ).toEqual([share.id])
      // The count is unchanged — the outbox counter still covers every post.
      expect(await countPublicFeedPosts(user)).toBe(2)
    })

    test('a followers-only reply never reaches the outbox listing', async () => {
      const user = getTestUser()
      await createReplyPost(user, replyInput({ visibility: 'followers' }))
      expect(await listPublicFeedPosts(user)).toEqual([])
    })
  })
})
