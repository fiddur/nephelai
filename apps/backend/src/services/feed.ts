/**
 * Shared feed business logic used by both the REST `/feed` router and the MCP
 * feed tools (parity), and by the ActivityPub delivery/object/image paths.
 *
 * The one thing every feed surface needs from a stored post is its activity
 * resolved to the **merged span** — the same window the activity detail view and
 * the share dialog present. A feed post stores only `activity_id` (the plain
 * anchor uuid), so resolving the merged window here (via `resolveActivityWindow`,
 * the exact logic the `merged:` detail view uses) keeps three things consistent:
 *
 * - what the user *saw and chose to share* (the merged duration/metrics),
 * - what we *deliver / serve / list* over ActivityPub (the Note's scalars, the
 *   chart/route images), and
 * - what the web feed view shows and offers when editing.
 *
 * Resolving at query time (rather than persisting a denormalised span on the
 * post) means a later edit to the underlying activities stays reflected, per the
 * repo's "reference by id, resolve at query time" principle.
 */
import type { FeedPost } from '@aurboda/api-spec'

import type {
  Activity,
  FeedPostCursor,
  FeedPostReactionCount,
  FeedPostRecord,
  TimelineReplyCount,
} from '../db/index.ts'

import {
  countFeedPostReactions,
  countTimelineRepliesTo,
  getActivityById,
  listFeedPosts,
} from '../db/index.ts'
import { resolveActivityScalars } from './activitypub/feed-activity.ts'
import { feedPostContent, formatActivityWindow } from './activitypub/object.ts'
import {
  assembleStructuredActivity,
  resolveStructuredRoute,
  resolveStructuredSeries,
} from './feed-structured-activity.ts'
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.ts'
import { resolveActivityWindow } from './queries/index.ts'
import { getSettings } from './settings.ts'
import { withReplyCounts } from './timeline-replies.ts'

/** Options for `serializeFeedPost`. */
export interface SerializeFeedPostOpts {
  /**
   * Attach the FULL structured payload (typed metrics + inline series + route),
   * assembled by the same helper the public structured endpoint uses, so the
   * author's own card renders exactly what a subscribing peer renders (#1008).
   * Off by default: MCP listing tools skip the weight, and the public profile
   * listing attaches structured through its shared per-post LRU instead of
   * this opt-in.
   */
  includeStructured?: boolean
  /**
   * The author's already-resolved settings (only `device_timezone` is read).
   * Listing callers resolve settings ONCE per request and pass them here instead
   * of paying one settings query per post; `null` means "known unavailable".
   * Left `undefined`, the post resolves them itself.
   */
  settings?: { device_timezone?: string } | null
}

/**
 * A feed post's shared activity, resolved for presentation/delivery: the title
 * and type from the anchor row, and the **merged-span** window. Structurally a
 * superset-compatible shape for the ActivityPub `DeliverableActivity`.
 */
export interface ResolvedFeedActivity {
  activity_type: string
  start_time: Date
  end_time?: Date
  title?: string
}

/**
 * Normalize a request's `message` for storage: `undefined` stays `undefined`
 * (a PATCH leaves the stored value unchanged), a whitespace-only string becomes
 * `null` (clears it), anything else is stored trimmed. Shared by the REST
 * router and the MCP tools so both surfaces behave identically.
 */
export const normalizeFeedMessage = (message?: string): string | null | undefined => {
  if (message === undefined) return undefined
  const trimmed = message.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Expand an already-fetched activity to its merged span (no refetch). Used on the
 * share path, where the handler already loaded the anchor for its 404 check.
 * A plain (non-overlapping) activity passes through with its own window.
 */
export const expandFeedActivityWindow = async (
  user: string,
  activity: Activity,
): Promise<ResolvedFeedActivity> => {
  const window = await resolveActivityWindow(user, activity, true)
  return {
    activity_type: activity.activity_type,
    end_time: window.end_time,
    start_time: window.start_time,
    title: activity.title,
  }
}

/**
 * Resolve a post's stored `activity_id` to its merged-span activity, or null if
 * the activity is missing/deleted. The single source of the shared window for
 * delivery, the object dispatcher, the outbox, and the rendered images.
 */
export const resolveFeedActivity = async (
  user: string,
  activityId: string,
): Promise<ResolvedFeedActivity | null> => {
  const activity = await getActivityById(user, activityId)
  if (activity == null) return null
  return expandFeedActivityWindow(user, activity)
}

/**
 * The presentation pieces derived from a post's resolved activity: the
 * federated `content` HTML, the typed scalar `metrics`, and (per
 * `SerializeFeedPostOpts`) the full structured payload.
 */
const resolveActivityPresentation = async (
  user: string,
  record: FeedPostRecord,
  activity: ResolvedFeedActivity,
  opts: SerializeFeedPostOpts,
): Promise<Pick<FeedPost, 'content' | 'metrics' | 'structured'>> => {
  const scalars = await resolveActivityScalars(
    user,
    { end_time: activity.end_time, start_time: activity.start_time },
    record.included_metrics,
  )
  const settings = opts.settings !== undefined ? opts.settings : await getSettings(user).catch(() => null)
  const content = feedPostContent(activity.title, activity.activity_type, scalars, {
    message: record.message ?? undefined,
    windowLabel: formatActivityWindow(activity.start_time, activity.end_time, settings?.device_timezone),
  }).content
  let structured: FeedPost['structured']
  if ((opts.includeStructured ?? false) && record.kind === 'activity') {
    const series = activity.end_time
      ? await resolveStructuredSeries(user, record.series_metrics, activity.start_time, activity.end_time)
      : []
    // Route rides along under the same opt-in (and from the same GPS track) as
    // the rendered route.png — mirrors `resolveStructuredContent`.
    const route =
      record.include_map && activity.end_time
        ? await resolveStructuredRoute(user, activity.start_time, activity.end_time)
        : []
    structured = assembleStructuredActivity(activity, scalars, series, record.message, route)
  }
  return {
    content,
    // The typed scalar values (same shape as the structured-enrichment payload),
    // so the web renders a native stat grid instead of parsing the content HTML.
    metrics: scalars.map(({ key, unit, value }) => ({
      key,
      value,
      ...(unit === undefined ? {} : { unit }),
    })),
    structured,
  }
}

/**
 * What a `reply` post answers — the target object, its author, and the handle
 * snapshot naming the federated `Mention`. Every other kind exposes none of it.
 */
const replyTargetFields = (
  record: FeedPostRecord,
): Pick<FeedPost, 'in_reply_to_actor_uri' | 'in_reply_to_handle' | 'in_reply_to_uri'> =>
  record.kind === 'reply'
    ? {
        in_reply_to_actor_uri: record.in_reply_to_actor_uri ?? undefined,
        in_reply_to_handle: record.in_reply_to_handle ?? undefined,
        in_reply_to_uri: record.in_reply_to_uri ?? undefined,
      }
    : {}

/**
 * Serialise a stored feed post for the owner-facing REST/MCP surface, enriching
 * it with the shared activity's title/type, the **merged-span** window, and the
 * exact `content` HTML the post federates with — all resolved at query time. A
 * client can therefore render the post WYSIWYG (as it appears on Mastodon) and
 * re-open the share dialog without a second per-post activity fetch.
 *
 * The `content` is the same server-built, HTML-escaped string the delivered Note
 * carries (via `feedPostContent`), so the web renders it directly. (When the feed
 * later renders *remote* actors' posts, that untrusted content will need
 * sanitising — this owner-facing content does not.)
 */
export const serializeFeedPost = async (
  user: string,
  record: FeedPostRecord,
  opts: SerializeFeedPostOpts = {},
): Promise<FeedPost> => {
  const activity = record.activity_id ? await resolveFeedActivity(user, record.activity_id) : null
  const { content, metrics, structured } = activity
    ? await resolveActivityPresentation(user, record, activity, opts)
    : { content: undefined, metrics: undefined, structured: undefined }
  return {
    activity_end_time: activity?.end_time?.toISOString(),
    activity_id: record.activity_id,
    activity_start_time: activity?.start_time.toISOString(),
    activity_title: activity?.title,
    activity_type: activity?.activity_type,
    // The stored article payload (title + default window + blocks); present only
    // for `article` posts, which carry no activity and so no resolved `content`.
    article: record.article ?? undefined,
    autoshare_rule_id: record.autoshare_rule_id ?? undefined,
    // The stored challenge link payload; present only for `challenge` posts.
    challenge: record.challenge ?? undefined,
    content,
    created_at: record.created_at.toISOString(),
    id: record.id,
    include_chart: record.include_chart,
    include_map: record.include_map,
    included_metrics: record.included_metrics,
    ...replyTargetFields(record),
    kind: record.kind,
    message: record.message ?? undefined,
    metrics,
    series_metrics: record.series_metrics,
    structured,
    updated_at: record.updated_at.toISOString(),
    visibility: record.visibility,
  }
}

/** Fetch a keyset page of raw feed-post rows — the one DB dependency of `getFeedPage`. */
export type FeedPostsFetcher = (
  user: string,
  limit: number,
  before?: FeedPostCursor,
) => Promise<FeedPostRecord[]>

/** Batched like/boost tallies for a page of posts — the second DB dependency of `getFeedPage`. */
export type FeedReactionCountsFetcher = (user: string, postIds: string[]) => Promise<FeedPostReactionCount[]>

/** Batched reply tallies for a page of posts, keyed by each post's object URI. */
export type FeedReplyCountsFetcher = (user: string, objectUris: string[]) => Promise<TimelineReplyCount[]>

/** Options for `getFeedPage`: the serialisation opts plus what the counts need. */
export interface FeedPageOpts extends SerializeFeedPostOpts {
  /**
   * Web origin. Present, each post's `reply_count` is looked up by its object
   * URI (one grouped query per page); absent, the page carries no reply counts.
   */
  origin?: string
}

/**
 * Attach `like_count` / `boost_count` to a page of serialised posts from ONE
 * grouped count query. Best-effort: the counts are decoration, so a failed
 * lookup leaves the page uncounted rather than failing the listing.
 */
const withReactionCounts = async (
  user: string,
  posts: FeedPost[],
  fetchCounts: FeedReactionCountsFetcher,
): Promise<FeedPost[]> => {
  if (posts.length === 0) return posts
  const rows = await fetchCounts(
    user,
    posts.map((post) => post.id),
  ).catch(() => [])
  const tally = new Map<string, number>()
  for (const row of rows) tally.set(`${row.kind}:${row.post_id}`, row.count)
  return posts.map((post) => ({
    ...post,
    boost_count: tally.get(`announce:${post.id}`) ?? 0,
    like_count: tally.get(`like:${post.id}`) ?? 0,
  }))
}

/**
 * One keyset page of the owner's feed (newest first) plus the cursor for the
 * next page — null when there are no more (#1012). Shared by the REST `GET
 * /feed` route and the MCP `list_feed` tool (parity), like `getTimelinePage`
 * for the home timeline: fetch `limit + 1` rows to detect a next page without a
 * second query, serialise the page, and encode the last row's `(created_at,
 * id)` as the opaque cursor. The row fetcher is injected (defaulting to the
 * real DB query) so the pagination logic is unit-testable without a database.
 */
export const getFeedPage = async (
  user: string,
  limit: number,
  cursor: string | undefined,
  opts: FeedPageOpts = {},
  fetchPosts: FeedPostsFetcher = listFeedPosts,
  fetchReactionCounts: FeedReactionCountsFetcher = countFeedPostReactions,
  fetchReplyCounts: FeedReplyCountsFetcher = countTimelineRepliesTo,
): Promise<{ posts: FeedPost[]; next_cursor: string | null }> => {
  const decoded = decodeKeysetCursor(cursor)
  const rows = await fetchPosts(user, limit + 1, decoded && { created_at: decoded.ts, id: decoded.id })
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const posts = await Promise.all(page.map((record) => serializeFeedPost(user, record, opts)))
  // Only the LISTING carries reaction + reply counts (one batched query each per
  // page); single-post responses leave them absent.
  const counted = await withReactionCounts(user, posts, fetchReactionCounts)
  return {
    next_cursor: hasMore && last ? encodeKeysetCursor(last.created_at, last.id) : null,
    posts:
      opts.origin == null ? counted : await withReplyCounts(user, opts.origin, counted, fetchReplyCounts),
  }
}

/**
 * Resolve what a share of `activity` with `selection` WOULD federate (#902):
 * the exact `content` HTML (via the same `feedPostContent` used for delivery
 * and the owner card) and the typed scalars — without creating a post. Backs
 * the Share dialog's live preview, so what the user sees before clicking
 * Share is byte-for-byte what leaves the instance.
 */
export const previewActivityShare = async (
  user: string,
  activity: Activity,
  selection: { included_metrics: string[]; message?: string },
): Promise<{ content: string; metrics: FeedPost['metrics'] }> => {
  const window = await expandFeedActivityWindow(user, activity)
  const scalars = await resolveActivityScalars(
    user,
    { end_time: window.end_time, start_time: window.start_time },
    selection.included_metrics,
  )
  const settings = await getSettings(user).catch(() => null)
  const content = feedPostContent(window.title, window.activity_type, scalars, {
    message: normalizeFeedMessage(selection.message) ?? undefined,
    windowLabel: formatActivityWindow(window.start_time, window.end_time, settings?.device_timezone),
  }).content
  return {
    content,
    metrics: scalars.map(({ key, unit, value }) => ({ key, value, ...(unit === undefined ? {} : { unit }) })),
  }
}
