import type { FeedReactionKind, FeedStructuredPost } from '@aurboda/api-spec'
import type { Actor } from '@fedify/fedify/vocab'

import {
  type Context,
  createFederation,
  type Federation,
  type InboxContext,
  MemoryKvStore,
} from '@fedify/fedify'
import {
  Accept,
  Announce,
  Create,
  Delete,
  Follow,
  Image,
  Like,
  isActor,
  Note,
  Person,
  Reject,
  Undo,
  Update,
} from '@fedify/fedify/vocab'

/**
 * The Fedify `Federation` object for the activity feed.
 *
 * Single actor per user: the actor identifier IS the username, and the actor
 * lives at `<host>/users/<username>` — a dedicated prefix that never collides
 * with the SPA's human-facing `/u/<username>` profile/dashboard pages. It wires:
 *
 * - actor document (`Person`) with the user's published RSA public key,
 * - WebFinger (`acct:<user>@<host>` → the actor), via `mapHandle`,
 * - key-pairs dispatcher backed by the per-user `feed_actor` keypair,
 * - inbound inbox: `Follow` → persist follower + (unless the user requires
 *   manual approval) `Accept`; `Undo{Follow}` → drop the follower; `Accept`/
 *   `Reject` → resolve a Follow WE sent (mark the `feed_following` row accepted,
 *   or drop it); `Create`/`Update` of a `Note` from an *accepted followee* →
 *   ingest into the home timeline (sanitised); `Delete` → drop the received
 *   post. Fedify verifies the HTTP Signature first.
 * - followers + following collections (the latter lists this user's *accepted*
 *   follows), both backed by Postgres.
 *
 * Delivery is synchronous (no message queue — see `createFeedFederation`); a
 * persistent Postgres queue for retried, durable delivery is a later slice.
 */
import { isValidUsername } from '../../api/auth-routes.ts'
import {
  countAcceptedFeedFollowing,
  countFeedFollowers,
  countPublicFeedPosts,
  deleteBoostEntry,
  deleteTimelineEntryByUri,
  getFeedFollowerByActor,
  getFeedFollowingByActor,
  getFeedPostById,
  getOrCreateActorKeyPair,
  getProfileAvatarVersion,
  getTimelineEntryByObjectUri,
  getUserSettings,
  isMissingDatabase,
  listAcceptedFeedFollowing,
  listFeedFollowers,
  listPublicFeedPostsPage,
  markFeedFollowingAccepted,
  removeFeedFollower,
  removeFeedFollowingByActor,
  removeFeedPostReaction,
  removeFeedPostReactionByActivity,
  upsertFeedFollower,
  upsertFeedPostReaction,
  upsertTimelineEntry,
} from '../../db/index.ts'
import { resolveFeedActivity } from '../feed.ts'
import { buildProfileUrl } from '../share-urls.ts'
import { ownActorUri, ownObjectPrefix } from '../timeline.ts'
import { withTimeout } from '../with-timeout.ts'
import { extractActorPresentation } from './actor-presentation.ts'
import {
  buildArticleNote,
  buildArticleNoteCreate,
  buildChallengeNote,
  buildChallengeNoteCreate,
  buildFeedCreate,
  buildFeedNote,
  buildReplyNote,
  buildReplyNoteCreate,
  toDeliverableArticle,
  toDeliverableChallenge,
  toDeliverableReply,
} from './deliver.ts'
import { toCryptoKeyPair } from './keys.ts'
import { AS_PUBLIC, isPubliclyVisible } from './object.ts'
import { temporalInstantToDate } from './temporal-interop.ts'
import { capabilityTokenFrom, createAurbodaEnricher } from './timeline-enrich.ts'
import {
  extractNoteImages,
  noteMentionsActor,
  noteToTimelineInput,
  type TimelineAuthor,
  type TimelineBoostSource,
} from './timeline-ingest.ts'

/** Posts per outbox page (cursor pagination). */
const OUTBOX_PAGE_SIZE = 20

/** RFC 4122 canonical form — guards `getFeedPostById` from a non-UUID `postId`
 * (Postgres would otherwise raise `invalid input syntax for type uuid`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The local follower (inbox owner) that an `Accept`/`Reject` response to a Follow
 * WE sent belongs to. Derived from the inner Follow's `actor` (which is our
 * actor), so it works whether the response lands on the personal OR a shared
 * inbox; falls back to `ctx.recipient` (null on the shared inbox) if the remote
 * didn't embed the Follow. `suppressError` so an unresolvable inner object yields
 * null rather than throwing a 500 that invites retries. Returns null if no valid
 * local user can be determined.
 */
const localFollowerIdentifier = async (
  ctx: InboxContext<void>,
  response: Accept | Reject,
): Promise<string | null> => {
  const object = await response.getObject({ suppressError: true })
  if (object instanceof Follow && object.actorId != null) {
    const parsed = ctx.parseUri(object.actorId)
    if (parsed?.type === 'actor' && isValidUsername(parsed.identifier)) return parsed.identifier
  }
  const recipient = ctx.recipient
  return recipient != null && isValidUsername(recipient) ? recipient : null
}

/**
 * Persist an inbound follower and decide whether to accept it now. Auto-accepts
 * unless the target user requires manual approval — but an already *accepted*
 * follower re-sending a Follow stays accepted (a re-delivery never demotes them).
 * Caches the follower's presentation (so the approval UI can show who's asking)
 * and the Follow's id (echoed in a deferred Accept/Reject). Returns the acceptance
 * decision, or null if the target user's DB doesn't exist (a Follow to a
 * nonexistent actor — ignore it) or the sender lacks an id/inbox.
 */
const recordInboundFollow = async (
  user: string,
  sender: Actor,
  followActivityUri: string | null,
): Promise<boolean | null> => {
  if (sender.id == null || sender.inboxId == null) return null
  try {
    const settings = await getUserSettings(user)
    const existing = await getFeedFollowerByActor(user, sender.id.href)
    const accepted = existing?.accepted === true || settings?.manually_approve_followers !== true
    const presentation = await extractActorPresentation(sender)
    await upsertFeedFollower(user, {
      accepted,
      actor_uri: sender.id.href,
      avatar_url: presentation.avatar_url,
      display_name: presentation.display_name,
      follow_activity_uri: followActivityUri,
      handle: presentation.handle,
      inbox_uri: sender.inboxId.href,
      shared_inbox_uri: sender.endpoints?.sharedInbox?.href ?? null,
    })
    return accepted
  } catch (error) {
    if (isMissingDatabase(error)) return null
    throw error
  }
}

/**
 * Ingest one `Note` from an accepted followee into `user`'s home timeline: map it
 * to a timeline entry (author from the cached `feed_following` row, content
 * sanitised), capture its image attachments, best-effort fetch the native Aurboda
 * structured chart, and upsert keyed on the Note's id (so a redelivery or edit
 * replaces in place). `onNewEntry` fires only for a genuinely new row — the
 * on-follow backfill omits it, since its historical posts aren't "new".
 *
 * Shared by inbound `Create`/`Update` delivery and the backfill, so both build a
 * timeline entry identically.
 */
export const ingestNoteForRecipient = async (
  user: string,
  note: Note,
  author: TimelineAuthor,
  enrich: (objectUri: string, token?: string) => Promise<FeedStructuredPost | null>,
  onNewEntry?: (user: string) => void,
  /** Web origin — enables Mention detection against the recipient's actor URI (#1060). */
  origin?: string,
  /** When set, the row becomes a BOOST card of `note` (an `Announce` by a followee). */
  boost?: TimelineBoostSource,
): Promise<void> => {
  const input = noteToTimelineInput(note, author, Date.now(), boost)
  if (input == null) return
  // Capture the Note's image attachments (rendered chart / route map, or a
  // Mastodon photo) so the timeline can show them when there's no native chart.
  const images = await extractNoteImages(note)
  // A Mention of the recipient keeps the post visible + notifying whatever the
  // reply setting says (Mastodon-style involvement).
  const mentionsMe = origin == null ? false : await noteMentionsActor(note, ownActorUri(origin, user))
  // Best-effort: fetch the native structured payload if this is an Aurboda post
  // (null otherwise). A followers-only post authorizes the fetch with the same
  // capability token embedded in its delivered image URL. Stored on the entry so
  // the web can render a native chart in place of the image. Keyed on the NOTE's
  // id — on a boost card `object_uri` is the Announce id, which no peer serves.
  const structured = await enrich(input.boost_of_uri ?? input.object_uri, capabilityTokenFrom(images))
  const { inserted } = await upsertTimelineEntry(user, {
    ...input,
    images,
    mentions_me: mentionsMe,
    structured,
  })
  if (inserted) onNewEntry?.(user)
}

/** How long to wait for a boosted Note (usually a bare id Mastodon expects us to fetch). */
const BOOST_OBJECT_TIMEOUT_MS = 10_000

/** How long to wait for a remote ACTOR document (a boosted Note's author, or a reactor). */
const ACTOR_LOOKUP_TIMEOUT_MS = 5_000

/**
 * The local feed-post id an inbound `Like`/`Announce` targets, or null when its
 * object isn't one of the recipient's OWN post Notes. The `identifier === me`
 * check is the authorization: a reaction addressed to someone else's post (or to
 * a non-post URL on this host) must never touch this user's records.
 */
const ownTargetPostId = (ctx: InboxContext<void>, objectId: URL | null, me: string): string | null => {
  if (objectId == null) return null
  const parsed = ctx.parseUri(objectId)
  if (parsed?.type !== 'object' || parsed.class !== Note) return null
  const identifier = parsed.values.identifier
  const postId = parsed.values.postId
  if (identifier !== me || !isValidUsername(identifier) || postId == null || !UUID_RE.test(postId)) {
    return null
  }
  return postId
}

/**
 * Record an inbound `Like`/`Announce` of one of the recipient's OWN posts, so
 * the owner can see who favourited / boosted it. Open to any sender (Mastodon
 * doesn't require a follow to favourite), but strictly scoped to a post that is
 * ours and still exists.
 *
 * The presentation snapshot is fetched from the sender's actor **id**, never
 * read off an actor inlined in the activity: an embedded actor is
 * attacker-controlled, so its `preferredUsername`/`name` could show a forged
 * byline under a valid id. Best-effort — an unresolvable actor still leaves a
 * countable reaction, just an anonymous one.
 */
const recordOwnPostReaction = async (
  ctx: InboxContext<void>,
  activity: Announce | Like,
  kind: FeedReactionKind,
): Promise<void> => {
  const me = ctx.recipient
  if (me == null || !isValidUsername(me) || activity.actorId == null) return
  const postId = ownTargetPostId(ctx, activity.objectId, me)
  if (postId == null) return
  try {
    if ((await getFeedPostById(me, postId)) == null) return
    const sender = await withTimeout(ctx.lookupObject(activity.actorId), ACTOR_LOOKUP_TIMEOUT_MS).catch(
      () => null,
    )
    const presentation =
      isActor(sender) && sender.id?.href === activity.actorId.href
        ? await extractActorPresentation(sender)
        : { avatar_url: null, display_name: null, handle: null }
    await upsertFeedPostReaction(me, {
      activity_uri: activity.id?.href ?? null,
      actor_uri: activity.actorId.href,
      avatar_url: presentation.avatar_url,
      display_name: presentation.display_name,
      handle: presentation.handle,
      kind,
      post_id: postId,
    })
  } catch (error) {
    if (isMissingDatabase(error)) return
    throw error
  }
}

/**
 * The boosted Note's author, for the boost card's snapshot: the cached
 * `feed_following` row when we already follow them (no network), else the actor
 * document **fetched from the attribution id**.
 *
 * Never `note.getAttribution()`: Fedify returns an actor inlined in the Note
 * without fetching anything, so a hostile booster could embed a `Person` with
 * any `preferredUsername`/`name` under a real person's id and we would store a
 * forged byline. Fetching by id means the claimed actor's own server is the only
 * thing that can describe them; the returned document must still carry exactly
 * that id (`lookupObject` also refuses a cross-origin `@id`).
 */
const resolveBoostAuthor = async (
  ctx: InboxContext<void>,
  me: string,
  attributionId: URL,
): Promise<TimelineAuthor | null> => {
  const followed = await getFeedFollowingByActor(me, attributionId.href)
  if (followed != null) return followed
  const actor = await withTimeout(ctx.lookupObject(attributionId), ACTOR_LOOKUP_TIMEOUT_MS).catch(() => null)
  if (!isActor(actor) || actor.id == null || actor.id.href !== attributionId.href) return null
  const presentation = await extractActorPresentation(actor)
  return { ...presentation, actor_uri: attributionId.href }
}

/** An `Announce`'s validated object: the Note, its id, and who it attributes to. */
interface AnnouncedNote {
  note: Note
  /** The announced Note's own id — the boost card's `boost_of_uri`. */
  uri: string
  attributionId: URL
}

/**
 * The Note an `Announce` points at, **always fetched from `announce.objectId`**
 * — an object embedded in the activity body is ignored outright.
 *
 * That is the whole security of a boost card. `announce.getObject()` hands back
 * an inlined object without any fetch, so a followee could deliver an `Announce`
 * carrying a `Note` with any `id` and `attributedTo` they chose, and every
 * downstream check (id host, attribution host, author id) would be satisfied by
 * data they wrote — storing forged content under a real person's handle.
 * Dereferencing by id makes the claimed origin server the only source of the
 * post's content and byline. Mastodon sends a bare id anyway, so this is also
 * the normal path.
 *
 * Two further rejections: the fetched object must be a `Note` whose id is on the
 * **same host as the announced id** (a redirect can't swap in a document from
 * somewhere else — `lookupObject` refuses a cross-origin `@id` too), and it must
 * declare `attributedTo` (there is no other honest source for the author).
 */
const resolveAnnouncedNote = async (
  ctx: InboxContext<void>,
  objectId: URL,
): Promise<AnnouncedNote | null> => {
  const note = await withTimeout(ctx.lookupObject(objectId), BOOST_OBJECT_TIMEOUT_MS).catch(() => null)
  if (!(note instanceof Note) || note.id == null || note.id.host !== objectId.host) return null
  const attributionId = note.attributionIds[0]
  return attributionId == null ? null : { attributionId, note, uri: note.id.href }
}

/** The parts of an `Announce` a boost card is built from, once self-consistent. */
interface ValidatedAnnounce {
  actorId: URL
  /** The `Announce`'s own id — the boost card's `object_uri`. */
  announceUri: string
  objectId: URL
}

/**
 * The `Announce`'s own identity, or null when it can't back a boost card.
 *
 * Beyond the ids simply being present, the activity id must be **on the
 * booster's host**: it becomes the card's `object_uri`, which is the GLOBAL
 * upsert key, so it needs the same origin check `noteToTimelineInput` applies
 * to a direct Note's id. Without it an accepted followee could announce a real
 * third-party post under an id equal to another followee's existing entry and
 * overwrite that entry with a boost card of their choosing (then evict it with
 * an `Undo{Announce}`, since the row would name them as the booster). Mastodon
 * mints `…/statuses/<n>/activity` on the actor's own host.
 */
const validateAnnounce = (announce: Announce): ValidatedAnnounce | null => {
  const { actorId, id, objectId } = announce
  if (actorId == null || id == null || objectId == null) return null
  return id.host === actorId.host ? { actorId, announceUri: id.href, objectId } : null
}

/**
 * A followee boosted somebody else's post → a **boost card** in our timeline
 * (Mastodon's "🔄 X boosted"). The card is its own row keyed on the `Announce`
 * id, describing the ORIGINAL post and author, with the booster in
 * `boosted_by_*` — see `TimelineBoostSource`.
 *
 * Guards, in order: the `Announce` must be self-consistent (see
 * `validateAnnounce` — its id is the card's upsert key); only an **accepted
 * followee** can boost into our timeline; the announced Note and its author are
 * **fetched from their own ids**, never taken from the activity body (see
 * `resolveAnnouncedNote`); the Note must be on the same host as the announced id
 * and declare `attributedTo`; and a post ALREADY in this timeline directly gets
 * no boost card (Mastodon hides a reblog of a post you have).
 */
const ingestBoostedNote = async (
  ctx: InboxContext<void>,
  announce: Announce,
  origin: string,
  onNewEntry?: (user: string) => void,
  enrich: (objectUri: string, token?: string) => Promise<FeedStructuredPost | null> = async () => null,
): Promise<void> => {
  const me = ctx.recipient
  const valid = validateAnnounce(announce)
  if (me == null || !isValidUsername(me) || valid == null) return
  try {
    const booster = await getFeedFollowingByActor(me, valid.actorId.href)
    if (booster == null || !booster.accepted) return
    const announced = await resolveAnnouncedNote(ctx, valid.objectId)
    if (announced == null) return
    if ((await getTimelineEntryByObjectUri(me, announced.uri)) != null) return
    const author = await resolveBoostAuthor(ctx, me, announced.attributionId)
    if (author == null) return
    await ingestNoteForRecipient(me, announced.note, author, enrich, onNewEntry, origin, {
      actor_uri: booster.actor_uri,
      announce_uri: valid.announceUri,
      display_name: booster.display_name,
      handle: booster.handle,
      published_at: announce.published == null ? new Date() : temporalInstantToDate(announce.published),
    })
  } catch (error) {
    if (isMissingDatabase(error)) return
    throw error
  }
}

/**
 * Retract an inbound reaction whose inner `Like`/`Announce` resolved: drop the
 * `feed_post_reaction` row when it targeted one of OUR posts, and — for an
 * `Announce` — the boost card that Announce put in our timeline. Both deletes
 * are scoped to `undo.actorId`, so a signed Undo only ever removes its own
 * actor's reaction.
 */
const undoInboundReaction = async (
  ctx: InboxContext<void>,
  undo: Undo,
  inner: Announce | Like,
  kind: FeedReactionKind,
): Promise<void> => {
  const me = ctx.recipient
  if (me == null || !isValidUsername(me) || undo.actorId == null) return
  const postId = ownTargetPostId(ctx, inner.objectId, me)
  if (postId != null) await removeFeedPostReaction(me, postId, kind, undo.actorId.href)
  if (kind !== 'announce') return
  const announceUri = inner.id?.href ?? undo.objectId?.href
  if (announceUri != null) await deleteBoostEntry(me, announceUri, undo.actorId.href)
}

/**
 * Fallback retraction for an `Undo` whose inner object didn't resolve (a bare
 * activity URI the remote 404s after undoing): match on the activity id we
 * recorded. Scoped to the undoing actor, like every other retraction.
 */
const undoReactionByActivityId = async (ctx: InboxContext<void>, undo: Undo): Promise<void> => {
  const me = ctx.recipient
  if (me == null || !isValidUsername(me) || undo.actorId == null || undo.objectId == null) return
  await removeFeedPostReactionByActivity(me, undo.objectId.href, undo.actorId.href)
  await deleteBoostEntry(me, undo.objectId.href, undo.actorId.href)
}

/**
 * Inbound `Like` — someone favourited one of our posts. Exported (like the
 * `Announce`/`Undo` entry points below) so the inbox behaviour is testable
 * without forging an HTTP signature: the listener is a one-line delegation.
 */
export const handleInboundLike = (ctx: InboxContext<void>, like: Like): Promise<void> =>
  recordOwnPostReaction(ctx, like, 'like')

/**
 * Inbound `Announce`. Two distinct meanings share the type: a boost of one of
 * OUR posts is a reaction to record (from anyone — a boost needs no follow); a
 * boost of a THIRD-PARTY post by an accepted followee is a boost card for our
 * timeline. Our own post never becomes a timeline entry of our own.
 */
export const handleInboundAnnounce = async (
  ctx: InboxContext<void>,
  announce: Announce,
  origin: string,
  onNewEntry?: (user: string) => void,
  enrich?: (objectUri: string, token?: string) => Promise<FeedStructuredPost | null>,
): Promise<void> => {
  const me = ctx.recipient
  if (me == null || !isValidUsername(me)) return
  if (ownTargetPostId(ctx, announce.objectId, me) != null) {
    return await recordOwnPostReaction(ctx, announce, 'announce')
  }
  await ingestBoostedNote(ctx, announce, origin, onNewEntry, enrich)
}

/**
 * Inbound `Undo` of a Follow (drop the follower), a Like or an Announce (retract
 * the reaction, and for an Announce the boost card it created).
 *
 * `suppressError` so an unresolvable inner object (a bare activity URI the
 * remote 404s after undoing) yields null and falls back to matching on that id,
 * rather than throwing a 500 that invites retries. Mastodon embeds the full
 * activity, so the common case resolves.
 */
export const handleInboundUndo = async (ctx: InboxContext<void>, undo: Undo): Promise<void> => {
  if (undo.actorId == null) return
  const object = await undo.getObject({ suppressError: true })
  try {
    if (object instanceof Like) return await undoInboundReaction(ctx, undo, object, 'like')
    if (object instanceof Announce) return await undoInboundReaction(ctx, undo, object, 'announce')
    if (!(object instanceof Follow)) return await undoReactionByActivityId(ctx, undo)
    if (object.objectId == null) return
    const target = ctx.parseUri(object.objectId)
    if (target?.type !== 'actor' || !isValidUsername(target.identifier)) return
    await removeFeedFollower(target.identifier, undo.actorId.href)
  } catch (error) {
    if (isMissingDatabase(error)) return
    throw error
  }
}

/**
 * Ingest a `Create`/`Update` of a `Note` into the recipient's home timeline.
 * Two admissible senders (anything else is dropped, so a stranger can't inject
 * arbitrary posts into our timeline by delivering to the inbox):
 *
 * - an *accepted* followee — any of their Notes;
 * - **any actor whose Note is a reply to one of the recipient's own, still
 *   existing posts** (#1060) — the Mastodon-style mention interaction, so a
 *   stranger's "replied to you" shows up (and notifies) like it would there.
 *   The author snapshot comes from the signature-verified sender actor.
 *
 * Best-effort: unresolvable objects and non-Notes are ignored, and a missing DB
 * never 500s (which would invite retries).
 */
/**
 * The stranger branch of {@link ingestFeedActivity}: admit a non-followee's
 * Note only when the recipient is INVOLVED — it replies to one of their own,
 * still existing posts, or Mentions them. The author snapshot comes from the
 * signature-verified sender actor.
 */
const ingestStrangerInvolvement = async (
  ctx: InboxContext<void>,
  activity: Create | Update,
  object: Note,
  me: string,
  origin: string,
  enrich: (objectUri: string, token?: string) => Promise<FeedStructuredPost | null>,
  onNewEntry?: (user: string) => void,
): Promise<void> => {
  if (activity.actorId == null) return
  const target = object.replyTargetIds[0]?.href
  const prefix = ownObjectPrefix(origin, me)
  const postId = target?.startsWith(prefix) ? target.slice(prefix.length) : null
  const isReplyToOwnPost =
    postId != null && UUID_RE.test(postId) && (await getFeedPostById(me, postId)) != null
  if (!isReplyToOwnPost) {
    const myActor = ownActorUri(origin, me)
    if (!(await noteMentionsActor(object, myActor))) return
  }
  // Require EXPLICIT attribution to the signing actor BEFORE the actor fetch —
  // `noteToTimelineInput` enforces the same rule (#1018), but only after we'd
  // have paid a network round-trip for a Note we were always going to drop.
  if (!object.attributionIds.some((uri) => uri.href === activity.actorId?.href)) return
  // Fedify verified the HTTP signature as `activity.actorId`; fetch that actor
  // for the presentation snapshot (handle / name / avatar).
  const sender = await activity.getActor(ctx)
  if (sender?.id == null || sender.id.href !== activity.actorId.href) return
  const presentation = await extractActorPresentation(sender)
  await ingestNoteForRecipient(
    me,
    object,
    { ...presentation, actor_uri: activity.actorId.href },
    enrich,
    onNewEntry,
    origin,
  )
}

const ingestFeedActivity = async (
  ctx: InboxContext<void>,
  activity: Create | Update,
  origin: string,
  onNewEntry?: (user: string) => void,
  /** Best-effort fetch of the post's native Aurboda structured data (null if not an Aurboda post). */
  enrich: (objectUri: string, token?: string) => Promise<FeedStructuredPost | null> = async () => null,
): Promise<void> => {
  // The recipient (whose timeline this is) comes from the personal inbox owner.
  // Unlike Accept/Reject there's no inner Follow to derive it from, so this relies
  // on personal-inbox delivery; `ctx.recipient` is null on a shared inbox. That's
  // fine today (the actor advertises no `sharedInbox`), but shared-inbox support
  // would need fanning a single delivery out to every local follower of the actor.
  const me = ctx.recipient
  if (me == null || !isValidUsername(me) || activity.actorId == null) return
  try {
    const follow = await getFeedFollowingByActor(me, activity.actorId.href)
    const object = await activity.getObject({ suppressError: true })
    if (!(object instanceof Note)) return
    if (follow != null && follow.accepted) {
      return await ingestNoteForRecipient(me, object, follow, enrich, onNewEntry, origin)
    }
    await ingestStrangerInvolvement(ctx, activity, object, me, origin, enrich, onNewEntry)
  } catch (error) {
    if (isMissingDatabase(error)) return
    throw error
  }
}

/**
 * Build a user's full `Person` actor document — shared by the actor dispatcher
 * and the profile-change `Update{Person}` delivery, so followers' servers
 * always receive exactly the representation the actor URL serves. The icon URL
 * carries the avatar's `updated_at` as a cache-busting `?v=`: remote servers
 * (Mastodon et al.) copy a remote avatar once and re-download it only when the
 * URL changes, so a changed avatar must change the URL.
 */
export const buildActorPerson = async (
  ctx: Context<void>,
  identifier: string,
  origin: string,
): Promise<Person | null> => {
  if (!isValidUsername(identifier)) return null
  let keys
  try {
    keys = await ctx.getActorKeyPairs(identifier)
  } catch (error) {
    if (isMissingDatabase(error)) return null
    throw error
  }
  if (keys.length === 0) return null
  // Advertise "locked account" when the user requires manual approval, so
  // Mastodon et al. show a follow *request* and hold the follow pending
  // (matching our own inbox behaviour of deferring the Accept).
  const settings = await getUserSettings(identifier)
  // Avatar served on the web host; always resolves (identicon fallback), so
  // remote servers always have an actor icon to show. No `?v=` while the
  // deterministic identicon is in use — the transition to a first upload
  // changes the URL by adding one.
  const avatarVersion = await getProfileAvatarVersion(identifier)
  const iconUrl = new URL(`${buildProfileUrl(origin, identifier)}/avatar.png`)
  if (avatarVersion) iconUrl.searchParams.set('v', String(avatarVersion.getTime()))
  return new Person({
    followers: ctx.getFollowersUri(identifier),
    following: ctx.getFollowingUri(identifier),
    icon: new Image({ url: iconUrl }),
    id: ctx.getActorUri(identifier),
    inbox: ctx.getInboxUri(identifier),
    manuallyApprovesFollowers: settings?.manually_approve_followers === true,
    outbox: ctx.getOutboxUri(identifier),
    preferredUsername: identifier,
    publicKey: keys[0].cryptographicKey,
    // The human-facing profile page. Mastodon-class clients link people
    // here instead of the actor document (whose content negotiation
    // answers 406 to a browser — see the HTML fallback router, #1047).
    url: new URL(buildProfileUrl(origin, identifier)),
  })
}

/**
 * Deliver an `Update{Person}` to the user's accepted followers after a profile
 * change (avatar upload/removal). Without it, a follower's server never
 * refreshes its cached copy of the actor: Mastodon re-downloads an avatar only
 * on an incoming actor Update or a changed icon URL, and until now Aurboda
 * produced neither signal. Fire-and-forget at the call site — a delivery
 * failure must never fail the profile change itself.
 */
export const deliverActorUpdate = async (
  deps: { federation: Federation<void>; origin: string },
  user: string,
): Promise<void> => {
  const ctx = await deps.federation.createContext(new URL(deps.origin))
  const person = await buildActorPerson(ctx, user, deps.origin)
  if (person?.id == null) return
  const update = new Update({
    actor: person.id,
    cc: ctx.getFollowersUri(user),
    // Mastodon-style per-change id fragment; profile updates are not
    // dereferenceable objects, so uniqueness is all the id needs.
    id: new URL(`${person.id.href}#updates/${Date.now()}`),
    object: person,
    to: new URL(AS_PUBLIC),
  })
  await ctx.sendActivity({ identifier: user }, 'followers', update)
}

export const createFeedFederation = (
  origin: string,
  apiBaseUrl: string,
  /** Fire-and-forget: called with the recipient when a genuinely new post is ingested. */
  onNewTimelineEntry?: (user: string) => void,
  /**
   * Fire-and-forget: called with `(recipient, followeeActorUri)` when a follow WE
   * sent becomes accepted, to backfill the followee's recent public posts.
   */
  onFollowAccepted?: (user: string, actorUri: string) => void,
  /** Deployed software version (BUILD_SHA), reported in NodeInfo. */
  version = 'dev',
  /** Whether anyone can sign up (`signup_mode = 'open'`), reported as NodeInfo `openRegistrations` (#1050). */
  isSignupOpen: () => Promise<boolean> = async () => false,
): Federation<void> => {
  const federation = createFederation<void>({
    kv: new MemoryKvStore(),
    // Pin the canonical origin (the public base URL) so actor ids, WebFinger
    // self-links, inbox/outbox URIs, etc. are always built with the right
    // scheme + host — Mastodon requires https, and reconstructing the scheme
    // from the request yields http behind the TLS-terminating proxy.
    origin,
    // No message queue: `sendActivity` then delivers synchronously (awaits the
    // POST). An in-process queue would need `federation.startQueue()` to drain —
    // which the Express integration doesn't run — so queued activities (e.g. the
    // Create on share) would never send. A persistent Postgres queue + worker is
    // a later reliability slice; synchronous delivery is correct for now.
  })

  // Fetches native structured data (typed metrics + series) for ingested posts
  // that come from Aurboda instances, so the web can render a native chart.
  const enrich = createAurbodaEnricher(origin)

  // NodeInfo instance metadata (#1047). Fedify serves the `/.well-known/nodeinfo`
  // JRD automatically once a dispatcher is registered; peers and crawlers use it
  // to identify the software (some, like FitPub, gate follow-ability on it).
  // Usage statistics are deliberately absent/zero: the per-user-database
  // architecture has no cheap global user or post counts, and NodeInfo allows
  // omitting `users.total`.
  federation.setNodeInfoDispatcher('/nodeinfo/2.1', async () => ({
    openRegistrations: await isSignupOpen().catch(() => false),
    protocols: ['activitypub'],
    software: {
      name: 'aurboda',
      repository: new URL('https://github.com/fiddur/aurboda'),
      version,
    },
    usage: { localComments: 0, localPosts: 0, users: {} },
  }))

  federation
    .setActorDispatcher('/users/{identifier}', (ctx, identifier) => buildActorPerson(ctx, identifier, origin))
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return []
      try {
        const kp = await getOrCreateActorKeyPair(identifier)
        return [await toCryptoKeyPair(kp.private_key_pem, kp.public_key_pem)]
      } catch (error) {
        if (isMissingDatabase(error)) return []
        throw error
      }
    })
    .mapHandle((_ctx, username) => (isValidUsername(username) ? username : null))

  // Inbound inbox. Fedify verifies the HTTP Signature before invoking these
  // handlers, so a request that reaches `.on(...)` is authenticated as the
  // sending actor. Unregistered activity types are silently ignored.
  federation
    .setInboxListeners('/users/{identifier}/inbox', '/inbox')
    .on(Follow, async (ctx, follow) => {
      // The Follow must target one of our actors.
      if (follow.objectId == null) return
      const target = ctx.parseUri(follow.objectId)
      if (target?.type !== 'actor' || !isValidUsername(target.identifier)) return

      const sender = await follow.getActor(ctx)
      if (sender?.id == null || sender.inboxId == null) return

      const accepted = await recordInboundFollow(target.identifier, sender, follow.id?.href ?? null)
      // In manual-approval mode a new/pending follow gets no Accept yet — the
      // owner approves it later (which sends the Accept). `null` means no such
      // user (missing DB). Only an accepted follow is answered now, so the remote
      // server marks it established.
      if (accepted !== true) return
      await ctx.sendActivity(
        { identifier: target.identifier },
        sender,
        new Accept({ actor: follow.objectId, object: follow }),
      )
    })
    .on(Undo, handleInboundUndo)
    .on(Accept, async (ctx, accept) => {
      // Accept of a Follow WE sent — the followee's server confirms the follow.
      // `accept.actorId` is the followee we followed, matching the `actor_uri` of
      // our pending row.
      const me = await localFollowerIdentifier(ctx, accept)
      if (me == null || accept.actorId == null) return
      try {
        await markFeedFollowingAccepted(me, accept.actorId.href)
      } catch (error) {
        if (isMissingDatabase(error)) return
        throw error
      }
      // The follow is now established → backfill the followee's recent public
      // posts so the timeline isn't empty until they next post. Fire-and-forget
      // (a slow/large outbox must never block inbox processing), and after the
      // accept is durably recorded. Covers remote *and* local follows: a local
      // followee's auto-Accept loops back through this same handler.
      onFollowAccepted?.(me, accept.actorId.href)
    })
    .on(Reject, async (ctx, reject) => {
      // Reject of a Follow we sent — the followee declined; drop our pending row.
      const me = await localFollowerIdentifier(ctx, reject)
      if (me == null || reject.actorId == null) return
      try {
        await removeFeedFollowingByActor(me, reject.actorId.href)
      } catch (error) {
        if (isMissingDatabase(error)) return
        throw error
      }
    })
    // Create / Update of a Note from an actor we follow → ingest into our home
    // timeline. Update reuses the same upsert (keyed on the Note's object id), so
    // an edit replaces the stored copy. Accepted followees are ingested in full;
    // the only stranger Note admitted is a reply to one of the recipient's own
    // posts (see ingestFeedActivity).
    .on(Create, (ctx, create) => ingestFeedActivity(ctx, create, origin, onNewTimelineEntry, enrich))
    .on(Update, (ctx, update) => ingestFeedActivity(ctx, update, origin, onNewTimelineEntry, enrich))
    // Someone favourited one of OUR posts → record who, for the owner's card.
    .on(Like, handleInboundLike)
    // A boost: of our own post (record the reaction) or of a third party's, by
    // an accepted followee (a boost card in our timeline).
    .on(Announce, (ctx, announce) => handleInboundAnnounce(ctx, announce, origin, onNewTimelineEntry, enrich))
    .on(Delete, async (ctx, del) => {
      // Delete of a post we received → drop it from the timeline. `del.objectId`
      // is the removed object's id (a Tombstone or bare id); we key on it, but
      // scope the delete to the sender (`del.actorId`) so a signed `Delete` from
      // some other actor can't evict a post it didn't author — mirroring how
      // `Undo{Follow}` is scoped to its own actor.
      const me = ctx.recipient
      if (me == null || !isValidUsername(me) || del.objectId == null || del.actorId == null) return
      try {
        await deleteTimelineEntryByUri(me, del.objectId.href, del.actorId.href)
      } catch (error) {
        if (isMissingDatabase(error)) return
        throw error
      }
    })

  // Individual post object. Serves the same `Note` that was delivered, at its
  // canonical id, so a remote server can dereference it. Only `public`/`unlisted`
  // objects resolve — `followers`-only posts are delivered with the object
  // inline, so their id never needs to be fetched; refusing them keeps
  // follower-only content off an unauthenticated fetch.
  federation.setObjectDispatcher(
    Note,
    '/users/{identifier}/feed/{postId}',
    async (ctx, { identifier, postId }) => {
      if (!isValidUsername(identifier) || !UUID_RE.test(postId)) return null
      let post
      try {
        post = await getFeedPostById(identifier, postId)
      } catch (error) {
        if (isMissingDatabase(error)) return null
        throw error
      }
      if (post == null || !isPubliclyVisible(post.visibility)) return null
      // An article and an activity share this Note id (a post is one or the
      // other). An article's Note is built from its stored content — no activity.
      const article = toDeliverableArticle(post)
      if (article != null) return buildArticleNote(ctx, identifier, article, apiBaseUrl)
      const challenge = toDeliverableChallenge(post)
      if (challenge != null) return buildChallengeNote(ctx, identifier, challenge)
      const reply = toDeliverableReply(post)
      if (reply != null) return buildReplyNote(ctx, identifier, reply)
      if (post.activity_id == null) return null
      // Resolve the merged-span activity so the served Note matches what the user
      // shared (and what we delivered), not just the anchor sub-activity (#881).
      const activity = await resolveFeedActivity(identifier, post.activity_id)
      if (activity == null) return null
      return buildFeedNote(ctx, identifier, post, activity, apiBaseUrl)
    },
  )

  // Outbox: the user's public + unlisted posts as `Create` activities, so a
  // Mastodon profile shows them. Cursor-paginated (`OUTBOX_PAGE_SIZE` per page)
  // so an unauthenticated fetch never resolves every post's scalars at once; the
  // cursor is a simple offset (a concurrent share can shift a page boundary —
  // acceptable for an occasionally-crawled outbox). A post whose activity was
  // soft-deleted is skipped from the items while `setCounter` still counts it;
  // the divergence self-heals when the stale post is removed.
  federation
    .setOutboxDispatcher('/users/{identifier}/outbox', async (ctx, identifier, cursor) => {
      if (!isValidUsername(identifier)) return null
      const offset = cursor == null ? 0 : Number.parseInt(cursor, 10)
      // `isSafeInteger` also rejects absurd offsets (e.g. a crafted `1e20`) that
      // would overflow Postgres `bigint` in `OFFSET` and 500 the request.
      if (!Number.isSafeInteger(offset) || offset < 0) return null
      let posts
      try {
        posts = await listPublicFeedPostsPage(identifier, OUTBOX_PAGE_SIZE, offset)
      } catch (error) {
        if (isMissingDatabase(error)) return null
        throw error
      }
      const items = (
        await Promise.all(
          posts.map(async (post) => {
            // Articles federate as `Create{Note}` built from their stored content
            // (no linked activity); every other post as `Create{Note}` from its
            // resolved activity.
            const article = toDeliverableArticle(post)
            if (article != null) return buildArticleNoteCreate(ctx, identifier, article, apiBaseUrl)
            const challenge = toDeliverableChallenge(post)
            if (challenge != null) return buildChallengeNoteCreate(ctx, identifier, challenge)
            const reply = toDeliverableReply(post)
            if (reply != null) return buildReplyNoteCreate(ctx, identifier, reply)
            if (post.activity_id == null) return null
            const activity = await resolveFeedActivity(identifier, post.activity_id)
            return activity == null ? null : buildFeedCreate(ctx, identifier, post, activity, apiBaseUrl)
          }),
        )
      ).filter((item): item is Create => item != null)
      const nextCursor = posts.length === OUTBOX_PAGE_SIZE ? String(offset + OUTBOX_PAGE_SIZE) : null
      return { items, nextCursor }
    })
    .setCounter(async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return 0
      try {
        return await countPublicFeedPosts(identifier)
      } catch (error) {
        if (isMissingDatabase(error)) return 0
        throw error
      }
    })
    .setFirstCursor((_ctx, identifier) => (isValidUsername(identifier) ? '0' : null))
    .setLastCursor(async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return null
      try {
        const count = await countPublicFeedPosts(identifier)
        // Offset of the last page; '0' for an empty or single-page outbox.
        return count <= OUTBOX_PAGE_SIZE
          ? '0'
          : String(Math.floor((count - 1) / OUTBOX_PAGE_SIZE) * OUTBOX_PAGE_SIZE)
      } catch (error) {
        if (isMissingDatabase(error)) return null
        throw error
      }
    })

  // Real followers, backed by feed_follower. This both serves the followers
  // collection and enumerates recipients for `sendActivity(..., 'followers', …)`.
  federation
    .setFollowersDispatcher('/users/{identifier}/followers', async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return { items: [] }
      try {
        // Only *accepted* followers are published + delivered to (a pending
        // request isn't a confirmed follower and gets no `followers`-only posts).
        const followers = await listFeedFollowers(identifier, { accepted: true })
        return {
          items: followers.map((f) => ({
            endpoints: f.shared_inbox_uri ? { sharedInbox: new URL(f.shared_inbox_uri) } : null,
            id: new URL(f.actor_uri),
            inboxId: new URL(f.inbox_uri),
          })),
        }
      } catch (error) {
        if (isMissingDatabase(error)) return { items: [] }
        throw error
      }
    })
    .setCounter(async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return 0
      try {
        return await countFeedFollowers(identifier)
      } catch (error) {
        if (isMissingDatabase(error)) return 0
        throw error
      }
    })

  // The actors this user follows, backed by feed_following. Only *accepted*
  // follows are published (a pending follow isn't a confirmed relationship yet).
  // Items are the followees' actor URIs.
  federation
    .setFollowingDispatcher('/users/{identifier}/following', async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return { items: [] }
      try {
        const following = await listAcceptedFeedFollowing(identifier)
        return { items: following.map((f) => new URL(f.actor_uri)) }
      } catch (error) {
        if (isMissingDatabase(error)) return { items: [] }
        throw error
      }
    })
    .setCounter(async (_ctx, identifier) => {
      if (!isValidUsername(identifier)) return 0
      try {
        return await countAcceptedFeedFollowing(identifier)
      } catch (error) {
        if (isMissingDatabase(error)) return 0
        throw error
      }
    })

  return federation
}
