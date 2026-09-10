import type { ArticleContent, ChallengeShare, FeedPostKind, FeedVisibility } from '@aurboda/api-spec'

/**
 * Feed posts — activities a user published to their federated feed.
 *
 * Posts live in the user's own database. Each records the explicit metric
 * selection that bounds what leaves the instance: `included_metrics` (scalar
 * summaries) and `series_metrics` (high-resolution opt-in). The latter is the
 * authorization set the public `/series` endpoint checks against.
 *
 * `activity_id` is a soft reference (no FK): activities are soft-deleted and the
 * series lookup re-checks `deleted_at`, so a removed activity simply stops
 * resolving rather than cascading a delete.
 */
import { query } from './connection.ts'

export interface FeedPostRecord {
  id: string
  /** `activity` (shares an activity) or `article` (long-form prose + chart blocks). */
  kind: FeedPostKind
  activity_id: string | null
  included_metrics: string[]
  series_metrics: string[]
  visibility: FeedVisibility
  include_map: boolean
  include_chart: boolean
  /** Stored article payload (title + default window + blocks); null for `activity` posts. */
  article: ArticleContent | null
  /** Stored challenge link payload (name + canonical URL); null unless kind = 'challenge'. */
  challenge: ChallengeShare | null
  /** The author's personal message (plain text), or null when none was shared. */
  message: string | null
  /** The replied-to object id; null unless kind = 'reply'. */
  in_reply_to_uri: string | null
  /** The replied-to post author's actor URI; null unless kind = 'reply'. */
  in_reply_to_actor_uri: string | null
  /** The replied-to author's `@user@host` at reply time (names the `Mention`). */
  in_reply_to_handle: string | null
  /** The auto-share rule that created this post (#903), or null for manual posts. */
  autoshare_rule_id: string | null
  /** Unguessable capability token for `followers`-only image URLs (see schema). */
  image_token: string
  created_at: Date
  updated_at: Date
}

export interface FeedPostInput {
  activity_id: string | null
  included_metrics: string[]
  series_metrics: string[]
  visibility: FeedVisibility
  include_map: boolean
  include_chart: boolean
  /** The author's personal message; omitted/undefined stores NULL. */
  message?: string | null
  /** The auto-share rule creating this post (#903); omitted for manual shares. */
  autoshare_rule_id?: string | null
}

/** Input for creating an `article` post (no activity anchor / shared metrics). */
export interface ArticlePostInput {
  visibility: FeedVisibility
  article: ArticleContent
}

export interface ChallengePostInput {
  visibility: FeedVisibility
  challenge: ChallengeShare
  /** The author's personal note (markdown); omitted/undefined stores NULL. */
  message?: string | null
}

/**
 * Input for a `reply` post: the reply text plus what it answers. Every target
 * field is resolved server-side from the timeline entry being replied to, so a
 * stored reply can never claim a target the reader never received.
 */
export interface ReplyPostInput {
  visibility: FeedVisibility
  /** The reply text (markdown). Non-blank — validated at the request boundary. */
  message: string
  /** The replied-to object's canonical AS2 id. */
  in_reply_to_uri: string
  /** The replied-to post author's actor URI (the `Mention` href). */
  in_reply_to_actor_uri: string
  /** The replied-to author's `@user@host` at reply time (the `Mention` name), if known. */
  in_reply_to_handle?: string | null
}

export interface FeedPostPatch {
  included_metrics?: string[]
  series_metrics?: string[]
  visibility?: FeedVisibility
  include_map?: boolean
  include_chart?: boolean
  /** Replacement article payload (whole `article` JSONB), for editing an article post. */
  article?: ArticleContent
  /** Replacement personal message; `null` clears it, `undefined` leaves it unchanged. */
  message?: string | null
}

const FEED_POST_COLUMNS =
  'id, kind, activity_id, included_metrics, series_metrics, visibility, include_map, include_chart, article, challenge, message, in_reply_to_uri, in_reply_to_actor_uri, in_reply_to_handle, autoshare_rule_id, image_token, created_at, updated_at'

interface FeedPostRow {
  id: string
  kind: FeedPostKind
  activity_id: string | null
  included_metrics: string[]
  series_metrics: string[]
  visibility: FeedVisibility
  include_map: boolean
  include_chart: boolean
  // pg parses a jsonb column to its JS value on read (null for `activity` posts).
  article: ArticleContent | null
  challenge: ChallengeShare | null
  message: string | null
  in_reply_to_uri: string | null
  in_reply_to_actor_uri: string | null
  in_reply_to_handle: string | null
  autoshare_rule_id: string | null
  image_token: string
  created_at: Date
  updated_at: Date
}

const mapFeedPost = (row: FeedPostRow): FeedPostRecord => ({ ...row })

export const createFeedPost = async (user: string, input: FeedPostInput): Promise<FeedPostRecord> => {
  const result = await query<FeedPostRow>(
    user,
    `INSERT INTO feed_posts
       (activity_id, included_metrics, series_metrics, visibility, include_map, include_chart, message, autoshare_rule_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${FEED_POST_COLUMNS}`,
    [
      input.activity_id,
      input.included_metrics,
      input.series_metrics,
      input.visibility,
      input.include_map,
      input.include_chart,
      input.message ?? null,
      input.autoshare_rule_id ?? null,
    ],
  )
  return mapFeedPost(result.rows[0])
}

/**
 * Create an `article` post: no activity anchor and no shared metrics, just the
 * article payload (title + default window + blocks) in the `article` JSONB. The
 * `kind`/`activity_id`/metric columns fall to their table defaults where not set.
 */
export const createArticlePost = async (user: string, input: ArticlePostInput): Promise<FeedPostRecord> => {
  const result = await query<FeedPostRow>(
    user,
    `INSERT INTO feed_posts (kind, visibility, article)
     VALUES ('article', $1, $2)
     RETURNING ${FEED_POST_COLUMNS}`,
    [input.visibility, JSON.stringify(input.article)],
  )
  return mapFeedPost(result.rows[0])
}

/**
 * Create a `challenge` post (#994): the resolved challenge link payload in the
 * `challenge` JSONB plus the author's personal note. No activity anchor and no
 * shared metrics — the post is an invitation, not a data share.
 */
export const createChallengePost = async (
  user: string,
  input: ChallengePostInput,
): Promise<FeedPostRecord> => {
  const result = await query<FeedPostRow>(
    user,
    `INSERT INTO feed_posts (kind, visibility, challenge, message)
     VALUES ('challenge', $1, $2, $3)
     RETURNING ${FEED_POST_COLUMNS}`,
    [input.visibility, JSON.stringify(input.challenge), input.message ?? null],
  )
  return mapFeedPost(result.rows[0])
}

/**
 * Create a `reply` post: the reply text plus the resolved target (object id,
 * author actor URI, author handle snapshot). No activity anchor and no shared
 * metrics — a reply is a comment, not a data share.
 */
export const createReplyPost = async (user: string, input: ReplyPostInput): Promise<FeedPostRecord> => {
  const result = await query<FeedPostRow>(
    user,
    `INSERT INTO feed_posts (kind, visibility, message, in_reply_to_uri, in_reply_to_actor_uri, in_reply_to_handle)
     VALUES ('reply', $1, $2, $3, $4, $5)
     RETURNING ${FEED_POST_COLUMNS}`,
    [
      input.visibility,
      input.message,
      input.in_reply_to_uri,
      input.in_reply_to_actor_uri,
      input.in_reply_to_handle ?? null,
    ],
  )
  return mapFeedPost(result.rows[0])
}

/**
 * The user's OWN replies to one object, oldest first — merged into the live
 * thread snapshot of a timeline card so a reply shows immediately, whether or
 * not the origin's `replies` collection lists it yet.
 */
export const listReplyPostsTo = async (user: string, objectUri: string): Promise<FeedPostRecord[]> => {
  const result = await query<FeedPostRow>(
    user,
    `SELECT ${FEED_POST_COLUMNS} FROM feed_posts
      WHERE kind = 'reply' AND in_reply_to_uri = $1
      ORDER BY created_at ASC, id ASC`,
    [objectUri],
  )
  return result.rows.map(mapFeedPost)
}

/** Keyset position in the owner's feed: the previous page's last `(created_at, id)`. */
export interface FeedPostCursor {
  created_at: Date
  id: string
}

/**
 * A keyset page of the owner's feed posts, newest-first (#1012). The `id`
 * tiebreaker keeps ordering deterministic when two posts share a `created_at`
 * (microsecond collision on rapid inserts); pass the previous page's last
 * `(created_at, id)` as `before` for the next page.
 */
export const listFeedPosts = async (
  user: string,
  limit: number,
  before?: FeedPostCursor,
): Promise<FeedPostRecord[]> => {
  const result = await query<FeedPostRow>(
    user,
    `SELECT ${FEED_POST_COLUMNS} FROM feed_posts
     WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [before?.created_at ?? null, before?.id ?? null, limit],
  )
  return result.rows.map(mapFeedPost)
}

/**
 * Posts that appear on the public outbox / actor profile: `public` and
 * `unlisted` (both addressed to the AS2 Public collection). `followers`-only
 * posts are never listed here. Same deterministic newest-first ordering as
 * `listFeedPosts`.
 */
export const listPublicFeedPosts = async (user: string): Promise<FeedPostRecord[]> => {
  const result = await query<FeedPostRow>(
    user,
    `SELECT ${FEED_POST_COLUMNS} FROM feed_posts
      WHERE visibility IN ('public', 'unlisted')
      ORDER BY created_at DESC, id DESC`,
  )
  return result.rows.map(mapFeedPost)
}

/** Options for `listPublicFeedPostsPage`. */
export interface PublicFeedPageOpts {
  /**
   * Whether `reply` posts are listed. The ActivityPub outbox lists everything
   * the actor published (default), while the public profile's post tab hides
   * replies — Mastodon's own default profile tab does the same, and a bare
   * comment out of its thread reads as noise.
   */
  includeReplies?: boolean
}

/**
 * One page of public outbox posts, newest-first, for the cursor-paginated
 * ActivityPub outbox. `limit`/`offset` are clamped by the caller.
 */
export const listPublicFeedPostsPage = async (
  user: string,
  limit: number,
  offset: number,
  opts: PublicFeedPageOpts = {},
): Promise<FeedPostRecord[]> => {
  const result = await query<FeedPostRow>(
    user,
    `SELECT ${FEED_POST_COLUMNS} FROM feed_posts
      WHERE visibility IN ('public', 'unlisted')
        AND ($3::boolean OR kind <> 'reply')
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, opts.includeReplies ?? true],
  )
  return result.rows.map(mapFeedPost)
}

/** Total number of posts on the public outbox (see `listPublicFeedPosts`). */
export const countPublicFeedPosts = async (user: string): Promise<number> => {
  const result = await query<{ count: number }>(
    user,
    `SELECT count(*)::int AS count FROM feed_posts WHERE visibility IN ('public', 'unlisted')`,
  )
  return Number(result.rows[0]?.count ?? 0)
}

export const getFeedPostById = async (user: string, id: string): Promise<FeedPostRecord | null> => {
  const result = await query<FeedPostRow>(user, `SELECT ${FEED_POST_COLUMNS} FROM feed_posts WHERE id = $1`, [
    id,
  ])
  return result.rows.length ? mapFeedPost(result.rows[0]) : null
}

export const updateFeedPost = async (
  user: string,
  id: string,
  patch: FeedPostPatch,
): Promise<FeedPostRecord | null> => {
  const sets: string[] = []
  const params: unknown[] = []
  let idx = 1
  const set = (col: string, value: unknown) => {
    sets.push(`${col} = $${idx++}`)
    params.push(value)
  }

  if (patch.included_metrics !== undefined) set('included_metrics', patch.included_metrics)
  if (patch.series_metrics !== undefined) set('series_metrics', patch.series_metrics)
  if (patch.visibility !== undefined) set('visibility', patch.visibility)
  if (patch.include_map !== undefined) set('include_map', patch.include_map)
  if (patch.include_chart !== undefined) set('include_chart', patch.include_chart)
  if (patch.article !== undefined) set('article', JSON.stringify(patch.article))
  if (patch.message !== undefined) set('message', patch.message)

  if (sets.length === 0) return getFeedPostById(user, id)

  sets.push('updated_at = NOW()')
  params.push(id)
  const result = await query<FeedPostRow>(
    user,
    `UPDATE feed_posts SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${FEED_POST_COLUMNS}`,
    params,
  )
  return result.rows.length ? mapFeedPost(result.rows[0]) : null
}

/**
 * Delete a feed post and, if it was `public`/`unlisted` (so its object id was
 * publicly dereferenceable), record a tombstone in the same statement so a later
 * GET of that id can return `410 Gone` instead of `404`. Atomic: the delete and
 * the tombstone insert commit together. `followers`-only posts leave no tombstone
 * — their id never resolved publicly, so a 410 would leak that a post existed.
 * Idempotent via `ON CONFLICT` (re-deleting a since-recreated id is a no-op).
 *
 * The post's inbound like/boost records go with it: `feed_post_reaction.post_id`
 * is a soft reference (like `activity_id`), so nothing cascades on its own.
 */
export const deleteFeedPost = async (user: string, id: string): Promise<boolean> => {
  const result = await query<{ id: string }>(
    user,
    `WITH deleted AS (
       DELETE FROM feed_posts WHERE id = $1
       RETURNING id, visibility, activity_id
     ), reactions AS (
       DELETE FROM feed_post_reaction WHERE post_id IN (SELECT id FROM deleted)
     ), tomb AS (
       INSERT INTO feed_tombstone (post_id)
       SELECT id FROM deleted WHERE visibility IN ('public', 'unlisted')
       ON CONFLICT (post_id) DO NOTHING
     ), suppress AS (
       -- The user deliberately removed this share: auto-share rules must never
       -- republish the activity (#903). Survives the hard delete above.
       INSERT INTO autoshare_suppressions (activity_id)
       SELECT activity_id FROM deleted WHERE activity_id IS NOT NULL
       ON CONFLICT (activity_id) DO NOTHING
     )
     SELECT id FROM deleted`,
    [id],
  )
  return result.rows.length > 0
}

/**
 * The tombstone for a deleted public/unlisted post, or null if the id was never
 * publicly shared (or is still live). Backs the `410 Gone` object dereference.
 */
export const getFeedTombstone = async (
  user: string,
  postId: string,
): Promise<{ deleted_at: Date } | null> => {
  const result = await query<{ deleted_at: Date }>(
    user,
    `SELECT deleted_at FROM feed_tombstone WHERE post_id = $1`,
    [postId],
  )
  return result.rows.length ? result.rows[0] : null
}

/**
 * The window of a shared activity that authorizes a public series request, or
 * null if none does. Resolves only when some non-`followers` feed post shared
 * `metric` as a series for a non-deleted, bounded activity whose window covers
 * `[start, end]`. This is the whole privacy boundary for the unauthenticated
 * `/series` endpoint, so the conditions are strict:
 *
 * - the metric must be in `series_metrics` (scalar sharing alone never exposes a series),
 * - the post must be `public` or `unlisted` (`followers` posts have no public series),
 * - the activity must not be soft-deleted and must have an `end_time`,
 * - the activity window must fully cover the requested range.
 */
export const findCoveringSharedSeriesWindow = async (
  user: string,
  metric: string,
  start: Date,
  end: Date,
): Promise<{ start_time: Date; end_time: Date } | null> => {
  const result = await query<{ start_time: Date; end_time: Date }>(
    user,
    `SELECT a.start_time, a.end_time
       FROM feed_posts f
       JOIN activities a ON a.id = f.activity_id
      WHERE $1 = ANY(f.series_metrics)
        AND f.visibility IN ('public', 'unlisted')
        AND a.deleted_at IS NULL
        AND a.end_time IS NOT NULL
        AND a.start_time <= $2
        AND a.end_time >= $3
      ORDER BY a.start_time
      LIMIT 1`,
    [metric, start, end],
  )
  return result.rows.length ? result.rows[0] : null
}

/**
 * Ids of the feed posts referencing ANY of the given activities (#903's hard
 * dedupe): an activity/merge-group with an existing post — manual or
 * auto-created — is never auto-shared again.
 */
export const listFeedPostIdsByActivityIds = async (
  user: string,
  activityIds: string[],
): Promise<string[]> => {
  if (activityIds.length === 0) return []
  const result = await query<{ id: string }>(user, `SELECT id FROM feed_posts WHERE activity_id = ANY($1)`, [
    activityIds,
  ])
  return result.rows.map((row) => row.id)
}
