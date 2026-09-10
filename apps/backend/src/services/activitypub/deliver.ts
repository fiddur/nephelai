import type { ArticleContent, ChallengeShare, FeedVisibility } from '@aurboda/api-spec'
/**
 * Build and deliver a shared feed post over ActivityPub.
 *
 * The Mastodon-compatible representation is a Fedify `Create{Note}` — an HTML
 * `content` summary + `name`/`url`, addressed per the post's visibility. The
 * `Note`'s id is its object-dispatcher URL (`getObjectUri(Note, …)`), so the
 * object we deliver, the one listed in the outbox, and the one served when a
 * remote server dereferences that id are all built here and stay identical.
 *
 * `deliverFeedPost` fans the `Create` out via `ctx.sendActivity(..., 'followers',
 * …)`, which Fedify signs and dedupes by shared inbox. Delivery is synchronous
 * (no message queue configured), so it awaits the outbound POSTs; retry/
 * durability via a persistent queue is a later slice.
 *
 * Every activity Note also carries the QuantPub `quant:` extension (#896):
 * Fedify's typed vocab drops unknown properties, so `withQuantJsonLd` splices
 * the typed fields into the serialized JSON-LD of the outermost object we hand
 * to Fedify — the `Create`/`Update` for delivery and the outbox, the bare
 * `Note` for the object dispatcher (see `quant-extension.ts`). The AS2 window
 * (`startTime`/`endTime`) is set natively on the Note.
 * Delivery is best-effort: callers invoke it fire-and-forget.
 */
import type { Context, Federation } from '@fedify/fedify'

import {
  type Activity,
  Create,
  Delete,
  Image,
  isActor,
  Mention,
  Note,
  Tombstone,
  Update,
} from '@fedify/fedify/vocab'

import type { FeedPostRecord } from '../../db/index.ts'

import { challengeWinners } from '../challenge-results.ts'
import { getSettings } from '../settings.ts'
import { articleImageAttachments, renderArticleContentHtml } from './article-object.ts'
import { identityToActorUri, identityToHandle, renderChallengeShareHtml } from './challenge-object.ts'
import { resolveActivityScalars } from './feed-activity.ts'
import { addressingFor, feedPostContent, formatActivityWindow, isPubliclyVisible } from './object.ts'
import { quantExerciseExtension, withQuantJsonLd } from './quant-extension.ts'
import { type ReplyContentSource, renderReplyContent, replyMentionName } from './reply-object.ts'
import { dateToTemporalInstant } from './temporal-interop.ts'

/**
 * AS2 `to`/`cc` addressing (as URLs) for a post's visibility — the same table
 * `addressingFor` uses for the JSON object model, mapped through `URL` so the
 * two can't drift.
 */
export const recipients = (visibility: FeedVisibility, followers: URL): { to: URL[]; cc: URL[] } => {
  const { cc, to } = addressingFor(visibility, followers.href)
  return { cc: cc.map((u) => new URL(u)), to: to.map((u) => new URL(u)) }
}

export interface FeedDeliveryDeps {
  federation: Federation<void>
  /** Canonical web origin, e.g. `https://aurboda.net`. */
  origin: string
  /** Public API base, e.g. `https://aurboda.net/api` — image attachment URLs hang off this. */
  apiBaseUrl: string
}

export interface DeliverablePost {
  id: string
  included_metrics: string[]
  /** Metric keys whose series were explicitly shared (drive `quant:series` links). */
  series_metrics: string[]
  visibility: FeedVisibility
  /** The author's personal message (plain text); null/undefined = none shared. */
  message?: string | null
  created_at: Date
  /** Last-edited time; makes each `Update` activity id unique (see `buildFeedUpdate`). */
  updated_at: Date
  /** Attach a rendered heart-rate chart image. */
  include_chart: boolean
  /** Attach a rendered GPS route-map image. */
  include_map: boolean
  /** Capability token appended to `followers`-only image URLs (see `imageAttachments`). */
  image_token: string
}

/**
 * Image attachments for a post's opted-in chart/route. Each points at the public
 * on-demand image endpoint (`/api/public/<user>/feed/<id>/{chart,route}.png`),
 * built against the actor's origin so it matches the deployed API base. Fedify's
 * `Image` carries `url` + `mediaType` + intrinsic size so Mastodon lays it out.
 *
 * `public`/`unlisted` images are served unauthenticated. A `followers`-only
 * post's URLs instead carry the post's unguessable **capability token**
 * (`?token=…`): the fediverse fetches media without HTTP signatures, so the
 * endpoint can't verify a signed request — the token is what lets a follower's
 * server fetch the image while an untoken'd guess 404s. The token is only ever
 * embedded in the Note delivered to followers, never in the public object/outbox.
 */
export const imageAttachments = (apiBaseUrl: string, user: string, post: DeliverablePost): Image[] => {
  // Same base as the series links (feed-activity.ts) — the configured API base,
  // NOT a hardcoded `<origin>/api`, so it stays correct if the two ever diverge.
  const base = `${apiBaseUrl.replace(/\/+$/, '')}/public/${encodeURIComponent(user)}/feed/${post.id}`
  const query = isPubliclyVisible(post.visibility) ? '' : `?token=${encodeURIComponent(post.image_token)}`
  const images: Image[] = []
  if (post.include_chart) {
    images.push(
      new Image({
        height: 420,
        mediaType: 'image/png',
        name: 'Heart rate',
        url: new URL(`${base}/chart.png${query}`),
        width: 1000,
      }),
    )
  }
  if (post.include_map) {
    images.push(
      new Image({
        height: 700,
        mediaType: 'image/png',
        name: 'Route',
        url: new URL(`${base}/route.png${query}`),
        width: 700,
      }),
    )
  }
  return images
}

export interface DeliverableActivity {
  activity_type: string
  start_time: Date
  end_time?: Date
  title?: string
}

/**
 * Build the Fedify `Note` for a shared post: the Mastodon-compatible object
 * (HTML `content` + headline `name`), addressed per visibility. Its id and `url`
 * are the object-dispatcher URL (`getObjectUri(Note, …)`), so the delivered
 * object and the one served at that URL are guaranteed identical.
 *
 * `published` is the post's `created_at` (its share time), so remote servers
 * order and timestamp it correctly instead of stamping it at receipt. Fedify
 * types `published` as the ambient `Temporal.Instant`; `dateToTemporalInstant`
 * bridges our `@js-temporal/polyfill` value to it.
 */
const buildFeedNoteParts = async (
  ctx: Context<void>,
  user: string,
  post: DeliverablePost,
  activity: DeliverableActivity,
  apiBaseUrl: string,
): Promise<{ note: Note; quant: Record<string, unknown> }> => {
  const scalars = await resolveActivityScalars(user, activity, post.included_metrics)
  // The activity-date line renders in the author's device timezone (like the
  // article block images); unknown/invalid falls back to UTC inside the formatter.
  const settings = await getSettings(user).catch(() => null)
  const { content, name } = feedPostContent(activity.title, activity.activity_type, scalars, {
    message: post.message ?? undefined,
    windowLabel: formatActivityWindow(
      activity.start_time,
      activity.end_time,
      settings?.device_timezone ?? undefined,
    ),
  })
  const actorUri = ctx.getActorUri(user)
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  const note = new Note({
    attachments: imageAttachments(apiBaseUrl, user, post),
    attribution: actorUri,
    ccs: cc,
    content,
    // The AS2 activity window — the workout time; `published` stays the share time.
    endTime: activity.end_time === undefined ? null : dateToTemporalInstant(activity.end_time),
    id: noteId,
    name,
    published: dateToTemporalInstant(post.created_at),
    startTime: dateToTemporalInstant(activity.start_time),
    tos: to,
    url: noteId,
  })
  const quant = quantExerciseExtension({
    activityType: activity.activity_type,
    apiBaseUrl,
    endTime: activity.end_time,
    imageToken: post.image_token,
    postId: post.id,
    scalars,
    seriesMetrics: post.series_metrics,
    startTime: activity.start_time,
    user,
    visibility: post.visibility,
  })
  return { note, quant }
}

export const buildFeedNote = async (
  ctx: Context<void>,
  user: string,
  post: DeliverablePost,
  activity: DeliverableActivity,
  apiBaseUrl: string,
): Promise<Note> => {
  const { note, quant } = await buildFeedNoteParts(ctx, user, post, activity, apiBaseUrl)
  // The dispatcher serves the Note bare, so the Note itself carries the extension.
  return withQuantJsonLd(note, quant)
}

/**
 * Wrap the post's `Note` in the `Create` activity that is both delivered to
 * followers and listed in the actor's outbox. The `Create` id is a `#create`
 * fragment on the Note id, so it never collides with (nor 404s separately from)
 * the object URL.
 */
export const buildFeedCreate = async (
  ctx: Context<void>,
  user: string,
  post: DeliverablePost,
  activity: DeliverableActivity,
  apiBaseUrl: string,
): Promise<Create> => {
  // The Create is the outermost serialized object, so IT carries the quant
  // extension (spliced into its embedded object) — wrapping the embedded Note
  // instead would be mangled by the activity-level JSON-LD compaction.
  const { note, quant } = await buildFeedNoteParts(ctx, user, post, activity, apiBaseUrl)
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  const create = new Create({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#create`),
    object: note,
    published: dateToTemporalInstant(post.created_at),
    tos: to,
  })
  return withQuantJsonLd(create, quant)
}

/**
 * Wrap the post's (re-resolved) `Note` in an `Update` activity. Sent when a
 * post's shared metric selection or visibility changes, so followers' servers
 * replace the stored object. The `Update` id carries the post's `updated_at`
 * (`#update-<epoch-ms>`) so each edit has a distinct activity id — AS2 requires
 * unique activity ids, and servers that dedupe inbound activities by id would
 * otherwise drop every edit after the first.
 */
export const buildFeedUpdate = async (
  ctx: Context<void>,
  user: string,
  post: DeliverablePost,
  activity: DeliverableActivity,
  apiBaseUrl: string,
): Promise<Update> => {
  const { note, quant } = await buildFeedNoteParts(ctx, user, post, activity, apiBaseUrl)
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  const update = new Update({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#update-${post.updated_at.getTime()}`),
    object: note,
    tos: to,
  })
  return withQuantJsonLd(update, quant)
}

/**
 * Build the `Delete{Tombstone}` for a removed post — the AS2-standard way to
 * retract it from followers' timelines. Needs no activity/scalar resolution
 * (just the object id + addressing), so it stays synchronous and survives the
 * post row already being gone.
 */
export const buildFeedDelete = (ctx: Context<void>, user: string, post: DeliverablePost): Delete => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  return new Delete({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#delete`),
    object: new Tombstone({ id: noteId }),
    tos: to,
  })
}

/** Build and send the `Create{Note}` for a freshly-shared post to its followers. */
export const deliverFeedPost = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverablePost,
  activity: DeliverableActivity,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const create = await buildFeedCreate(ctx, user, post, activity, deps.apiBaseUrl)
  await ctx.sendActivity({ identifier: user }, 'followers', create)
}

/** Build and send the `Update{Note}` for an edited post to its followers. */
export const deliverFeedUpdate = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverablePost,
  activity: DeliverableActivity,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const update = await buildFeedUpdate(ctx, user, post, activity, deps.apiBaseUrl)
  await ctx.sendActivity({ identifier: user }, 'followers', update)
}

/**
 * Build and send the `Delete{Tombstone}` for a removed post to its followers,
 * and to anyone the post itself tagged.
 */
export const deliverFeedDelete = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverablePost & {
    challenge?: ChallengeShare | null
    in_reply_to_actor_uri?: string | null
    in_reply_to_handle?: string | null
  },
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const del = buildFeedDelete(ctx, user, post)
  // A completion post was also delivered to each tagged winner's inbox, and a
  // reply to the inbox of the author it answered (neither need follow us), so
  // the Delete goes there too (#1074) — and, like Create/Update, independently
  // of the followers fan-out (#1079).
  await sendToFollowersAndMentioned(
    ctx,
    user,
    [
      ...(post.challenge == null ? [] : challengeMentions(post.challenge)),
      ...replyMentions({
        in_reply_to_actor_uri: post.in_reply_to_actor_uri ?? null,
        in_reply_to_handle: post.in_reply_to_handle ?? null,
      }),
    ],
    del,
  )
}

// ---------------------------------------------------------------------------
// Articles (long-form posts). An article federates as a `Note` — Mastodon
// discards `content` for AS2 `Article` (a converted type) and renders only
// name + url, so a Note is what actually shows the prose + attached images. The
// article's Note is served on the SAME object path as an activity's Note (they
// never collide — a post is one or the other), so a deleted article tombstones
// there like any post. Aurboda peers get the richer inline render via structured
// enrichment (a later slice), not the AS2 object type. No activity to resolve.
// ---------------------------------------------------------------------------

/** The delivery-facing view of an article post (its `article` guaranteed present). */
export interface DeliverableArticle {
  id: string
  visibility: FeedVisibility
  created_at: Date
  updated_at: Date
  image_token: string
  article: ArticleContent
}

/** Narrow a stored feed post to a `DeliverableArticle`, or null when it isn't an article. */
export const toDeliverableArticle = (post: FeedPostRecord): DeliverableArticle | null =>
  post.kind === 'article' && post.article != null
    ? {
        article: post.article,
        created_at: post.created_at,
        id: post.id,
        image_token: post.image_token,
        updated_at: post.updated_at,
        visibility: post.visibility,
      }
    : null

/**
 * Build the Fedify `Note` for an article: the Mastodon-compatible object (title
 * `name` + prose HTML `content` + chart/correlation PNG attachments), at the
 * post's canonical Note id, addressed per visibility. Synchronous — an article
 * carries no activity to resolve. A deleted article tombstones at this same id.
 */
export const buildArticleNote = (
  ctx: Context<void>,
  user: string,
  post: DeliverableArticle,
  apiBaseUrl: string,
): Note => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  return new Note({
    attachments: articleImageAttachments(
      apiBaseUrl,
      user,
      post.id,
      post.visibility,
      post.image_token,
      post.updated_at,
      post.article,
    ),
    attribution: ctx.getActorUri(user),
    ccs: cc,
    content: renderArticleContentHtml(post.article),
    id: noteId,
    name: post.article.title,
    published: dateToTemporalInstant(post.created_at),
    tos: to,
    url: noteId,
  })
}

/** Wrap the article's Note in the `Create` delivered to followers and listed in the outbox. */
export const buildArticleNoteCreate = (
  ctx: Context<void>,
  user: string,
  post: DeliverableArticle,
  apiBaseUrl: string,
): Create => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  return new Create({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#create`),
    object: buildArticleNote(ctx, user, post, apiBaseUrl),
    published: dateToTemporalInstant(post.created_at),
    tos: to,
  })
}

/** Wrap the (re-resolved) article Note in an `Update`; id carries `updated_at` so each edit is distinct. */
export const buildArticleNoteUpdate = (
  ctx: Context<void>,
  user: string,
  post: DeliverableArticle,
  apiBaseUrl: string,
): Update => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  return new Update({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#update-${post.updated_at.getTime()}`),
    object: buildArticleNote(ctx, user, post, apiBaseUrl),
    tos: to,
  })
}

/** Build and send the `Create{Note}` for a freshly-published article to its followers. */
export const deliverFeedArticlePost = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverableArticle,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  await ctx.sendActivity(
    { identifier: user },
    'followers',
    buildArticleNoteCreate(ctx, user, post, deps.apiBaseUrl),
  )
}

/** Build and send the `Update{Note}` for an edited article to its followers. */
export const deliverFeedArticleUpdate = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverableArticle,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  await ctx.sendActivity(
    { identifier: user },
    'followers',
    buildArticleNoteUpdate(ctx, user, post, deps.apiBaseUrl),
  )
}

// ---------------------------------------------------------------------------
// Challenge shares (#994). A challenge invitation federates as a `Note` (like
// an article): the user's markdown note + the challenge's canonical public
// URL. Mastodon renders the link with the challenge page's existing OG preview
// card. Served on the SAME object path as every post kind, so it tombstones
// like any post. No activity to resolve and no attachments in phase 1.
// ---------------------------------------------------------------------------

/** The delivery-facing view of a challenge post (its `challenge` guaranteed present). */
export interface DeliverableChallenge {
  id: string
  visibility: FeedVisibility
  created_at: Date
  updated_at: Date
  challenge: ChallengeShare
  message: string | null
}

/** Narrow a stored feed post to a `DeliverableChallenge`, or null when it isn't one. */
export const toDeliverableChallenge = (post: FeedPostRecord): DeliverableChallenge | null =>
  post.kind === 'challenge' && post.challenge != null
    ? {
        challenge: post.challenge,
        created_at: post.created_at,
        id: post.id,
        message: post.message,
        updated_at: post.updated_at,
        visibility: post.visibility,
      }
    : null

/**
 * Someone an activity tags: the actor id the `Mention` points at and its
 * `@user@host` name. A completion post tags its winners; a reply tags the
 * author of the post it answers.
 */
export interface MentionRecipient {
  actorUri: URL
  handle: string
}

/**
 * The winners (rank 1) of a completion post's result, as Mentions. An
 * invitation (no result) mentions nobody. A member whose identity can't be
 * mapped to an actor is left out rather than tagged with a broken href.
 */
export const challengeMentions = (challenge: ChallengeShare): MentionRecipient[] => {
  if (challenge.result == null) return []
  const mentions: MentionRecipient[] = []
  for (const entry of challengeWinners(challenge.result)) {
    const actorUri = identityToActorUri(entry.identity_base_url)
    const handle = identityToHandle(entry.identity_base_url)
    if (actorUri != null && handle != null) {
      mentions.push({ actorUri: new URL(actorUri), handle: `@${handle}` })
    }
  }
  return mentions
}

/**
 * Addressing for a challenge post: the visibility table, plus every mentioned
 * winner in `cc` (Mastodon-style — a mention is addressed as well as tagged, so
 * the winner's server accepts it even when they don't follow the host).
 */
const challengeAddressing = (
  ctx: Context<void>,
  user: string,
  post: DeliverableChallenge,
): { to: URL[]; cc: URL[]; mentions: MentionRecipient[] } => {
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  const mentions = challengeMentions(post.challenge)
  return { cc: [...cc, ...mentions.map((m) => m.actorUri)], mentions, to }
}

/**
 * Build the Fedify `Note` for a challenge share: name heading + sanitised
 * markdown note + canonical link as `content` (a completion post: the podium),
 * addressed per visibility, at the post's canonical Note id, with a `Mention`
 * tag per winner. Synchronous — nothing to resolve.
 */
export const buildChallengeNote = (ctx: Context<void>, user: string, post: DeliverableChallenge): Note => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, mentions, to } = challengeAddressing(ctx, user, post)
  return new Note({
    attribution: ctx.getActorUri(user),
    ccs: cc,
    content: renderChallengeShareHtml(post.challenge, post.message),
    id: noteId,
    name: post.challenge.name,
    published: dateToTemporalInstant(post.created_at),
    tags: mentions.map((m) => new Mention({ href: m.actorUri, name: m.handle })),
    tos: to,
    url: noteId,
  })
}

/** Wrap the challenge Note in the `Create` delivered to followers and listed in the outbox. */
export const buildChallengeNoteCreate = (
  ctx: Context<void>,
  user: string,
  post: DeliverableChallenge,
): Create => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = challengeAddressing(ctx, user, post)
  return new Create({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#create`),
    object: buildChallengeNote(ctx, user, post),
    published: dateToTemporalInstant(post.created_at),
    tos: to,
  })
}

/** Wrap the challenge Note in an `Update`; id carries `updated_at` so each edit is distinct. */
export const buildChallengeNoteUpdate = (
  ctx: Context<void>,
  user: string,
  post: DeliverableChallenge,
): Update => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = challengeAddressing(ctx, user, post)
  return new Update({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#update-${post.updated_at.getTime()}`),
    object: buildChallengeNote(ctx, user, post),
    tos: to,
  })
}

/**
 * Deliver an activity to each mentioned actor's own inbox (besides the
 * followers fan-out), so someone who doesn't follow us is still told: a
 * challenge winner, or the author of the post a reply answers. We ourselves
 * are skipped (our own feed already has the post). Each lookup/POST is
 * best-effort and independent: one unreachable recipient never costs another
 * their notification. Remote servers dedupe by activity id, so a mentioned
 * follower sees it once.
 *
 * The actor is dereferenced by its id (`lookupObject`) rather than read off
 * anything inline, so the inbox we POST to is the one that id's own server
 * publishes.
 */
const deliverToMentioned = async (
  ctx: Context<void>,
  user: string,
  mentions: MentionRecipient[],
  activity: Activity,
): Promise<void> => {
  const self = ctx.getActorUri(user).href
  for (const mention of mentions) {
    if (mention.actorUri.href === self) continue
    try {
      const actor = await ctx.lookupObject(mention.actorUri)
      if (!isActor(actor)) {
        // `lookupObject` yields null (not an error) when the actor document can't
        // be loaded.
        console.warn(`⚠️ Mention delivery to ${mention.handle} skipped: actor not resolvable`)
        continue
      }
      await ctx.sendActivity({ identifier: user }, actor, activity)
    } catch (error) {
      console.warn(`⚠️ Mention delivery to ${mention.handle} failed:`, error)
    }
  }
}

/**
 * Fan an activity out to followers and to each tagged actor — as two
 * independent deliveries. Without an outbox queue Fedify awaits every follower
 * inbox and one dead instance rejects the whole send, which used to cancel the
 * mention delivery that exists precisely for people who don't follow us
 * (#1079). Both run concurrently; a followers failure still surfaces to the
 * caller after both have settled.
 */
const sendToFollowersAndMentioned = async (
  ctx: Context<void>,
  user: string,
  mentions: MentionRecipient[],
  activity: Activity,
): Promise<void> => {
  const [followers] = await Promise.allSettled([
    ctx.sendActivity({ identifier: user }, 'followers', activity),
    mentions.length > 0 ? deliverToMentioned(ctx, user, mentions, activity) : Promise.resolve(),
  ])
  if (followers.status === 'rejected') throw followers.reason
}

/**
 * Build and send the `Create{Note}` for a freshly-shared challenge to
 * followers, and to each tagged winner of a completion post.
 */
export const deliverFeedChallengePost = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverableChallenge,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const create = buildChallengeNoteCreate(ctx, user, post)
  await sendToFollowersAndMentioned(ctx, user, challengeMentions(post.challenge), create)
}

/** Build and send the `Update{Note}` for an edited challenge share to followers (and tagged winners). */
export const deliverFeedChallengeUpdate = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverableChallenge,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const update = buildChallengeNoteUpdate(ctx, user, post)
  await sendToFollowersAndMentioned(ctx, user, challengeMentions(post.challenge), update)
}

// ---------------------------------------------------------------------------
// Replies (comments). A reply federates as a `Note` with `inReplyTo` pointing at
// the post it answers and a `Mention` of that post's author — exactly how
// Mastodon threads a reply. It is delivered to our followers AND to the
// author's own inbox, because they need not follow us. Served on the SAME
// object path as every other post kind, so it tombstones like any post.
// ---------------------------------------------------------------------------

/** The delivery-facing view of a reply post (its reply target guaranteed present). */
export interface DeliverableReply {
  id: string
  visibility: FeedVisibility
  created_at: Date
  updated_at: Date
  message: string | null
  in_reply_to_uri: string
  in_reply_to_actor_uri: string
  in_reply_to_handle: string | null
}

/** Narrow a stored feed post to a `DeliverableReply`, or null when it isn't one. */
export const toDeliverableReply = (post: FeedPostRecord): DeliverableReply | null =>
  post.kind === 'reply' && post.in_reply_to_uri != null && post.in_reply_to_actor_uri != null
    ? {
        created_at: post.created_at,
        id: post.id,
        in_reply_to_actor_uri: post.in_reply_to_actor_uri,
        in_reply_to_handle: post.in_reply_to_handle,
        in_reply_to_uri: post.in_reply_to_uri,
        message: post.message,
        updated_at: post.updated_at,
        visibility: post.visibility,
      }
    : null

/**
 * The single actor a reply tags: the author of the post it answers. Empty when
 * the target author isn't known (nothing to tag, and no bogus href).
 */
export const replyMentions = (
  post: Pick<ReplyContentSource, 'in_reply_to_actor_uri' | 'in_reply_to_handle'>,
): MentionRecipient[] => {
  if (post.in_reply_to_actor_uri == null) return []
  let actorUri: URL
  try {
    actorUri = new URL(post.in_reply_to_actor_uri)
  } catch {
    return []
  }
  return [{ actorUri, handle: replyMentionName({ ...post, message: null }) }]
}

/**
 * Addressing for a reply: the visibility table, plus the replied-to author in
 * `cc` (Mastodon-style — a mention is addressed as well as tagged, so their
 * server accepts the reply even when they don't follow us).
 */
const replyAddressing = (
  ctx: Context<void>,
  user: string,
  post: DeliverableReply,
): { to: URL[]; cc: URL[]; mentions: MentionRecipient[] } => {
  const { cc, to } = recipients(post.visibility, ctx.getFollowersUri(user))
  const mentions = replyMentions(post)
  return { cc: [...cc, ...mentions.map((m) => m.actorUri)], mentions, to }
}

/**
 * Build the Fedify `Note` for a reply: `inReplyTo` the answered object, the
 * mention link + the author's markdown as `content`, addressed per visibility,
 * at the post's canonical Note id, with the target author as a `Mention` tag.
 * Synchronous — nothing to resolve.
 */
export const buildReplyNote = (ctx: Context<void>, user: string, post: DeliverableReply): Note => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, mentions, to } = replyAddressing(ctx, user, post)
  return new Note({
    attribution: ctx.getActorUri(user),
    ccs: cc,
    content: renderReplyContent(post),
    id: noteId,
    published: dateToTemporalInstant(post.created_at),
    replyTarget: new URL(post.in_reply_to_uri),
    tags: mentions.map((m) => new Mention({ href: m.actorUri, name: m.handle })),
    tos: to,
    url: noteId,
  })
}

/** Wrap the reply Note in the `Create` delivered to followers + the author, and listed in the outbox. */
export const buildReplyNoteCreate = (ctx: Context<void>, user: string, post: DeliverableReply): Create => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = replyAddressing(ctx, user, post)
  return new Create({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#create`),
    object: buildReplyNote(ctx, user, post),
    published: dateToTemporalInstant(post.created_at),
    tos: to,
  })
}

/** Wrap the reply Note in an `Update`; id carries `updated_at` so each edit is distinct. */
export const buildReplyNoteUpdate = (ctx: Context<void>, user: string, post: DeliverableReply): Update => {
  const noteId = ctx.getObjectUri(Note, { identifier: user, postId: post.id })
  const { cc, to } = replyAddressing(ctx, user, post)
  return new Update({
    actor: ctx.getActorUri(user),
    ccs: cc,
    id: new URL(`${noteId.href}#update-${post.updated_at.getTime()}`),
    object: buildReplyNote(ctx, user, post),
    tos: to,
  })
}

/** Build and send the `Create{Note}` for a fresh reply to followers and the answered author. */
export const deliverFeedReplyPost = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverableReply,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const create = buildReplyNoteCreate(ctx, user, post)
  await sendToFollowersAndMentioned(ctx, user, replyMentions(post), create)
}

/** Build and send the `Update{Note}` for an edited reply to followers and the answered author. */
export const deliverFeedReplyUpdate = async (
  deps: FeedDeliveryDeps,
  user: string,
  post: DeliverableReply,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const update = buildReplyNoteUpdate(ctx, user, post)
  await sendToFollowersAndMentioned(ctx, user, replyMentions(post), update)
}
