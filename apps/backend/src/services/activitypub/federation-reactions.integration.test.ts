import type { InboxContext } from '@fedify/fedify'

import { Announce, Like, Note, Person, Undo } from '@fedify/fedify/vocab'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Inbox behaviour for likes ⭐ and boosts 🔄, against a real per-user database.
 *
 * The listeners are exercised through the exported `handleInbound*` entry points
 * the `.on(...)` registrations delegate to, with a real Fedify context wearing a
 * `recipient` (an inbox delivery is signature-verified before the listener runs,
 * so forging a signed request here would test Fedify, not us). Every activity
 * embeds its objects inline, the way Mastodon delivers them, so nothing is
 * fetched over the network.
 */
import { insertActivity } from '../../db/activities/index.ts'
import { markFeedFollowingAccepted, upsertFeedFollowing } from '../../db/feed-following.ts'
import { listFeedPostReactions } from '../../db/feed-reactions.ts'
import { createFeedPost } from '../../db/feed.ts'
import { listTimelineEntries, upsertTimelineEntry } from '../../db/timeline.ts'
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../../test/db-test-helper.ts'
import {
  createFeedFederation,
  handleInboundAnnounce,
  handleInboundLike,
  handleInboundUndo,
} from './federation.ts'
import { dateToTemporalInstant } from './temporal-interop.ts'

const CONTAINER_TIMEOUT = 120_000
const ORIGIN = 'https://aurboda.example'
const ALICE = 'https://mastodon.example/users/alice'
const CAROL = 'https://third.example/users/carol'

const fed = createFeedFederation(ORIGIN, `${ORIGIN}/api`)

/** A stub document loader: the fediverse documents this test makes available. */
const stubLoader = (docs: Record<string, unknown>) => async (url: string) => {
  const document = docs[url]
  if (document == null) throw new Error(`stub loader has no document for ${url}`)
  return { contextUrl: null, document, documentUrl: url }
}

/**
 * A real Fedify context (so `parseUri` resolves our own object URLs) wearing the
 * `recipient` an inbox delivery would carry, and optionally a stub document
 * loader so a bare-URI `object`/`attributedTo` resolves without a network.
 */
const inboxCtx = (user: string, docs: Record<string, unknown> = fediverse()): InboxContext<void> => {
  const base = fed.createContext(new URL(ORIGIN), undefined)
  const loader = stubLoader(docs)
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'recipient') return user
      // Only the DOCUMENT loader is stubbed: the context loader must stay the
      // real one, which serves the bundled AS2 `@context`.
      if (prop === 'documentLoader') return loader
      const value = Reflect.get(target, prop) as unknown
      // Bound to the PROXY, not the target: `ctx.lookupObject()` reads
      // `this.documentLoader`, so binding to the target would quietly reach past
      // the stub and try the network.
      return typeof value === 'function' ? value.bind(receiver) : value
    },
  }) as unknown as InboxContext<void>
}

/**
 * Alice INLINED in an activity. Nothing may be read off this: the code fetches
 * her actor document from her id instead (see `actorDoc`), so an inlined actor
 * is only ever the `actorId` carrier.
 */
const alicePerson = () =>
  new Person({
    id: new URL(ALICE),
    inbox: new URL(`${ALICE}/inbox`),
    name: 'Alice',
    preferredUsername: 'alice',
  })

/** An actor document as its own server would serve it. */
const actorDoc = (id: string, username: string, name: string) => ({
  '@context': 'https://www.w3.org/ns/activitystreams',
  id,
  inbox: `${id}/inbox`,
  name,
  preferredUsername: username,
  type: 'Person',
})

const ownPost = async (user: string) => {
  const activityId = await insertActivity(user, {
    activity_type: 'exercise',
    end_time: new Date('2026-07-01T07:11:00Z'),
    source: 'garmin',
    start_time: new Date('2026-07-01T06:30:00Z'),
    title: 'Morning run',
  })
  return createFeedPost(user, {
    activity_id: activityId,
    include_chart: false,
    include_map: false,
    included_metrics: ['duration'],
    series_metrics: [],
    visibility: 'public',
  })
}

const CAROL_NOTE = 'https://third.example/notes/1'

/**
 * The fediverse as this test knows it: Carol's actor and her Note, served as
 * JSON-LD the way a real dereference would return them (Mastodon boosts carry a
 * bare object URI, so this is the path production actually takes).
 */
const fediverse = (noteOverrides: Record<string, unknown> | null = {}) => ({
  [ALICE]: actorDoc(ALICE, 'alice', 'Alice'),
  [CAROL]: actorDoc(CAROL, 'carol', 'Carol'),
  // `null` means "nothing lives at that id" — the loader then 404s it.
  ...(noteOverrides === null
    ? {}
    : {
        [CAROL_NOTE]: {
          '@context': 'https://www.w3.org/ns/activitystreams',
          attributedTo: CAROL,
          content: '<p>Carol’s post</p>',
          id: CAROL_NOTE,
          published: '2026-07-01T08:00:00Z',
          type: 'Note',
          url: 'https://third.example/@carol/1',
          ...noteOverrides,
        },
      }),
})

/** An `Announce` of Carol's Note by `alice`, addressed by bare URI like Mastodon. */
const boostOfCarol = (announceUri: string, published = '2026-07-01T11:00:00Z') =>
  new Announce({
    actor: alicePerson(),
    id: new URL(announceUri),
    object: new URL(CAROL_NOTE),
    published: dateToTemporalInstant(new Date(published)),
  })

const acceptFollow = async (user: string, actorUri: string, handle: string) => {
  await upsertFeedFollowing(user, {
    actor_uri: actorUri,
    display_name: handle.split('@')[1],
    handle,
    inbox_uri: `${actorUri}/inbox`,
  })
  await markFeedFollowingAccepted(user, actorUri)
}

describe('Inbound likes and boosts', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('a Like of our own post is recorded with the sender’s presentation', async () => {
    const user = getTestUser()
    const post = await ownPost(user)
    await handleInboundLike(
      inboxCtx(user),
      new Like({
        actor: alicePerson(),
        id: new URL(`${ALICE}#likes/1`),
        object: new URL(`${ORIGIN}/users/${user}/feed/${post.id}`),
      }),
    )
    const rows = await listFeedPostReactions(user, post.id, 100)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor_uri: ALICE,
      handle: '@alice@mastodon.example',
      kind: 'like',
    })
  })

  test('a Like of somebody ELSE’s post (or a non-post URL) is ignored', async () => {
    const user = getTestUser()
    const post = await ownPost(user)
    await handleInboundLike(
      inboxCtx(user),
      new Like({
        actor: alicePerson(),
        id: new URL(`${ALICE}#likes/2`),
        // Same host, but another user's post — must never touch our records.
        object: new URL(`${ORIGIN}/users/someoneelse/feed/${post.id}`),
      }),
    )
    expect(await listFeedPostReactions(user, post.id, 100)).toHaveLength(0)
  })

  test('Undo{Like} removes the reaction, and only the undoing actor’s own', async () => {
    const user = getTestUser()
    const post = await ownPost(user)
    const objectUri = new URL(`${ORIGIN}/users/${user}/feed/${post.id}`)
    const like = new Like({ actor: alicePerson(), id: new URL(`${ALICE}#likes/1`), object: objectUri })
    await handleInboundLike(inboxCtx(user), like)

    // A stranger's Undo naming the same Like must not evict Alice's reaction.
    await handleInboundUndo(
      inboxCtx(user),
      new Undo({ actor: new URL('https://evil.example/users/mallory'), object: like }),
    )
    expect(await listFeedPostReactions(user, post.id, 100)).toHaveLength(1)

    await handleInboundUndo(inboxCtx(user), new Undo({ actor: new URL(ALICE), object: like }))
    expect(await listFeedPostReactions(user, post.id, 100)).toHaveLength(0)
  })

  test('an Announce of OUR post is recorded as a boost reaction, not a timeline entry', async () => {
    const user = getTestUser()
    const post = await ownPost(user)
    await handleInboundAnnounce(
      inboxCtx(user),
      new Announce({
        actor: alicePerson(),
        id: new URL(`${ALICE}/statuses/7/activity`),
        object: new URL(`${ORIGIN}/users/${user}/feed/${post.id}`),
      }),
      ORIGIN,
    )
    const rows = await listFeedPostReactions(user, post.id, 100)
    expect(rows.map((r) => r.kind)).toEqual(['announce'])
    // Our own post must never land in our own home timeline.
    expect(await listTimelineEntries(user, 10)).toHaveLength(0)
  })

  test('an accepted followee’s Announce of a third party’s Note becomes a boost card', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    const announceUri = `${ALICE}/statuses/9/activity`

    await handleInboundAnnounce(inboxCtx(user, fediverse()), boostOfCarol(announceUri), ORIGIN)

    const entries = await listTimelineEntries(user, 10)
    expect(entries).toHaveLength(1)
    // Keyed on the Announce; the card describes Carol's post, boosted by Alice.
    expect(entries[0].object_uri).toBe(announceUri)
    expect(entries[0].boost_of_uri).toBe('https://third.example/notes/1')
    expect(entries[0].actor_uri).toBe(CAROL)
    expect(entries[0].boosted_by_actor_uri).toBe(ALICE)
    expect(entries[0].boosted_by_handle).toBe('@alice@mastodon.example')
    // The byline comes from Carol's own actor document, fetched from her id.
    expect(entries[0].handle).toBe('@carol@third.example')
    expect(entries[0].display_name).toBe('Carol')
    // Sorted at boost time, like Mastodon.
    expect(entries[0].published_at.toISOString()).toBe('2026-07-01T11:00:00.000Z')
  })

  test('Undo{Announce} retracts the boost card, scoped to the booster', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    const announce = boostOfCarol(`${ALICE}/statuses/9/activity`)
    await handleInboundAnnounce(inboxCtx(user, fediverse()), announce, ORIGIN)
    expect(await listTimelineEntries(user, 10)).toHaveLength(1)

    await handleInboundUndo(
      inboxCtx(user),
      new Undo({ actor: new URL('https://evil.example/users/mallory'), object: announce }),
    )
    expect(await listTimelineEntries(user, 10)).toHaveLength(1)

    await handleInboundUndo(inboxCtx(user), new Undo({ actor: new URL(ALICE), object: announce }))
    expect(await listTimelineEntries(user, 10)).toHaveLength(0)
  })

  test('an Announce from a non-followee (or a pending follow) is ignored', async () => {
    const user = getTestUser()
    // Pending, not accepted — a follow request can't inject posts.
    await upsertFeedFollowing(user, { actor_uri: ALICE, inbox_uri: `${ALICE}/inbox` })
    await handleInboundAnnounce(
      inboxCtx(user, fediverse()),
      boostOfCarol(`${ALICE}/statuses/9/activity`),
      ORIGIN,
    )
    expect(await listTimelineEntries(user, 10)).toHaveLength(0)
  })

  test('an Announce whose fetched Note claims another host than the announced id is ignored', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    // The announced id says third.example; the served document claims to be a
    // Note on elsewhere.example. A redirect or a lying host must never let a
    // followee substitute a document into our timeline.
    await handleInboundAnnounce(
      inboxCtx(user, fediverse({ id: 'https://elsewhere.example/notes/1' })),
      boostOfCarol(`${ALICE}/statuses/9/activity`),
      ORIGIN,
    )
    expect(await listTimelineEntries(user, 10)).toHaveLength(0)
  })

  test('an Announce of a Note that declares no attributedTo is ignored', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    const docs = fediverse()
    delete (docs[CAROL_NOTE] as Record<string, unknown>).attributedTo
    await handleInboundAnnounce(inboxCtx(user, docs), boostOfCarol(`${ALICE}/statuses/9/activity`), ORIGIN)
    expect(await listTimelineEntries(user, 10)).toHaveLength(0)
  })

  test('an INLINED Note in the Announce is ignored — nothing lives at the announced id', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    // The byline-forgery primitive: a followee embeds a whole Note (and its
    // author) in the activity body. Fedify would hand that back without any
    // fetch, and every host/attribution check would pass on the attacker's own
    // data. Nothing serves that id, so nothing is stored.
    await handleInboundAnnounce(
      inboxCtx(user, fediverse(null)),
      new Announce({
        actor: alicePerson(),
        id: new URL(`${ALICE}/statuses/9/activity`),
        object: new Note({
          attribution: new Person({
            id: new URL(CAROL),
            name: 'Carol (not really)',
            preferredUsername: 'carol',
          }),
          content: '<p>words Carol never wrote</p>',
          id: new URL(CAROL_NOTE),
          published: dateToTemporalInstant(new Date('2026-07-01T08:00:00Z')),
        }),
      }),
      ORIGIN,
    )
    expect(await listTimelineEntries(user, 10)).toHaveLength(0)
  })

  test('the same Announce yields a card built from the SERVED documents, not the embedded ones', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    // Same inlined forgery, but now Carol's server really does serve that id —
    // so the card exists, and every field is hers, not the attacker's.
    await handleInboundAnnounce(
      inboxCtx(user, fediverse()),
      new Announce({
        actor: alicePerson(),
        id: new URL(`${ALICE}/statuses/9/activity`),
        object: new Note({
          attribution: new Person({
            id: new URL(CAROL),
            name: 'Carol (not really)',
            preferredUsername: 'carol',
          }),
          content: '<p>words Carol never wrote</p>',
          id: new URL(CAROL_NOTE),
          published: dateToTemporalInstant(new Date('2026-07-01T08:00:00Z')),
        }),
      }),
      ORIGIN,
    )
    const entries = await listTimelineEntries(user, 10)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toContain('Carol’s post')
    expect(entries[0].content).not.toContain('never wrote')
    expect(entries[0].display_name).toBe('Carol')
  })

  test('a reaction from an actor whose id serves nothing is recorded without a byline', async () => {
    const user = getTestUser()
    const post = await ownPost(user)
    // An inlined Person can claim any name under a valid id, so the snapshot is
    // fetched from the id — and when that serves nothing, it stays empty rather
    // than repeating the sender's claim.
    await handleInboundLike(
      inboxCtx(user, {}),
      new Like({
        actor: alicePerson(),
        id: new URL(`${ALICE}#likes/3`),
        object: new URL(`${ORIGIN}/users/${user}/feed/${post.id}`),
      }),
    )
    const rows = await listFeedPostReactions(user, post.id, 100)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_uri: ALICE, display_name: null, handle: null, kind: 'like' })
  })

  test('a post already in the timeline directly gets no boost card (dedupe)', async () => {
    const user = getTestUser()
    await acceptFollow(user, ALICE, '@alice@mastodon.example')
    await upsertTimelineEntry(user, {
      actor_uri: CAROL,
      content: '<p>Carol’s post</p>',
      object_uri: CAROL_NOTE,
      published_at: new Date('2026-07-01T08:00:00Z'),
    })

    await handleInboundAnnounce(
      inboxCtx(user, fediverse()),
      boostOfCarol(`${ALICE}/statuses/9/activity`),
      ORIGIN,
    )
    const entries = await listTimelineEntries(user, 10)
    expect(entries.map((e) => e.object_uri)).toEqual([CAROL_NOTE])
  })
})
