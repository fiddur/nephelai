/**
 * Likes ⭐ and boosts 🔄 — both directions of the AS2 `Like` / `Announce` pair.
 *
 * Two tables, one per direction, both in the user's own database:
 *
 * - `feed_reaction` — the user's OWN outbound reactions. Its `id` mints the AS2
 *   activity id we deliver (and the `#undo` that retracts it), and the reacted-to
 *   Note's author + inbox are cached so the `Undo` needs no actor re-resolve.
 *   `UNIQUE (kind, object_uri)` is what makes liking idempotent.
 * - `feed_post_reaction` — inbound reactions on the user's own posts (who liked
 *   or boosted it), keyed `(post_id, kind, actor_uri)` so a redelivery refreshes
 *   the presentation snapshot instead of duplicating.
 */
import type { FeedReactionKind } from '@aurboda/api-spec'

import { query } from './connection.ts'

export interface FeedReactionRecord {
  id: string
  kind: FeedReactionKind
  /** The reacted-to Note's id. */
  object_uri: string
  /** The Note's author — the `Like` recipient / the `Announce`'s extra recipient. */
  actor_uri: string
  inbox_uri: string
  shared_inbox_uri: string | null
  created_at: Date
}

export interface FeedReactionInput {
  kind: FeedReactionKind
  object_uri: string
  actor_uri: string
  inbox_uri: string
  shared_inbox_uri?: string | null
}

const FEED_REACTION_COLUMNS = 'id, kind, object_uri, actor_uri, inbox_uri, shared_inbox_uri, created_at'

/**
 * Record an outbound reaction, or return the existing one unchanged. `inserted`
 * distinguishes the two (the `xmax = 0` trick used across this codebase), so the
 * caller delivers the activity exactly once: a second Like of the same post is a
 * local no-op, never a second POST to the author's inbox.
 */
export const insertFeedReaction = async (
  user: string,
  input: FeedReactionInput,
): Promise<FeedReactionRecord & { inserted: boolean }> => {
  const result = await query<FeedReactionRecord & { inserted: boolean }>(
    user,
    `INSERT INTO feed_reaction (kind, object_uri, actor_uri, inbox_uri, shared_inbox_uri)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, object_uri)
     -- A no-op update (not DO NOTHING) so the existing row is still RETURNED —
     -- the caller needs its id to keep the delivered activity id stable.
     DO UPDATE SET object_uri = feed_reaction.object_uri
     RETURNING ${FEED_REACTION_COLUMNS}, (xmax = 0) AS inserted`,
    [input.kind, input.object_uri, input.actor_uri, input.inbox_uri, input.shared_inbox_uri ?? null],
  )
  return result.rows[0]
}

/** One outbound reaction by (kind, reacted-to object), or null. */
export const getFeedReaction = async (
  user: string,
  kind: FeedReactionKind,
  objectUri: string,
): Promise<FeedReactionRecord | null> => {
  const result = await query<FeedReactionRecord>(
    user,
    `SELECT ${FEED_REACTION_COLUMNS} FROM feed_reaction WHERE kind = $1 AND object_uri = $2`,
    [kind, objectUri],
  )
  return result.rows[0] ?? null
}

/**
 * Drop an outbound reaction, returning the removed row (or null). The returned
 * row carries the cached inbox + the id the `Undo` must reference, so the caller
 * can still address the retraction after the row is gone.
 */
export const removeFeedReaction = async (
  user: string,
  kind: FeedReactionKind,
  objectUri: string,
): Promise<FeedReactionRecord | null> => {
  const result = await query<FeedReactionRecord>(
    user,
    `DELETE FROM feed_reaction WHERE kind = $1 AND object_uri = $2 RETURNING ${FEED_REACTION_COLUMNS}`,
    [kind, objectUri],
  )
  return result.rows[0] ?? null
}

/** One `(kind, object_uri)` pair the user has reacted to. */
export interface FeedReactionState {
  kind: FeedReactionKind
  object_uri: string
}

/**
 * Which of `objectUris` the user has liked / boosted — the batched lookup the
 * timeline page uses to mark its cards (one query per page, not per card).
 */
export const listFeedReactionsForObjects = async (
  user: string,
  objectUris: string[],
): Promise<FeedReactionState[]> => {
  if (objectUris.length === 0) return []
  const result = await query<FeedReactionState>(
    user,
    `SELECT kind, object_uri FROM feed_reaction WHERE object_uri = ANY($1)`,
    [objectUris],
  )
  return result.rows
}

export interface FeedPostReactionRecord {
  post_id: string
  kind: FeedReactionKind
  actor_uri: string
  activity_uri: string | null
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  created_at: Date
}

export interface FeedPostReactionInput {
  post_id: string
  kind: FeedReactionKind
  actor_uri: string
  /** The remote `Like`/`Announce`'s own id, so a bare-id `Undo` still matches. */
  activity_uri?: string | null
  handle?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

const FEED_POST_REACTION_COLUMNS =
  'post_id, kind, actor_uri, activity_uri, handle, display_name, avatar_url, created_at'

/**
 * Record an inbound reaction on one of the user's own posts. A redelivery
 * refreshes the activity id + presentation snapshot in place; `created_at` stays
 * at first receipt so the "who reacted" list keeps a stable order.
 */
export const upsertFeedPostReaction = async (
  user: string,
  input: FeedPostReactionInput,
): Promise<FeedPostReactionRecord> => {
  const result = await query<FeedPostReactionRecord>(
    user,
    `INSERT INTO feed_post_reaction (post_id, kind, actor_uri, activity_uri, handle, display_name, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (post_id, kind, actor_uri)
     DO UPDATE SET activity_uri = COALESCE(EXCLUDED.activity_uri, feed_post_reaction.activity_uri),
                   handle = COALESCE(EXCLUDED.handle, feed_post_reaction.handle),
                   display_name = COALESCE(EXCLUDED.display_name, feed_post_reaction.display_name),
                   avatar_url = COALESCE(EXCLUDED.avatar_url, feed_post_reaction.avatar_url)
     RETURNING ${FEED_POST_REACTION_COLUMNS}`,
    [
      input.post_id,
      input.kind,
      input.actor_uri,
      input.activity_uri ?? null,
      input.handle ?? null,
      input.display_name ?? null,
      input.avatar_url ?? null,
    ],
  )
  return result.rows[0]
}

/**
 * Retract an inbound reaction (an `Undo{Like}` / `Undo{Announce}` whose inner
 * object resolved to one of our posts). Scoped to the undoing actor, so a signed
 * Undo can only remove that actor's own reaction.
 */
export const removeFeedPostReaction = async (
  user: string,
  postId: string,
  kind: FeedReactionKind,
  actorUri: string,
): Promise<boolean> => {
  const result = await query(
    user,
    `DELETE FROM feed_post_reaction WHERE post_id = $1 AND kind = $2 AND actor_uri = $3`,
    [postId, kind, actorUri],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Retract an inbound reaction by the remote activity's own id — the fallback
 * when an `Undo` carries only a bare activity URI we can't dereference. Still
 * scoped to the undoing actor.
 */
export const removeFeedPostReactionByActivity = async (
  user: string,
  activityUri: string,
  actorUri: string,
): Promise<boolean> => {
  const result = await query(
    user,
    `DELETE FROM feed_post_reaction WHERE activity_uri = $1 AND actor_uri = $2`,
    [activityUri, actorUri],
  )
  return (result.rowCount ?? 0) > 0
}

/** Who reacted to one of the user's posts, newest first (capped by `limit`). */
export const listFeedPostReactions = async (
  user: string,
  postId: string,
  limit: number,
): Promise<FeedPostReactionRecord[]> => {
  const result = await query<FeedPostReactionRecord>(
    user,
    `SELECT ${FEED_POST_REACTION_COLUMNS} FROM feed_post_reaction
     WHERE post_id = $1
     ORDER BY created_at DESC, actor_uri DESC
     LIMIT $2`,
    [postId, limit],
  )
  return result.rows
}

/** A reaction tally for one post + kind. */
export interface FeedPostReactionCount {
  post_id: string
  kind: FeedReactionKind
  count: number
}

/**
 * Like/boost tallies for a whole page of the owner's posts — ONE grouped query,
 * so the feed listing never pays a count per post. Posts with no reactions are
 * simply absent from the result.
 */
export const countFeedPostReactions = async (
  user: string,
  postIds: string[],
): Promise<FeedPostReactionCount[]> => {
  if (postIds.length === 0) return []
  const result = await query<FeedPostReactionCount>(
    user,
    `SELECT post_id, kind, count(*)::int AS count FROM feed_post_reaction
     WHERE post_id = ANY($1::uuid[])
     GROUP BY post_id, kind`,
    [postIds],
  )
  return result.rows
}
