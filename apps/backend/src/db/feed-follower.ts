/**
 * Remote followers of a user's ActivityPub actor.
 *
 * Stored per-user (in the followed user's database), keyed by the follower's
 * actor URI. We cache the follower's inbox (and optional shared inbox) so the
 * delivery slice can fan a user's posts out to them, their handle / display name
 * / avatar so a follow-request UI can show who is asking, and the id of the
 * Follow they sent so a deferred Accept/Reject can reference the original
 * request. `accepted` records whether we have approved them: in manual-approval
 * mode it stays false (a pending request) until the owner approves; only
 * accepted followers appear in the followers collection + count and receive
 * `followers`-only posts. `id` is a stable local handle for the approve/reject
 * API (the actor_uri is unwieldy as a path param).
 */
import type { CachedActorPresentation } from './types.ts'

import { query } from './connection.ts'

export interface FeedFollowerRecord {
  id: string
  actor_uri: string
  inbox_uri: string
  shared_inbox_uri: string | null
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  follow_activity_uri: string | null
  accepted: boolean
  created_at: Date
}

export interface FeedFollowerInput {
  actor_uri: string
  inbox_uri: string
  shared_inbox_uri?: string | null
  handle?: string | null
  display_name?: string | null
  avatar_url?: string | null
  follow_activity_uri?: string | null
  accepted?: boolean
}

const FEED_FOLLOWER_COLUMNS =
  'id, actor_uri, inbox_uri, shared_inbox_uri, handle, display_name, avatar_url, follow_activity_uri, accepted, created_at'

/**
 * Insert or update a follower by actor URI. A re-delivered Follow refreshes the
 * cached inboxes, presentation, and Follow-activity id and updates the
 * acceptance flag, without duplicating or minting a new local id. Presentation
 * and the Follow id are COALESCEd so a re-Follow that couldn't re-extract them
 * doesn't wipe the last-known values.
 */
export const upsertFeedFollower = async (
  user: string,
  input: FeedFollowerInput,
): Promise<FeedFollowerRecord> => {
  const result = await query<FeedFollowerRecord>(
    user,
    `INSERT INTO feed_follower
       (actor_uri, inbox_uri, shared_inbox_uri, handle, display_name, avatar_url, follow_activity_uri, accepted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (actor_uri)
     DO UPDATE SET inbox_uri = EXCLUDED.inbox_uri,
                   shared_inbox_uri = EXCLUDED.shared_inbox_uri,
                   handle = COALESCE(EXCLUDED.handle, feed_follower.handle),
                   display_name = COALESCE(EXCLUDED.display_name, feed_follower.display_name),
                   avatar_url = COALESCE(EXCLUDED.avatar_url, feed_follower.avatar_url),
                   follow_activity_uri = COALESCE(EXCLUDED.follow_activity_uri, feed_follower.follow_activity_uri),
                   accepted = EXCLUDED.accepted
     RETURNING ${FEED_FOLLOWER_COLUMNS}`,
    [
      input.actor_uri,
      input.inbox_uri,
      input.shared_inbox_uri ?? null,
      input.handle ?? null,
      input.display_name ?? null,
      input.avatar_url ?? null,
      input.follow_activity_uri ?? null,
      input.accepted ?? false,
    ],
  )
  return result.rows[0]
}

/**
 * Refresh a follower's cached presentation from an inbound `Update{Person}`
 * (#1057) — the inbound mirror of the `Update{Person}` we deliver when our own
 * profile changes. Returns whether such a follower existed.
 *
 * Presentation columns ONLY: the inbox URIs are delivery addressing, settled
 * when the Follow arrived, and a profile edit has no business repointing where
 * we deliver. The served actor document is authoritative here, so a removed
 * avatar/display name really is cleared rather than COALESCEd away.
 */
export const updateFeedFollowerPresentation = async (
  user: string,
  actorUri: string,
  presentation: CachedActorPresentation,
): Promise<boolean> => {
  const result = await query(
    user,
    `UPDATE feed_follower SET handle = $2, display_name = $3, avatar_url = $4
     WHERE actor_uri = $1`,
    [actorUri, presentation.handle, presentation.display_name, presentation.avatar_url],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * List followers, optionally filtered by acceptance state. `{ accepted: true }`
 * is the confirmed-followers view used by the followers collection + delivery;
 * `{ accepted: false }` is the pending-requests view; omitting it lists all.
 */
export const listFeedFollowers = async (
  user: string,
  opts: { accepted?: boolean } = {},
): Promise<FeedFollowerRecord[]> => {
  const where = opts.accepted === undefined ? '' : 'WHERE accepted = $1'
  const params = opts.accepted === undefined ? [] : [opts.accepted]
  const result = await query<FeedFollowerRecord>(
    user,
    `SELECT ${FEED_FOLLOWER_COLUMNS} FROM feed_follower ${where} ORDER BY created_at ASC`,
    params,
  )
  return result.rows
}

/** Fetch a single follower by its local id, or null. */
export const getFeedFollowerById = async (user: string, id: string): Promise<FeedFollowerRecord | null> => {
  const result = await query<FeedFollowerRecord>(
    user,
    `SELECT ${FEED_FOLLOWER_COLUMNS} FROM feed_follower WHERE id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

/** Fetch a single follower by their actor URI, or null. */
export const getFeedFollowerByActor = async (
  user: string,
  actorUri: string,
): Promise<FeedFollowerRecord | null> => {
  const result = await query<FeedFollowerRecord>(
    user,
    `SELECT ${FEED_FOLLOWER_COLUMNS} FROM feed_follower WHERE actor_uri = $1`,
    [actorUri],
  )
  return result.rows[0] ?? null
}

/** Mark a follower accepted (approving a pending request). Returns the updated row, or null if unknown. */
export const setFeedFollowerAccepted = async (
  user: string,
  id: string,
): Promise<FeedFollowerRecord | null> => {
  const result = await query<FeedFollowerRecord>(
    user,
    `UPDATE feed_follower SET accepted = true WHERE id = $1 RETURNING ${FEED_FOLLOWER_COLUMNS}`,
    [id],
  )
  return result.rows[0] ?? null
}

/** Count *accepted* followers without loading their rows (for the followers-collection counter). */
export const countFeedFollowers = async (user: string): Promise<number> => {
  const result = await query<{ count: string }>(
    user,
    `SELECT COUNT(*)::text AS count FROM feed_follower WHERE accepted = true`,
  )
  return Number(result.rows[0].count)
}

/** Remove a follower by actor URI (e.g. on an Undo{Follow}). */
export const removeFeedFollower = async (user: string, actorUri: string): Promise<boolean> => {
  const result = await query(user, `DELETE FROM feed_follower WHERE actor_uri = $1`, [actorUri])
  return (result.rowCount ?? 0) > 0
}

/**
 * Remove a follower by its local id (rejecting a request or removing a
 * follower), returning the removed row so the caller can send a Reject to their
 * inbox — or null if there was no such follower.
 */
export const removeFeedFollowerById = async (
  user: string,
  id: string,
): Promise<FeedFollowerRecord | null> => {
  const result = await query<FeedFollowerRecord>(
    user,
    `DELETE FROM feed_follower WHERE id = $1 RETURNING ${FEED_FOLLOWER_COLUMNS}`,
    [id],
  )
  return result.rows[0] ?? null
}
