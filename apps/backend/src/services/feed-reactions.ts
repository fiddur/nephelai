/**
 * Outbound likes ⭐, boosts 🔄 and replies 🗨 — the user acting on a
 * home-timeline card.
 *
 * A like is an AS2 `Like` (Mastodon's "favourite"), a boost an AS2 `Announce`
 * ("reblog"); both are retracted with an `Undo` of the same activity. The local
 * `feed_reaction` row is the source of truth for the card's state AND the source
 * of the activity id, so the `Undo` always references exactly what was
 * delivered.
 *
 * Addressing mirrors Mastodon:
 *
 * - `Like` → the post author's inbox only (no `to`/`cc`; nobody else cares).
 * - `Announce` → `to: Public`, `cc: [followers, author]`, delivered as two
 *   independent sends so one dead inbox can't cancel the other (the same shape
 *   `sendToFollowersAndMentioned` uses).
 *
 * A reply is neither: it is a feed POST of kind `reply` (an AS2
 * `Create{Note inReplyTo}` that `Mention`s the author), so it federates through
 * the shared feed-post delivery hook rather than these builders — see
 * `reply` at the bottom of this module.
 *
 * Delivery is best-effort and synchronous, like `followActor`: a failed POST is
 * logged and the local state stands, so the card never lies about what the user
 * did on this instance.
 *
 * The activity builders below are pure (plain URLs in, vocab objects out), so
 * they unit-test with no database and no network.
 */
import type {
  FeedPost,
  FeedPostReaction,
  FeedReactionKind,
  ReplyToPostBody,
  TimelineEntry,
} from '@aurboda/api-spec'
import type { Federation } from '@fedify/fedify'
import type { Actor } from '@fedify/fedify/vocab'

import { Announce, isActor, Like, Undo } from '@fedify/fedify/vocab'

import type { FeedPostReactionRecord, FeedReactionRecord, TimelineEntryRecord } from '../db/index.ts'
import type { FeedDeliver } from '../routes/feed-router.ts'

import {
  createReplyPost,
  getFeedFollowingByActor,
  getFeedReaction,
  getTimelineEntryById,
  insertFeedReaction,
  removeFeedReaction,
} from '../db/index.ts'
import { AS_PUBLIC } from './activitypub/object.ts'
import { actorUriToHandle } from './activitypub/reply-object.ts'
import { dateToTemporalInstant } from './activitypub/temporal-interop.ts'
import { serializeFeedPost } from './feed.ts'
import { loadReactionsForRows, ownObjectPrefix, reactionTarget, serializeTimelineEntry } from './timeline.ts'
import { withTimeout } from './with-timeout.ts'

/** How long to wait for an unfollowed author's actor document before giving up. */
const AUTHOR_LOOKUP_TIMEOUT_MS = 5000

export interface ReactionDeps {
  federation: Federation<void>
  /** Canonical web origin, e.g. `https://aurboda.net`. */
  origin: string
}

/**
 * Outcome of a reaction toggle. A failure is a status + message the REST/MCP
 * layers surface, never a thrown error — same contract as `FollowResult`.
 */
export type ReactionResult = { ok: true; entry: TimelineEntry } | { ok: false; status: number; error: string }

/**
 * Outcome of a reply. Same failure contract as `ReactionResult`; success
 * carries the created feed post (a reply IS a post of kind `reply`), so the
 * client can render it without a refetch.
 */
export type ReplyResult = { ok: true; post: FeedPost } | { ok: false; status: number; error: string }

/**
 * The network-requiring reaction operations, injected into the REST router + MCP
 * tools (mirroring `FollowActions`) so those layers stay decoupled from the
 * ActivityPub context and testable without it. Each takes the **timeline entry's
 * local id** — what the card actually has — not the remote object URI.
 */
export interface ReactionActions {
  like: (user: string, entryId: string) => Promise<ReactionResult>
  unlike: (user: string, entryId: string) => Promise<ReactionResult>
  boost: (user: string, entryId: string) => Promise<ReactionResult>
  unboost: (user: string, entryId: string) => Promise<ReactionResult>
  /** Publish a reply to the post a card shows, delivered to followers AND its author. */
  reply: (user: string, entryId: string, body: ReplyToPostBody) => Promise<ReplyResult>
}

/**
 * The pieces of an actor context an activity builder needs — supplied by Fedify
 * in production, by plain URLs in tests.
 */
export interface ReactionActorContext {
  /** The reacting user's own actor URI. */
  actorUri: URL
  /** The reacting user's followers collection (an `Announce`'s `cc`). */
  followersUri: URL
  /** Canonical web origin, for minting activity ids. */
  origin: string
  user: string
}

/**
 * The AS2 id we mint for an outbound reaction (stable per `feed_reaction` row).
 * Mastodon never dereferences a Like/Announce id, so a GET on it may 404 —
 * uniqueness and stability are all it needs. `#undo` on the same URL retracts it.
 */
export const reactionActivityId = (
  origin: string,
  user: string,
  kind: FeedReactionKind,
  reactionId: string,
): URL =>
  new URL(
    `${origin.replace(/\/+$/, '')}/users/${encodeURIComponent(user)}/${
      kind === 'like' ? 'likes' : 'announces'
    }/${reactionId}`,
  )

/**
 * The `Like`/`Announce` to deliver for a stored reaction row. A `Like` carries
 * no addressing (it goes to the author's inbox alone); an `Announce` is public
 * and cc'd to our followers + the author, so their servers can attribute the
 * boost.
 */
export const buildReactionActivity = (
  ctx: ReactionActorContext,
  row: FeedReactionRecord,
): Announce | Like => {
  const id = reactionActivityId(ctx.origin, ctx.user, row.kind, row.id)
  if (row.kind === 'like') {
    return new Like({ actor: ctx.actorUri, id, object: new URL(row.object_uri) })
  }
  return new Announce({
    actor: ctx.actorUri,
    ccs: [ctx.followersUri, new URL(row.actor_uri)],
    id,
    object: new URL(row.object_uri),
    published: dateToTemporalInstant(row.created_at),
    to: new URL(AS_PUBLIC),
  })
}

/** The `Undo` that retracts a stored reaction — same recipients as the activity it wraps. */
export const buildUndoReactionActivity = (ctx: ReactionActorContext, row: FeedReactionRecord): Undo => {
  const activity = buildReactionActivity(ctx, row)
  return new Undo({
    actor: ctx.actorUri,
    ...(row.kind === 'like'
      ? {}
      : { ccs: [ctx.followersUri, new URL(row.actor_uri)], to: new URL(AS_PUBLIC) }),
    id: new URL(`${reactionActivityId(ctx.origin, ctx.user, row.kind, row.id).href}#undo`),
    object: activity,
  })
}

/** The cached inbox of a post's author, or null when we don't follow them. */
const cachedAuthorInbox = async (
  user: string,
  authorUri: string,
): Promise<{ inbox_uri: string; shared_inbox_uri: string | null } | null> => {
  const followee = await getFeedFollowingByActor(user, authorUri)
  return followee == null
    ? null
    : { inbox_uri: followee.inbox_uri, shared_inbox_uri: followee.shared_inbox_uri }
}

/**
 * Where to deliver a reaction to `authorUri`: the cached `feed_following` row
 * when we follow them (no network at all), else a bounded actor lookup. A
 * `Like`/`Announce` we can't address is a 502 — the row is never written, so the
 * card doesn't claim a reaction that never left the instance.
 */
const resolveAuthorInbox = async (
  deps: ReactionDeps,
  user: string,
  authorUri: string,
): Promise<{ inbox_uri: string; shared_inbox_uri: string | null } | null> => {
  const cached = await cachedAuthorInbox(user, authorUri)
  if (cached != null) return cached
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  let actor: Actor | null
  try {
    const object = await withTimeout(ctx.lookupObject(authorUri), AUTHOR_LOOKUP_TIMEOUT_MS)
    actor = isActor(object) ? object : null
  } catch {
    actor = null
  }
  if (actor?.inboxId == null) return null
  return {
    inbox_uri: actor.inboxId.href,
    shared_inbox_uri: actor.endpoints?.sharedInbox?.href ?? null,
  }
}

/** The Fedify recipient for a stored reaction row (its cached author inbox). */
const rowRecipient = (row: FeedReactionRecord) => ({
  endpoints: row.shared_inbox_uri ? { sharedInbox: new URL(row.shared_inbox_uri) } : null,
  id: new URL(row.actor_uri),
  inboxId: new URL(row.inbox_uri),
})

/**
 * Serialise the entry as the toggle's response, re-reading the reader's own
 * reaction state so the returned card is authoritative (the client replaces its
 * optimistic patch with it).
 */
const entryWithReactions = async (
  user: string,
  origin: string,
  record: TimelineEntryRecord,
): Promise<TimelineEntry> =>
  serializeTimelineEntry(record, ownObjectPrefix(origin, user), await loadReactionsForRows(user, [record]))

/**
 * Fan an `Announce`/`Undo{Announce}` out to followers AND the post's author as
 * two independent sends: without an outbox queue Fedify awaits every follower
 * inbox, so one dead instance would otherwise cancel the author delivery that
 * tells them who boosted (#1079's lesson, same shape).
 */
const sendBoost = async (
  deps: ReactionDeps,
  user: string,
  row: FeedReactionRecord,
  activity: Announce | Like | Undo,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  await Promise.allSettled([
    ctx.sendActivity({ identifier: user }, 'followers', activity),
    ctx.sendActivity({ identifier: user }, rowRecipient(row), activity),
  ])
}

/** Deliver a `Like`/`Undo{Like}` to the post author's inbox alone (Mastodon does the same). */
const sendLike = async (
  deps: ReactionDeps,
  user: string,
  row: FeedReactionRecord,
  activity: Announce | Like | Undo,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  await ctx.sendActivity({ identifier: user }, rowRecipient(row), activity)
}

const deliverReaction = async (
  deps: ReactionDeps,
  user: string,
  row: FeedReactionRecord,
  activity: Announce | Like | Undo,
): Promise<void> => {
  try {
    // A Like (and its Undo) goes to the author alone; an Announce (and its Undo)
    // fans out to followers too.
    if (activity instanceof Like || (activity instanceof Undo && row.kind === 'like')) {
      await sendLike(deps, user, row, activity)
    } else {
      await sendBoost(deps, user, row, activity)
    }
  } catch (error) {
    console.warn(`⚠️ ${activity.constructor.name} delivery failed for ${user} → ${row.object_uri}:`, error)
  }
}

/** The actor context for building this user's activities, from a live Fedify context. */
const actorContext = async (deps: ReactionDeps, user: string): Promise<ReactionActorContext> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  return {
    actorUri: ctx.getActorUri(user),
    followersUri: ctx.getFollowersUri(user),
    origin: deps.origin,
    user,
  }
}

/**
 * React to the post a timeline card shows. Idempotent: a second like of the same
 * post returns the card unchanged and delivers nothing (the `UNIQUE (kind,
 * object_uri)` row is already there).
 */
const react = async (
  deps: ReactionDeps,
  user: string,
  entryId: string,
  kind: FeedReactionKind,
): Promise<ReactionResult> => {
  const entry = await getTimelineEntryById(user, entryId)
  if (entry == null) return { error: 'Timeline entry not found', ok: false, status: 404 }
  const objectUri = reactionTarget(entry)
  if ((await getFeedReaction(user, kind, objectUri)) != null) {
    return { entry: await entryWithReactions(user, deps.origin, entry), ok: true }
  }
  const inbox = await resolveAuthorInbox(deps, user, entry.actor_uri)
  if (inbox == null) {
    return { error: 'Couldn’t reach the author’s server. Please try again later.', ok: false, status: 502 }
  }
  const { inserted, ...row } = await insertFeedReaction(user, {
    actor_uri: entry.actor_uri,
    inbox_uri: inbox.inbox_uri,
    kind,
    object_uri: objectUri,
    shared_inbox_uri: inbox.shared_inbox_uri,
  })
  // A row that already existed (a racing double-tap) was delivered once already.
  if (inserted) {
    await deliverReaction(deps, user, row, buildReactionActivity(await actorContext(deps, user), row))
  }
  return { entry: await entryWithReactions(user, deps.origin, entry), ok: true }
}

/**
 * Retract a reaction. Idempotent the other way: undoing something that isn't
 * there returns the card unchanged. The local row goes regardless of whether the
 * `Undo` reached the author — the user un-liked it here.
 */
const unreact = async (
  deps: ReactionDeps,
  user: string,
  entryId: string,
  kind: FeedReactionKind,
): Promise<ReactionResult> => {
  const entry = await getTimelineEntryById(user, entryId)
  if (entry == null) return { error: 'Timeline entry not found', ok: false, status: 404 }
  const existing = await getFeedReaction(user, kind, reactionTarget(entry))
  if (existing == null) {
    return { entry: await entryWithReactions(user, deps.origin, entry), ok: true }
  }
  await deliverReaction(
    deps,
    user,
    existing,
    buildUndoReactionActivity(await actorContext(deps, user), existing),
  )
  await removeFeedReaction(user, kind, existing.object_uri)
  return { entry: await entryWithReactions(user, deps.origin, entry), ok: true }
}

/**
 * Serialise an INBOUND reaction (someone else's Like/Announce of one of the
 * owner's posts) for the owner-facing REST/MCP surface. Pure — no network, no
 * database — so both surfaces present the same shape.
 */
export const serializeFeedPostReaction = (record: FeedPostReactionRecord): FeedPostReaction => ({
  actor_uri: record.actor_uri,
  avatar_url: record.avatar_url,
  created_at: record.created_at.toISOString(),
  display_name: record.display_name,
  handle: record.handle,
  kind: record.kind,
})

/**
 * Reply to the post a home-timeline card shows: store a `reply` feed post whose
 * target is resolved from the card (never from the request), then fan the
 * `Create{Note inReplyTo}` out through the same delivery hook every other post
 * kind uses.
 *
 * The target of a BOOST card is the ORIGINAL Note and its original author
 * (`reactionTarget` / the entry's author columns), exactly as a like or boost
 * resolves it — replying to a boost replies to the post it shows.
 *
 * The author's inbox is resolved BEFORE the row is written (cached followee row
 * first, else a bounded actor lookup): a reply we can't address is a 502, so no
 * post is left claiming to answer someone who was never told.
 */
const reply = async (
  deps: ReactionDeps,
  user: string,
  entryId: string,
  body: ReplyToPostBody,
  deliver?: FeedDeliver,
): Promise<ReplyResult> => {
  const entry = await getTimelineEntryById(user, entryId)
  if (entry == null) return { error: 'Timeline entry not found', ok: false, status: 404 }
  const message = body.message.trim()
  if (message === '') return { error: 'A reply needs some text.', ok: false, status: 400 }
  if ((await resolveAuthorInbox(deps, user, entry.actor_uri)) == null) {
    return { error: 'Couldn’t reach the author’s server. Please try again later.', ok: false, status: 502 }
  }
  const record = await createReplyPost(user, {
    in_reply_to_actor_uri: entry.actor_uri,
    // The handle names the federated `Mention`; the ingest-time snapshot when we
    // have one, else derived from the actor URI (an unnamed mention is worse).
    in_reply_to_handle: entry.handle ?? actorUriToHandle(entry.actor_uri),
    in_reply_to_uri: reactionTarget(entry),
    message,
    visibility: body.visibility,
  })
  deliver?.createdReply(user, record)
  return { ok: true, post: await serializeFeedPost(user, record) }
}

/**
 * Bind the reaction + reply operations to one federation + origin (wired once
 * in `api.ts`). `deliver` is the shared feed-post delivery hook, so a reply
 * federates through exactly the same fire-and-forget boundary as a share.
 */
export const createReactionActions = (deps: ReactionDeps, deliver?: FeedDeliver): ReactionActions => ({
  boost: (user, entryId) => react(deps, user, entryId, 'announce'),
  like: (user, entryId) => react(deps, user, entryId, 'like'),
  reply: (user, entryId, body) => reply(deps, user, entryId, body, deliver),
  unboost: (user, entryId) => unreact(deps, user, entryId, 'announce'),
  unlike: (user, entryId) => unreact(deps, user, entryId, 'like'),
})
