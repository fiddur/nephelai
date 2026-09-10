/**
 * Actors this user's ActivityPub actor follows (the inbound direction of the
 * feed: who we follow, so their posts can arrive in our inbox).
 *
 * Stored per-user (in the following user's database), with a local `id` used to
 * build the outbound `Follow` activity id (and to unfollow from the UI) and a
 * UNIQUE `actor_uri` so a re-follow upserts rather than duplicates. We cache the
 * followee's inbox (+ optional shared inbox) so an `Undo{Follow}` can be sent
 * without re-resolving the actor, plus their handle / display name / avatar for
 * the following list. `accepted` records that the followee's server answered our
 * Follow with an `Accept`.
 */
import type { CachedActorPresentation } from './types.ts'

import { query } from './connection.ts'

export interface FeedFollowingRecord {
  id: string
  actor_uri: string
  inbox_uri: string
  shared_inbox_uri: string | null
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  accepted: boolean
  notify_on_post: boolean
  created_at: Date
}

export interface FeedFollowingInput {
  actor_uri: string
  inbox_uri: string
  shared_inbox_uri?: string | null
  handle?: string | null
  display_name?: string | null
  avatar_url?: string | null
}

const FEED_FOLLOWING_COLUMNS =
  'id, actor_uri, inbox_uri, shared_inbox_uri, handle, display_name, avatar_url, accepted, notify_on_post, created_at'

/**
 * Insert or update a followee by actor URI. Re-following refreshes the cached
 * inboxes + presentation (handle/name/avatar) without duplicating, and — since a
 * re-follow re-sends the Follow — deliberately does NOT touch `accepted`: an
 * already-established follow stays accepted, a pending one stays pending until
 * its Accept lands.
 */
export const upsertFeedFollowing = async (
  user: string,
  input: FeedFollowingInput,
): Promise<FeedFollowingRecord> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `INSERT INTO feed_following (actor_uri, inbox_uri, shared_inbox_uri, handle, display_name, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (actor_uri)
     DO UPDATE SET inbox_uri = EXCLUDED.inbox_uri,
                   shared_inbox_uri = EXCLUDED.shared_inbox_uri,
                   handle = EXCLUDED.handle,
                   display_name = EXCLUDED.display_name,
                   avatar_url = EXCLUDED.avatar_url
     RETURNING ${FEED_FOLLOWING_COLUMNS}`,
    [
      input.actor_uri,
      input.inbox_uri,
      input.shared_inbox_uri ?? null,
      input.handle ?? null,
      input.display_name ?? null,
      input.avatar_url ?? null,
    ],
  )
  return result.rows[0]
}

/**
 * Refresh a followee's cached presentation from an inbound `Update{Person}`
 * (#1057), so the following list and everything rendered from it stop showing a
 * name the actor has since changed. Returns whether such a followee existed.
 * Presentation columns only — never the cached inbox URIs (see
 * `updateFeedFollowerPresentation`).
 */
export const updateFeedFollowingPresentation = async (
  user: string,
  actorUri: string,
  presentation: CachedActorPresentation,
): Promise<boolean> => {
  const result = await query(
    user,
    `UPDATE feed_following SET handle = $2, display_name = $3, avatar_url = $4
     WHERE actor_uri = $1`,
    [actorUri, presentation.handle, presentation.display_name, presentation.avatar_url],
  )
  return (result.rowCount ?? 0) > 0
}

/** All followees (accepted + pending), newest first, for the owner-facing list. */
export const listFeedFollowing = async (user: string): Promise<FeedFollowingRecord[]> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `SELECT ${FEED_FOLLOWING_COLUMNS} FROM feed_following ORDER BY created_at DESC`,
  )
  return result.rows
}

/** Only accepted followees, oldest first — backs the public `following` collection. */
export const listAcceptedFeedFollowing = async (user: string): Promise<FeedFollowingRecord[]> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `SELECT ${FEED_FOLLOWING_COLUMNS} FROM feed_following WHERE accepted = true ORDER BY created_at ASC`,
  )
  return result.rows
}

/** Count accepted followees (for the following-collection counter). */
export const countAcceptedFeedFollowing = async (user: string): Promise<number> => {
  const result = await query<{ count: string }>(
    user,
    `SELECT COUNT(*)::text AS count FROM feed_following WHERE accepted = true`,
  )
  return Number(result.rows[0].count)
}

export const getFeedFollowing = async (user: string, id: string): Promise<FeedFollowingRecord | null> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `SELECT ${FEED_FOLLOWING_COLUMNS} FROM feed_following WHERE id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

export const getFeedFollowingByActor = async (
  user: string,
  actorUri: string,
): Promise<FeedFollowingRecord | null> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `SELECT ${FEED_FOLLOWING_COLUMNS} FROM feed_following WHERE actor_uri = $1`,
    [actorUri],
  )
  return result.rows[0] ?? null
}

/**
 * Remove a followee by local id, returning the removed row (or null). The
 * returned row carries the cached inbox so the caller can send the `Undo{Follow}`
 * to the right place after the row is gone.
 */
export const removeFeedFollowing = async (user: string, id: string): Promise<FeedFollowingRecord | null> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `DELETE FROM feed_following WHERE id = $1 RETURNING ${FEED_FOLLOWING_COLUMNS}`,
    [id],
  )
  return result.rows[0] ?? null
}

/** Remove a followee by actor URI (e.g. on an inbound `Reject` of our Follow). */
export const removeFeedFollowingByActor = async (user: string, actorUri: string): Promise<boolean> => {
  const result = await query(user, `DELETE FROM feed_following WHERE actor_uri = $1`, [actorUri])
  return (result.rowCount ?? 0) > 0
}

/** Set whether new posts from a followee (by local id) should notify. */
export const updateFeedFollowingNotify = async (
  user: string,
  id: string,
  notifyOnPost: boolean,
): Promise<FeedFollowingRecord | null> => {
  const result = await query<FeedFollowingRecord>(
    user,
    `UPDATE feed_following SET notify_on_post = $1 WHERE id = $2 RETURNING ${FEED_FOLLOWING_COLUMNS}`,
    [notifyOnPost, id],
  )
  return result.rows[0] ?? null
}

/** Mark a pending follow accepted (the followee's server answered with `Accept`). */
export const markFeedFollowingAccepted = async (user: string, actorUri: string): Promise<boolean> => {
  const result = await query(user, `UPDATE feed_following SET accepted = true WHERE actor_uri = $1`, [
    actorUri,
  ])
  return (result.rowCount ?? 0) > 0
}
