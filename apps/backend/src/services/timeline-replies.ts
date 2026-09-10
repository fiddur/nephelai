/**
 * Reply threads, from both directions — shared by the REST `/feed` router and
 * the MCP feed tools (parity).
 *
 * **A timeline card's thread** is a live, bounded snapshot of the ORIGIN's
 * `replies` collection (`remote-replies.ts`), with the reader's own replies to
 * that same object merged in. The merge is what makes a reply feel sent: the
 * origin need not list our Note (Mastodon adds it only once it has processed
 * the `Create`, and a followers-only thread may never expose it at all), and a
 * thread that hides its own reader's reply reads as if it were never posted.
 *
 * **An own post's comments** are the opposite: no network at all. Any actor's
 * Note replying to one of the owner's still-existing posts is already admitted
 * to the timeline on ingest (#1060), so the comments under a post are just the
 * `timeline_entry` rows pointing at it — carrying the reader's like/boost state
 * and repliable in turn, like any other card.
 */
import type { FeedPost, TimelineEntry, TimelineReply } from '@aurboda/api-spec'

import type { FeedPostRecord } from '../db/index.ts'
import type { RemoteRepliesDeps } from './activitypub/remote-replies.ts'

import { listReplyPostsTo, listTimelineRepliesTo } from '../db/index.ts'
import { fetchRemoteReplies } from './activitypub/remote-replies.ts'
import { renderReplyContent } from './activitypub/reply-object.ts'
import { loadReactionsForRows, ownActorUri, ownObjectPrefix, serializeTimelineEntry } from './timeline.ts'

/** Newest-first cap on the comments listed under one of the owner's own posts. */
export const MAX_POST_REPLIES = 100

/** The reader's own presentation on their replies, derived from the instance origin. */
export interface OwnReplyAuthor {
  actor_uri: string
  handle: string | null
}

/**
 * How the reader appears as a reply author: their actor URI on this instance
 * and the `@user@host` handle a follower's server would resolve for them.
 */
export const ownReplyAuthor = (origin: string, user: string): OwnReplyAuthor => {
  let host: string | null
  try {
    host = new URL(origin).host
  } catch {
    host = null
  }
  return { actor_uri: ownActorUri(origin, user), handle: host == null ? null : `@${user}@${host}` }
}

/**
 * One of the reader's own reply posts as a thread-snapshot entry. `content` is
 * the SAME HTML `buildReplyNote` federates (both go through
 * `renderReplyContent`), so the reader sees exactly what the thread's other
 * readers will.
 */
export const ownReplyToTimelineReply = (
  post: FeedPostRecord,
  objectPrefix: string,
  author: OwnReplyAuthor,
): TimelineReply => {
  const objectUri = `${objectPrefix}${post.id}`
  return {
    actor_uri: author.actor_uri,
    content: renderReplyContent(post),
    display_name: null,
    handle: author.handle,
    mine: true,
    object_uri: objectUri,
    published_at: post.created_at.toISOString(),
    url: objectUri,
  }
}

/** Oldest-first by `published_at`; entries without one keep their relative order last. */
const byPublished = (a: TimelineReply, b: TimelineReply): number => {
  if (a.published_at == null) return b.published_at == null ? 0 : 1
  if (b.published_at == null) return -1
  return Date.parse(a.published_at) - Date.parse(b.published_at)
}

/**
 * Merge the reader's own replies into the origin's snapshot. A reply the origin
 * already lists is kept as the ORIGIN's copy (that is what everyone else sees)
 * and only marked `mine`; one the origin doesn't list yet is appended, oldest
 * first. Pure: no network, no database.
 */
export const mergeOwnReplies = (fetched: TimelineReply[], own: TimelineReply[]): TimelineReply[] => {
  const mine = new Set(own.map((reply) => reply.object_uri).filter((uri) => uri != null))
  const listed = new Set(fetched.map((reply) => reply.object_uri).filter((uri) => uri != null))
  return [
    ...fetched.map((reply) =>
      reply.object_uri != null && mine.has(reply.object_uri) ? { ...reply, mine: true } : reply,
    ),
    ...own.filter((reply) => reply.object_uri == null || !listed.has(reply.object_uri)).sort(byPublished),
  ]
}

/** Injectable collaborators for `getThreadSnapshot` (real DB + network by default). */
export interface ThreadSnapshotDeps {
  fetchRemote?: (
    objectUri: string,
    deps?: RemoteRepliesDeps,
  ) => Promise<{ fetched: boolean; partial: boolean; replies: TimelineReply[] }>
  listOwn?: (user: string, objectUri: string) => Promise<FeedPostRecord[]>
}

/**
 * The thread under one timeline post: the origin's snapshot plus the reader's
 * own replies. `fetched: false` means the origin's thread couldn't be read at
 * all — an empty list then means "unknown", not "nothing there" (#1065). Our
 * own replies still render either way.
 *
 * Best-effort throughout: a failed own-reply lookup costs the `mine` merge, not
 * the thread.
 */
export const getThreadSnapshot = async (
  user: string,
  origin: string,
  objectUri: string,
  deps: ThreadSnapshotDeps = {},
): Promise<{ fetched: boolean; partial: boolean; replies: TimelineReply[] }> => {
  const remote = await (deps.fetchRemote ?? fetchRemoteReplies)(objectUri).catch(() => ({
    fetched: false,
    partial: true,
    replies: [] as TimelineReply[],
  }))
  const ownPosts = await (deps.listOwn ?? listReplyPostsTo)(user, objectUri).catch(() => [])
  const author = ownReplyAuthor(origin, user)
  const prefix = ownObjectPrefix(origin, user)
  const own = ownPosts.map((post) => ownReplyToTimelineReply(post, prefix, author))
  return { ...remote, replies: mergeOwnReplies(remote.replies, own) }
}

/**
 * The comments this instance holds under one of the owner's own posts, oldest
 * first. Full timeline entries, so each carries the reader's like/boost state
 * and can be replied to in turn.
 */
export const listOwnPostReplies = async (
  user: string,
  origin: string,
  postId: string,
  limit: number = MAX_POST_REPLIES,
): Promise<TimelineEntry[]> => {
  const prefix = ownObjectPrefix(origin, user)
  const rows = await listTimelineRepliesTo(user, `${prefix}${postId}`, limit)
  const reactions = await loadReactionsForRows(user, rows)
  return rows.map((row) => serializeTimelineEntry(row, prefix, reactions))
}

/**
 * Attach `reply_count` to a page of serialised posts from ONE grouped count
 * query, keyed by each post's own object URI. Best-effort, like the reaction
 * counts it sits beside: a failed lookup leaves the page uncounted.
 */
export const withReplyCounts = async (
  user: string,
  origin: string,
  posts: FeedPost[],
  fetchCounts: (user: string, objectUris: string[]) => Promise<{ in_reply_to_uri: string; count: number }[]>,
): Promise<FeedPost[]> => {
  if (posts.length === 0) return posts
  const prefix = ownObjectPrefix(origin, user)
  const rows = await fetchCounts(
    user,
    posts.map((post) => `${prefix}${post.id}`),
  ).catch(() => [])
  const tally = new Map(rows.map((row) => [row.in_reply_to_uri, row.count]))
  return posts.map((post) => ({ ...post, reply_count: tally.get(`${prefix}${post.id}`) ?? 0 }))
}
