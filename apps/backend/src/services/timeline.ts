/**
 * Shared home-timeline read logic, used by the REST `/feed/timeline` route and
 * the MCP `list_timeline` tool (parity).
 *
 * A page is keyset-paginated on `(published_at, id)`; the opaque `next_cursor`
 * encodes that pair. To decide whether a next page exists we fetch one extra row
 * and drop it. `serializeTimelineEntry` maps the stored record (whose `content`
 * is already sanitised at ingest) to the api-spec DTO.
 */
import type { TimelineEntry } from '@aurboda/api-spec'

import type {
  FeedReactionState,
  TimelineCursor,
  TimelineEntryRecord,
  TimelinePageRow,
  TimelineReplyFilter,
} from '../db/index.ts'

import { listFeedReactionsForObjects, listTimelineEntries } from '../db/index.ts'
import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.ts'
import { getSettings } from './settings.ts'

/**
 * The reacted-to object a timeline card represents: a boost card stands for the
 * ORIGINAL Note (its own `object_uri` is the `Announce` id, which nobody can
 * like), so liking a boost likes the post it shows — exactly as on Mastodon.
 */
export const reactionTarget = (record: Pick<TimelineEntryRecord, 'boost_of_uri' | 'object_uri'>): string =>
  record.boost_of_uri ?? record.object_uri

/** Lookup key for "have I reacted to this object": `\`${kind}:${object_uri}\``. */
export const reactionKey = (kind: string, objectUri: string): string => `${kind}:${objectUri}`

/** The set of `${kind}:${object_uri}` keys the reader has reacted to. */
export const toReactionSet = (rows: FeedReactionState[]): Set<string> =>
  new Set(rows.map((row) => reactionKey(row.kind, row.object_uri)))

/** Decode an opaque cursor, or undefined if it's missing/malformed (→ first page). */
const decodeCursor = (cursor: string | undefined): TimelineCursor | undefined => {
  const decoded = decodeKeysetCursor(cursor)
  return decoded && { id: decoded.id, published_at: decoded.ts }
}

export const serializeTimelineEntry = (
  record: TimelineEntryRecord,
  /** URI prefix of the reader's own post objects, to mark replies-to-me. */
  ownObjectPrefix?: string,
  /** `${kind}:${object_uri}` keys the reader has reacted to (see `toReactionSet`). */
  reactions?: ReadonlySet<string>,
): TimelineEntry => ({
  actor_uri: record.actor_uri,
  avatar_url: record.avatar_url,
  // A boost card: the author fields above describe the ORIGINAL post, these two
  // the followee who boosted it (Mastodon's "X boosted" line).
  ...(record.boost_of_uri == null || record.boosted_by_actor_uri == null
    ? {}
    : {
        boost_of_uri: record.boost_of_uri,
        boosted_by: {
          actor_uri: record.boosted_by_actor_uri,
          display_name: record.boosted_by_display_name,
          handle: record.boosted_by_handle,
        },
      }),
  // Present only when true, like `mentions_me` — an absent flag is "not reacted".
  ...(reactions?.has(reactionKey('announce', reactionTarget(record))) ? { boosted: true } : {}),
  content: record.content,
  display_name: record.display_name,
  handle: record.handle,
  id: record.id,
  ...(reactions?.has(reactionKey('like', reactionTarget(record))) ? { liked: true } : {}),
  ...(record.in_reply_to_uri == null
    ? {}
    : {
        in_reply_to_mine: ownObjectPrefix != null && record.in_reply_to_uri.startsWith(ownObjectPrefix),
        in_reply_to_uri: record.in_reply_to_uri,
      }),
  ...(record.mentions_me ? { mentions_me: true } : {}),
  ...(record.images == null || record.images.length === 0 ? {} : { images: record.images }),
  object_uri: record.object_uri,
  published_at: record.published_at.toISOString(),
  received_at: record.received_at.toISOString(),
  ...(record.structured == null ? {} : { structured: record.structured }),
  url: record.url,
})

/** Fetch a keyset page of raw timeline rows — the one DB dependency of `getTimelinePage`. */
export type TimelineFetcher = (
  user: string,
  limit: number,
  cursor?: TimelineCursor,
  replies?: TimelineReplyFilter,
) => Promise<TimelinePageRow[]>

/** The URI prefix of a user's own post objects on this instance. */
export const ownObjectPrefix = (origin: string, user: string): string =>
  `${origin.replace(/\/+$/, '')}/users/${encodeURIComponent(user)}/feed/`

/**
 * A user's own ActivityPub actor URI on this instance — the same string
 * `ctx.getActorUri(user)` produces, but derivable without a Fedify context (and
 * so usable from the pure/ingest paths that only carry the origin).
 */
export const ownActorUri = (origin: string, user: string): string =>
  `${origin.replace(/\/+$/, '')}/users/${encodeURIComponent(user)}`

/** Batched "which of these objects have I reacted to" lookup — one query per page. */
export type ReactionsFetcher = (user: string, objectUris: string[]) => Promise<FeedReactionState[]>

export interface TimelinePageOpts {
  /**
   * Web origin. When set, the page applies the `timeline_show_replies` setting
   * (replies to others hidden unless enabled; replies to the reader's own posts
   * always shown, marked `in_reply_to_mine`). Absent: no reply filtering.
   */
  origin?: string
  fetchEntries?: TimelineFetcher
  /** Injected settings lookup (defaults to the real one) for offline tests. */
  loadSettings?: (user: string) => Promise<{ timeline_show_replies?: boolean } | null>
  /** Injected reaction-state lookup (defaults to the real one) for offline tests. */
  fetchReactions?: ReactionsFetcher
}

/**
 * The reader's own like/boost state for a page of rows. Best-effort: reaction
 * flags are presentation, so a failed lookup yields an unmarked page rather than
 * failing the whole timeline read (same posture as the settings lookup above).
 */
export const loadReactionsForRows = async (
  user: string,
  rows: Pick<TimelineEntryRecord, 'boost_of_uri' | 'object_uri'>[],
  fetchReactions: ReactionsFetcher = listFeedReactionsForObjects,
): Promise<Set<string>> => {
  if (rows.length === 0) return new Set()
  const uris = [...new Set(rows.map((row) => reactionTarget(row)))]
  return toReactionSet(await fetchReactions(user, uris).catch(() => []))
}

/**
 * One page of the home timeline (newest first) plus the cursor for the next page
 * (null when there are no more). Fetches `limit + 1` rows to detect a next page
 * without a second query. The row fetcher is injected (defaulting to the real DB
 * query) so the pagination + cursor logic is unit-testable without a database.
 */
export const getTimelinePage = async (
  user: string,
  limit: number,
  cursor?: string,
  opts: TimelinePageOpts = {},
): Promise<{ entries: TimelineEntry[]; next_cursor: string | null }> => {
  const fetchEntries = opts.fetchEntries ?? listTimelineEntries
  let replies: TimelineReplyFilter | undefined
  let prefix: string | undefined
  if (opts.origin != null) {
    const settings = await (opts.loadSettings ?? getSettings)(user).catch(() => null)
    prefix = ownObjectPrefix(opts.origin, user)
    replies = { own_object_prefix: prefix, show_replies: settings?.timeline_show_replies === true }
  }
  const rows = await fetchEntries(user, limit + 1, decodeCursor(cursor), replies)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const reactions = await loadReactionsForRows(user, page, opts.fetchReactions)
  return {
    entries: page.map((row) => serializeTimelineEntry(row, prefix, reactions)),
    next_cursor: hasMore && last ? encodeKeysetCursor(last.cursor_ts, last.id) : null,
  }
}
