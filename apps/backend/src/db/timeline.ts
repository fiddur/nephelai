/**
 * The user's home timeline: posts received from the actors they follow (inbound
 * ActivityPub `Create`, replaced on `Update`, removed on `Delete`).
 *
 * Stored per-user, keyed by a local `id`, with the remote Note's id as a UNIQUE
 * `object_uri` so a re-delivery or edit upserts rather than duplicating. `content`
 * is the remote HTML **after** server-side sanitisation (the ingest path is
 * responsible for cleaning untrusted fediverse HTML before it reaches here).
 * Ordering + pagination is keyset by `(published_at DESC, id DESC)`.
 */
import type { FeedStructuredPost, TimelineImage } from '@aurboda/api-spec'

import type { CachedActorPresentation } from './types.ts'

import { query } from './connection.ts'

export interface TimelineEntryRecord {
  id: string
  object_uri: string
  actor_uri: string
  handle: string | null
  display_name: string | null
  avatar_url: string | null
  content: string
  url: string | null
  published_at: Date
  received_at: Date
  /** The `inReplyTo` object id when the post is a reply, or null for a top-level post. */
  in_reply_to_uri: string | null
  /** Whether the post carries a Mention tag for the timeline owner. */
  mentions_me: boolean
  /** Native structured payload from an Aurboda peer, or null for non-Aurboda posts. */
  structured: FeedStructuredPost | null
  /** Image attachments (rendered chart / route map, or a Mastodon photo), or null. */
  images: TimelineImage[] | null
  /**
   * On a BOOST card, the id of the original Note that was announced (this row's
   * `object_uri` is the `Announce` activity id, and its author/content columns
   * describe the original post). NULL on a direct entry.
   */
  boost_of_uri: string | null
  /** On a boost card, the followee who boosted it. NULL on a direct entry. */
  boosted_by_actor_uri: string | null
  boosted_by_handle: string | null
  boosted_by_display_name: string | null
}

export interface TimelineEntryInput {
  object_uri: string
  actor_uri: string
  handle?: string | null
  display_name?: string | null
  avatar_url?: string | null
  /** Already-sanitised HTML. */
  content: string
  url?: string | null
  published_at: Date
  in_reply_to_uri?: string | null
  /** Whether the post carries a Mention tag for the timeline owner. */
  mentions_me?: boolean
  /** Native structured payload fetched from an Aurboda peer on ingest, if any. */
  structured?: FeedStructuredPost | null
  /** Image attachments captured from the delivered Note, if any. */
  images?: TimelineImage[] | null
  /** Set only for a BOOST card — the announced Note's id (see the record type). */
  boost_of_uri?: string | null
  boosted_by_actor_uri?: string | null
  boosted_by_handle?: string | null
  boosted_by_display_name?: string | null
}

/** Opaque keyset cursor: the last row's `(published_at, id)`. */
export interface TimelineCursor {
  /** `published_at` as Postgres text (µs precision) — see `cursor_ts`. */
  published_at: string
  id: string
}

/**
 * A listing row plus the exact keyset position it sits at: `published_at`
 * rendered by Postgres itself, at the microsecond precision the page predicate
 * compares at. `pg` parses `timestamptz` into a ms-only JS `Date`, so the
 * record's own `published_at` cannot address a row inside its millisecond
 * (#1025). Cursor use only — never serialised onto a DTO.
 */
export interface TimelinePageRow extends TimelineEntryRecord {
  cursor_ts: string
}

const TIMELINE_COLUMNS =
  'id, object_uri, actor_uri, handle, display_name, avatar_url, content, url, published_at, received_at, in_reply_to_uri, mentions_me, structured, images, boost_of_uri, boosted_by_actor_uri, boosted_by_handle, boosted_by_display_name'

/**
 * Insert or update a received post by `object_uri`. A re-delivered or edited post
 * (same object id) refreshes the content/presentation in place; `received_at`
 * stays at first receipt while `published_at` tracks the remote timestamp.
 *
 * `inserted` distinguishes a brand-new post from an in-place refresh via the
 * `xmax = 0` trick (freshly-inserted tuples have xmax 0; the ON CONFLICT update
 * path locks the existing row, so its xmax is non-zero). The ingest path uses it
 * to notify live subscribers only about genuinely new posts, not edits.
 */
export const upsertTimelineEntry = async (
  user: string,
  input: TimelineEntryInput,
): Promise<TimelineEntryRecord & { inserted: boolean }> => {
  const result = await query<TimelineEntryRecord & { inserted: boolean }>(
    user,
    `INSERT INTO timeline_entry
       (object_uri, actor_uri, handle, display_name, avatar_url, content, url, published_at, in_reply_to_uri, mentions_me, reply_checked_at, structured, images,
        boost_of_uri, boosted_by_actor_uri, boosted_by_handle, boosted_by_display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12, $13, $14, $15, $16)
     ON CONFLICT (object_uri)
     DO UPDATE SET actor_uri = EXCLUDED.actor_uri,
                   handle = EXCLUDED.handle,
                   display_name = EXCLUDED.display_name,
                   avatar_url = EXCLUDED.avatar_url,
                   content = EXCLUDED.content,
                   url = EXCLUDED.url,
                   published_at = EXCLUDED.published_at,
                   in_reply_to_uri = EXCLUDED.in_reply_to_uri,
                   mentions_me = EXCLUDED.mentions_me,
                   reply_checked_at = NOW(),
                   -- Keep the last-known structured payload if a refresh/edit
                   -- couldn't re-fetch it (transient enrich failure), rather
                   -- than wiping a working chart.
                   structured = COALESCE(EXCLUDED.structured, timeline_entry.structured),
                   -- images always arrives as a concrete array from the ingest
                   -- path, so this COALESCE never actually preserves a prior value
                   -- (an edit that drops attachments clears them) -- it is defensive
                   -- parity with structured for any caller that omits the field.
                   images = COALESCE(EXCLUDED.images, timeline_entry.images),
                   -- A boost row's identity (which Note, boosted by whom) is
                   -- fixed by its Announce id, so a redelivery just restates it.
                   boost_of_uri = EXCLUDED.boost_of_uri,
                   boosted_by_actor_uri = EXCLUDED.boosted_by_actor_uri,
                   boosted_by_handle = EXCLUDED.boosted_by_handle,
                   boosted_by_display_name = EXCLUDED.boosted_by_display_name
     RETURNING ${TIMELINE_COLUMNS}, (xmax = 0) AS inserted`,
    [
      input.object_uri,
      input.actor_uri,
      input.handle ?? null,
      input.display_name ?? null,
      input.avatar_url ?? null,
      input.content,
      input.url ?? null,
      input.published_at,
      input.in_reply_to_uri ?? null,
      input.mentions_me ?? false,
      input.structured == null ? null : JSON.stringify(input.structured),
      input.images == null ? null : JSON.stringify(input.images),
      input.boost_of_uri ?? null,
      input.boosted_by_actor_uri ?? null,
      input.boosted_by_handle ?? null,
      input.boosted_by_display_name ?? null,
    ],
  )
  return result.rows[0]
}

/** What an author's edit propagates to the boost cards of that Note. */
export interface BoostedCopyFields {
  content: string
  url: string | null
  images: TimelineImage[] | null
  structured: FeedStructuredPost | null
}

/**
 * Propagate an author's edit to every BOOST card of one Note, returning how many
 * cards were refreshed. An `Update{Note}` upserts on `object_uri`, which on a
 * boost card is the `Announce` id — so without this the direct entry is edited
 * and every boost of it keeps showing the pre-edit content for good.
 *
 * `published_at` is deliberately untouched: a boost card sorts at BOOST time,
 * not at the original post's (or the edit's) timestamp. `structured` is
 * COALESCEd for the same reason as in the upsert — a transient enrich failure
 * must not wipe a working chart.
 */
export const refreshBoostedCopies = async (
  user: string,
  noteUri: string,
  fields: BoostedCopyFields,
): Promise<number> => {
  const result = await query(
    user,
    `UPDATE timeline_entry
     SET content = $2, url = $3, images = $4, structured = COALESCE($5, structured)
     WHERE boost_of_uri = $1`,
    [
      noteUri,
      fields.content,
      fields.url,
      fields.images == null ? null : JSON.stringify(fields.images),
      fields.structured == null ? null : JSON.stringify(fields.structured),
    ],
  )
  return result.rowCount ?? 0
}

/**
 * Refresh a remote actor's cached presentation on every timeline row that shows
 * them — as a post's AUTHOR and as the BOOSTER of a boost card — after an
 * inbound `Update{Person}` (#1057). Only presentation columns move: which post a
 * row is, and who delivered it, are untouched. The booster line carries no
 * avatar, so only the two text columns exist to refresh there.
 *
 * The two counts stay separate: one row can be refreshed on both statements (a
 * self-boost card, authored and boosted by the same actor), so their sum is not
 * a row count.
 */
export const updateTimelineActorPresentation = async (
  user: string,
  actorUri: string,
  presentation: CachedActorPresentation,
): Promise<{ authors: number; boosters: number }> => {
  const author = await query(
    user,
    `UPDATE timeline_entry SET handle = $2, display_name = $3, avatar_url = $4
     WHERE actor_uri = $1`,
    [actorUri, presentation.handle, presentation.display_name, presentation.avatar_url],
  )
  const booster = await query(
    user,
    `UPDATE timeline_entry SET boosted_by_handle = $2, boosted_by_display_name = $3
     WHERE boosted_by_actor_uri = $1`,
    [actorUri, presentation.handle, presentation.display_name],
  )
  return { authors: author.rowCount ?? 0, boosters: booster.rowCount ?? 0 }
}

/**
 * Whether ANY local row holds a cached copy of this remote actor — as a
 * follower, a followee, a timeline post's author or booster, or a reaction on
 * one of the owner's posts. The gate on the inbound `Update{Person}` refresh
 * (#1111): without it any signed actor can make us dereference their actor
 * document (and run four no-op UPDATEs) by delivering an Update we have no use
 * for. Every table the refresh touches is checked, so a stranger whose reply or
 * Like we DO store still gets their byline refreshed.
 */
export const hasCachedActorPresentation = async (user: string, actorUri: string): Promise<boolean> => {
  const result = await query<{ cached: boolean }>(
    user,
    `SELECT true AS cached
       WHERE EXISTS (SELECT 1 FROM feed_follower WHERE actor_uri = $1)
          OR EXISTS (SELECT 1 FROM feed_following WHERE actor_uri = $1)
          OR EXISTS (SELECT 1 FROM timeline_entry WHERE actor_uri = $1 OR boosted_by_actor_uri = $1)
          OR EXISTS (SELECT 1 FROM feed_post_reaction WHERE actor_uri = $1)`,
    [actorUri],
  )
  return result.rows.length > 0
}

/** Reply visibility for a timeline page (from the `timeline_show_replies` setting). */
export interface TimelineReplyFilter {
  /**
   * When false, only replies to posts that are NOT in this timeline are
   * excluded. A BOOST card never counts as a reply: it inherits the boosted
   * Note's `in_reply_to_uri`, but the card is the booster's boost, not their
   * reply — Mastodon shows reblogs of replies either way.
   */
  show_replies: boolean
  /**
   * URI prefix of the reader's OWN post objects (`{origin}/users/{me}/feed/`):
   * a reply whose target starts with it is a reply to the reader and always
   * shows. LIKE wildcards in it are escaped here.
   */
  own_object_prefix: string
}

/** Escape LIKE's own wildcards so a prefix match is a literal prefix match. */
export const escapeLike = (s: string): string => s.replaceAll(/[%_\\]/g, (c) => `\\${c}`)

/**
 * The "does this row pass the reader's reply filter" predicate, as one SQL
 * fragment, so the timeline page and the live-notification check (#1062) can
 * never drift apart. `showReplies` / `prefix` are the placeholders of the
 * `boolean` setting and the escaped own-object prefix pattern.
 *
 * With the setting off, a reply still shows when the reader is involved
 * (a reply to their own post, or a Mention of them), when the card is a boost,
 * and when it answers a post that IS in this timeline — a followee continuing
 * their own thread, or two followees talking to each other, which is what
 * Mastodon's home shows. Only replies to posts outside the timeline are hidden.
 */
export const timelineReplyFilterSql = (showReplies: string, prefix: string): string =>
  `(${showReplies}::boolean OR in_reply_to_uri IS NULL OR boost_of_uri IS NOT NULL
      OR mentions_me OR in_reply_to_uri LIKE ${prefix}
      OR EXISTS (SELECT 1 FROM timeline_entry p WHERE p.object_uri = timeline_entry.in_reply_to_uri))`

/** The LIKE pattern matching the reader's own post objects, or a never-matching one. */
const ownObjectPattern = (replies?: TimelineReplyFilter): string =>
  replies == null ? '' : `${escapeLike(replies.own_object_prefix)}%`

/**
 * A page of the home timeline, newest first. Keyset-paginated: pass the previous
 * page's last `(cursor_ts, id)` as `before` to get the next page. Returns up
 * to `limit` rows. Filtering happens in SQL (not post-hoc) so pages stay full
 * and cursors stable whatever the reply setting.
 */
export const listTimelineEntries = async (
  user: string,
  limit: number,
  before?: TimelineCursor,
  replies?: TimelineReplyFilter,
): Promise<TimelinePageRow[]> => {
  const result = await query<TimelinePageRow>(
    user,
    `SELECT ${TIMELINE_COLUMNS}, published_at::text AS cursor_ts FROM timeline_entry
     WHERE ($1::timestamptz IS NULL OR (published_at, id) < ($1::timestamptz, $2::uuid))
       AND ${timelineReplyFilterSql('$4', '$5')}
     ORDER BY published_at DESC, id DESC
     LIMIT $3`,
    [
      before?.published_at ?? null,
      before?.id ?? null,
      limit,
      replies?.show_replies ?? true,
      ownObjectPattern(replies),
    ],
  )
  return result.rows
}

/**
 * Whether one stored entry would appear on the reader's own timeline under
 * `filter` — the SAME predicate the page uses. Backs the live-notification
 * decision (#1062): a reply the reader has chosen not to see must not ping them
 * about a card that isn't there.
 */
export const isTimelineEntryVisible = async (
  user: string,
  id: string,
  filter: TimelineReplyFilter,
): Promise<boolean> => {
  // Nothing is filtered with the setting on, so the query is pure overhead.
  if (filter.show_replies) return true
  const result = await query<{ visible: boolean }>(
    user,
    `SELECT true AS visible FROM timeline_entry
     WHERE id = $1 AND ${timelineReplyFilterSql('$2', '$3')}`,
    [id, filter.show_replies, ownObjectPattern(filter)],
  )
  return result.rows.length > 0
}

/** One timeline entry by its local id, or null. */
export const getTimelineEntryById = async (user: string, id: string): Promise<TimelineEntryRecord | null> => {
  const result = await query<TimelineEntryRecord>(
    user,
    `SELECT ${TIMELINE_COLUMNS} FROM timeline_entry WHERE id = $1`,
    [id],
  )
  return result.rows[0] ?? null
}

/**
 * One timeline entry by the remote object's id, or null. Backs the boost
 * dedupe: an announced Note that is ALREADY a direct entry gets no boost card
 * (Mastodon hides a reblog of a post already in the feed).
 */
export const getTimelineEntryByObjectUri = async (
  user: string,
  objectUri: string,
): Promise<TimelineEntryRecord | null> => {
  const result = await query<TimelineEntryRecord>(
    user,
    `SELECT ${TIMELINE_COLUMNS} FROM timeline_entry WHERE object_uri = $1`,
    [objectUri],
  )
  return result.rows[0] ?? null
}

/**
 * The replies this instance holds for one object, oldest first — the comments
 * under one of the owner's own posts. These are ordinary timeline rows: any
 * actor's Note that replied to an existing own post is admitted on ingest
 * (#1060), so no network is involved in reading them back.
 *
 * Boost cards are excluded: a boost copies the announced Note's
 * `in_reply_to_uri`, so a followee's boost of somebody's reply to this post
 * would otherwise list that reply a second time, under the wrong byline.
 */
export const listTimelineRepliesTo = async (
  user: string,
  objectUri: string,
  limit: number,
): Promise<TimelineEntryRecord[]> => {
  const result = await query<TimelineEntryRecord>(
    user,
    `SELECT ${TIMELINE_COLUMNS} FROM timeline_entry
     WHERE in_reply_to_uri = $1 AND boost_of_uri IS NULL
     ORDER BY published_at ASC, id ASC
     LIMIT $2`,
    [objectUri, limit],
  )
  return result.rows
}

/** How many replies one object has, per object — the batched form for a feed page. */
export interface TimelineReplyCount {
  in_reply_to_uri: string
  count: number
}

/**
 * Reply tallies for a whole page of the owner's posts — ONE grouped query, so
 * the feed listing never pays a count per post. Objects with no replies are
 * simply absent from the result. Boost cards are excluded, exactly as in
 * {@link listTimelineRepliesTo}, so the count matches the list.
 */
export const countTimelineRepliesTo = async (
  user: string,
  objectUris: string[],
): Promise<TimelineReplyCount[]> => {
  if (objectUris.length === 0) return []
  const result = await query<TimelineReplyCount>(
    user,
    `SELECT in_reply_to_uri, count(*)::int AS count FROM timeline_entry
     WHERE in_reply_to_uri = ANY($1::text[]) AND boost_of_uri IS NULL
     GROUP BY in_reply_to_uri`,
    [objectUris],
  )
  return result.rows
}

/** A legacy entry whose reply/Mention state is unknown (pre-#1060 ingest). */
export interface ReplyUncheckedEntry {
  id: string
  object_uri: string
}

/** Newest legacy entries still lacking a reply check, for the lazy backfill. */
export const listReplyUncheckedEntries = async (
  user: string,
  limit: number,
): Promise<ReplyUncheckedEntry[]> => {
  const result = await query<ReplyUncheckedEntry>(
    user,
    `SELECT id, object_uri FROM timeline_entry
     WHERE reply_checked_at IS NULL
     ORDER BY received_at DESC
     LIMIT $1`,
    [limit],
  )
  return result.rows
}

/** Store a backfilled reply/Mention state and stamp the entry checked. */
export const setTimelineEntryReplyInfo = async (
  user: string,
  id: string,
  inReplyToUri: string | null,
  mentionsMe: boolean,
): Promise<void> => {
  await query(
    user,
    `UPDATE timeline_entry
     SET in_reply_to_uri = $2, mentions_me = $3, reply_checked_at = NOW()
     WHERE id = $1`,
    [id, inReplyToUri, mentionsMe],
  )
}

/**
 * Stamp an entry checked WITHOUT touching its reply/Mention state — for a
 * backfill fetch that failed (post gone, authorized-fetch instance, host down):
 * whatever the row already says must never be clobbered by a non-answer.
 */
export const markTimelineEntryReplyChecked = async (user: string, id: string): Promise<void> => {
  await query(user, `UPDATE timeline_entry SET reply_checked_at = NOW() WHERE id = $1`, [id])
}

/**
 * Remove a received post by its remote object id (on an inbound `Delete`), scoped
 * to the actor that authored it. The `actor_uri` guard is an authorization check:
 * an inbound `Delete` is only signed by *some* actor, so without it any actor
 * could evict another author's post from the timeline by its (guessable) id.
 *
 * Boost cards of that Note go with it: a boost row's `actor_uri` is the ORIGINAL
 * author (the row renders their post), so the same authorization scope covers
 * both — the author deleting their post retracts every followee's boost of it,
 * and nobody else's `Delete` touches either.
 */
export const deleteTimelineEntryByUri = async (
  user: string,
  objectUri: string,
  actorUri: string,
): Promise<boolean> => {
  const result = await query(
    user,
    `DELETE FROM timeline_entry WHERE actor_uri = $2 AND (object_uri = $1 OR boost_of_uri = $1)`,
    [objectUri, actorUri],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Remove one boost card by its `Announce` id, scoped to the booster — the
 * inbound `Undo{Announce}` path. Never touches the original post's own entry
 * (which is keyed on the Note id, not the Announce id).
 */
export const deleteBoostEntry = async (
  user: string,
  announceUri: string,
  boosterActorUri: string,
): Promise<boolean> => {
  const result = await query(
    user,
    `DELETE FROM timeline_entry WHERE object_uri = $1 AND boosted_by_actor_uri = $2`,
    [announceUri, boosterActorUri],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Remove every timeline row that exists *because of* an actor, on
 * `Undo{Follow}`/unfollow: their own posts (direct entries they authored) and
 * every post they boosted into the timeline. Someone ELSE's boost of one of
 * their posts stays — it's in the timeline on the booster's account, and that
 * follow is untouched.
 */
export const deleteTimelineEntriesByActor = async (user: string, actorUri: string): Promise<number> => {
  const result = await query(
    user,
    `DELETE FROM timeline_entry
     WHERE (actor_uri = $1 AND boost_of_uri IS NULL) OR boosted_by_actor_uri = $1`,
    [actorUri],
  )
  return result.rowCount ?? 0
}

/** The fields a lazy retro-enrichment attempt needs (#996). */
export interface UnenrichedTimelineEntry {
  id: string
  object_uri: string
  images: TimelineImage[] | null
}

/**
 * Aurboda-shaped entries with no structured payload and no retro-enrichment
 * attempt yet, newest first (#996): entries ingested before enrichment shipped,
 * or whose ingest-time enrichment failed transiently. The LIKE is a coarse SQL
 * prefilter — the service re-validates with `parseAurbodaFeedUrl` before
 * fetching anything.
 */
export const listUnenrichedAurbodaEntries = async (
  user: string,
  limit: number,
): Promise<UnenrichedTimelineEntry[]> => {
  const result = await query<UnenrichedTimelineEntry>(
    user,
    `SELECT id, object_uri, images FROM timeline_entry
     WHERE structured IS NULL AND enrich_attempted_at IS NULL
       AND object_uri LIKE '%/users/%/feed/%'
     ORDER BY published_at DESC, id DESC
     LIMIT $1`,
    [limit],
  )
  return result.rows
}

/**
 * Record a retro-enrichment attempt (#996): store the payload when one was
 * obtained (never overwrite an existing one with NULL) and stamp
 * `enrich_attempted_at` either way, so an entry is retried at most once — a
 * later `Update` redelivery still re-enriches through the ingest path.
 */
export const setTimelineEntryStructured = async (
  user: string,
  id: string,
  structured: FeedStructuredPost | null,
): Promise<void> => {
  await query(
    user,
    `UPDATE timeline_entry
     SET structured = COALESCE($2, structured), enrich_attempted_at = NOW()
     WHERE id = $1`,
    [id, structured == null ? null : JSON.stringify(structured)],
  )
}

/**
 * Record a TRANSIENT retro-enrichment failure (#1014): bump the attempt counter
 * and, once `maxAttempts` is reached, stamp `enrich_attempted_at` so the entry
 * leaves the candidate set — a permanently unreachable peer must not hold the
 * head of the newest-first retry queue forever. Below the cap the entry stays
 * eligible for a later read's retry.
 */
export const markEnrichTransientFailure = async (
  user: string,
  id: string,
  maxAttempts: number,
): Promise<void> => {
  await query(
    user,
    `UPDATE timeline_entry
     SET enrich_attempts = enrich_attempts + 1,
         enrich_attempted_at = CASE WHEN enrich_attempts + 1 >= $2 THEN NOW() ELSE enrich_attempted_at END
     WHERE id = $1`,
    [id, maxAttempts],
  )
}
