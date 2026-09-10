/**
 * Ingest a received ActivityPub `Note` (a post from an actor the user follows)
 * into the home-timeline store.
 *
 * Two concerns live here, both testable in isolation:
 *
 * 1. `sanitizeRemoteHtml` — remote fediverse HTML is **untrusted** and is rendered
 *    with `dangerouslySetInnerHTML` on the web, so it MUST be sanitised before it
 *    is stored. We keep only the small tag set Mastodon-style content uses and
 *    force safe link attributes; scripts, styles, event handlers, iframes, images,
 *    and every other attribute are dropped.
 * 2. `noteToTimelineInput` — map a Fedify `Note` + the (already-known) author to a
 *    `TimelineEntryInput`, or null if it lacks the id/published we need.
 *
 * The inbox handler that calls these (in `federation.ts`) is thin: it checks the
 * sender is a followed, accepted actor and upserts the result.
 */
import type { TimelineImage } from '@aurboda/api-spec'
import type { Note } from '@fedify/fedify/vocab'

import { Document, Image, Link, Mention } from '@fedify/fedify/vocab'
import sanitizeHtml from 'sanitize-html'

import type { FeedFollowingRecord, TimelineEntryInput } from '../../db/index.ts'

import { temporalInstantToDate } from './temporal-interop.ts'

/**
 * Sanitise untrusted remote HTML to the small tag set Mastodon-style post content
 * uses. Links are forced to `rel="nofollow noopener noreferrer"` + `target`, and
 * only `http(s)` schemes survive — so no `javascript:` URLs, inline handlers,
 * styles, scripts, iframes, or images.
 */
export const sanitizeRemoteHtml = (html: string): string =>
  sanitizeHtml(html, {
    allowedAttributes: {
      a: ['href', 'rel', 'target', 'class', 'translate'],
      ol: ['start'],
      span: ['class', 'translate'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedTags: [
      'p',
      'br',
      'a',
      'span',
      'em',
      'strong',
      'b',
      'i',
      'del',
      's',
      'u',
      'pre',
      'code',
      'blockquote',
      'ul',
      'ol',
      'li',
      'h1',
      'h2',
      'h3',
      'h4',
    ],
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener noreferrer', target: '_blank' }),
    },
  })

/**
 * Map a received `Note` + its (already-resolved, followed) author to a timeline
 * entry, or null if the Note lacks an id or a `published` timestamp.
 *
 * **Authority check.** `note.id` becomes `object_uri`, the *globally-unique* upsert
 * key. Without an origin check a malicious accepted followee could deliver a Note
 * whose id collides with another followee's post and overwrite it (attributed to
 * themselves). So we require the Note to originate from the sender's host and to
 * **declare `attributedTo` naming the sender** — the symmetric guard to the
 * sender-scoped inbound `Delete`. A Note with no `attributedTo` at all used to
 * pass on host match alone; every real implementation sets it, so requiring it
 * costs nothing and closes the same-host claim (#1018). The author's presentation
 * (handle / name / avatar) comes from the cached `feed_following` row (no extra
 * network).
 */
/** The author fields the timeline snapshot needs — a followee row, or a stranger-replier's fetched presentation. */
export type TimelineAuthor = Pick<FeedFollowingRecord, 'actor_uri' | 'avatar_url' | 'display_name' | 'handle'>

/**
 * The boost wrapper around a Note: an `Announce` by a followee of a THIRD-PARTY
 * post. It replaces the row's identity — `object_uri` becomes the Announce id
 * (globally unique, so two followees boosting one post give two cards and a
 * boost never collides with the original's own entry), the announced Note's id
 * moves to `boost_of_uri`, and `published_at` becomes the boost time so the card
 * sorts where Mastodon puts it. Everything else still describes the ORIGINAL
 * post and author, so the card renders that post.
 */
export interface TimelineBoostSource {
  /** The `Announce` activity's id — the boost card's `object_uri`. */
  announce_uri: string
  /** The followee who boosted. */
  actor_uri: string
  handle: string | null
  display_name: string | null
  /** The `Announce`'s `published` (or now, when it declares none). */
  published_at: Date
}

/** Whether the Note carries a `Mention` tag pointing at `actorUri` (#1060). */
export const noteMentionsActor = async (note: Note, actorUri: string): Promise<boolean> => {
  for await (const tag of note.getTags({ suppressError: true })) {
    if (tag instanceof Mention && tag.href?.href === actorUri) return true
  }
  return false
}

export const noteToTimelineInput = (
  note: Note,
  author: TimelineAuthor,
  now: number = Date.now(),
  /** When set, the entry becomes a BOOST card of this Note (see `TimelineBoostSource`). */
  boost?: TimelineBoostSource,
): TimelineEntryInput | null => {
  if (note.id == null || note.published == null) return null
  // The Note's author is `author.actor_uri` — for a direct delivery the accepted
  // followee the inbox handler looked up by the activity's actor id; for a boost
  // the announced Note's own (separately resolved) author.
  const senderHost = new URL(author.actor_uri).host
  if (note.id.host !== senderHost) return null
  if (!note.attributionIds.some((uri) => uri.href === author.actor_uri)) return null
  // Clamp `published_at` to "not in the future": it's the timeline sort key, so a
  // far-future timestamp would otherwise let a followed actor pin a post to the top
  // indefinitely (and re-pin via Update). Same guard Mastodon applies on ingest.
  const publishedAt = boost ? boost.published_at : temporalInstantToDate(note.published)
  return {
    actor_uri: author.actor_uri,
    avatar_url: author.avatar_url,
    ...(boost == null
      ? {}
      : {
          boost_of_uri: note.id.href,
          boosted_by_actor_uri: boost.actor_uri,
          boosted_by_display_name: boost.display_name,
          boosted_by_handle: boost.handle,
        }),
    content: sanitizeRemoteHtml(note.content?.toString() ?? ''),
    display_name: author.display_name,
    handle: author.handle,
    // A reply's target id, so the timeline can filter replies-to-others and
    // notify only replies the reader is involved in (#1060).
    in_reply_to_uri: note.replyTargetIds[0]?.href ?? null,
    object_uri: boost ? boost.announce_uri : note.id.href,
    published_at: new Date(Math.min(publishedAt.getTime(), now)),
    url: note.url instanceof URL ? note.url.href : note.id.href,
  }
}

/**
 * Resolve an attachment's `url` (a `URL` or a `Link`) to an **https** `URL`, or
 * null. https-only: an `http:` image would be blocked as mixed content on the
 * https web app, so storing it is dead weight that never renders.
 */
const httpsUrl = (raw: URL | Link | null): URL | null => {
  const url = raw instanceof URL ? raw : raw instanceof Link ? raw.href : null
  return url?.protocol === 'https:' ? url : null
}

/** Map one attachment to a `TimelineImage`, or null if it isn't an https image. */
const attachmentToImage = (att: unknown): TimelineImage | null => {
  // `Image` (our charts / route maps) is a `Document` subtype; Mastodon photos
  // are `Document`s with an `image/*` media type. Both are covered by `Document`.
  if (!(att instanceof Document)) return null
  const rawUrl = att.url
  const url = httpsUrl(rawUrl)
  if (url == null) return null
  const mediaType = att.mediaType ?? (rawUrl instanceof Link ? rawUrl.mediaType : null) ?? undefined
  if (!(att instanceof Image) && !mediaType?.startsWith('image/')) return null
  const name = att.name?.toString()
  const image: TimelineImage = { url: url.href }
  if (mediaType != null) image.media_type = mediaType
  if (name != null && name !== '') image.name = name
  if (typeof att.width === 'number') image.width = att.width
  if (typeof att.height === 'number') image.height = att.height
  return image
}

/**
 * Extract a received Note's image attachments (rendered chart / route map, or a
 * Mastodon photo) so the home timeline can show them — the fallback when a post
 * carries no native structured chart. Best-effort: only inline http(s) images
 * are kept; anything else is skipped. Non-image and malformed attachments (and a
 * Note with none) yield an empty array.
 */
/** Cap on kept image attachments per post (matches Mastodon), bounding what a
 * hostile followee could make us store + render in one card. */
const MAX_TIMELINE_IMAGES = 4

/** Hard cap on attachments *scanned* (not just kept). The kept-image cap alone
 * doesn't bound work: a Note stuffed with non-image or reference-URI attachments
 * would never hit it, so every attachment would be iterated (and each reference
 * URI dereferenced). This bounds that amplification. */
const MAX_ATTACHMENTS_SCANNED = 20

export const extractNoteImages = async (note: Note): Promise<TimelineImage[]> => {
  const images: TimelineImage[] = []
  let scanned = 0
  // `suppressError` so a referenced attachment whose dereference fails (unreachable
  // host, timeout, or `validatePublicUrl` rejecting a private-IP URL) yields null
  // instead of throwing out of the best-effort ingest path (never-500 invariant).
  // Inline attachments — our own chart `Image`s and Mastodon photos — don't deref.
  for await (const att of note.getAttachments({ suppressError: true })) {
    if (++scanned > MAX_ATTACHMENTS_SCANNED) break
    const image = attachmentToImage(att)
    if (image) images.push(image)
    if (images.length >= MAX_TIMELINE_IMAGES) break
  }
  return images
}
