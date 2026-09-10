import type { Federation } from '@fedify/fedify'

import { Announce, Like, Person, Undo } from '@fedify/fedify/vocab'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration tests for the outbound like ⭐ / boost 🔄 service against a real
 * per-user database, with a fake Fedify federation capturing what would be
 * delivered (the activity SHAPES are unit-tested in `feed-reactions.test.ts`).
 */
import { upsertFeedFollowing } from '../db/feed-following.ts'
import { getFeedReaction } from '../db/feed-reactions.ts'
import { type TimelineEntryInput, upsertTimelineEntry } from '../db/timeline.ts'
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import { createReactionActions } from './feed-reactions.ts'

const CONTAINER_TIMEOUT = 120_000
const ORIGIN = 'https://aurboda.example'
const ALICE = 'https://mastodon.example/users/alice'

/** A federation whose context records deliveries instead of making them. */
const fakeFederation = (lookup: (uri: string | URL) => Promise<unknown> = async () => null) => {
  const sent: { recipients: unknown; activity: unknown }[] = []
  const ctx = {
    getActorUri: (identifier: string) => new URL(`${ORIGIN}/users/${identifier}`),
    getFollowersUri: (identifier: string) => new URL(`${ORIGIN}/users/${identifier}/followers`),
    lookupObject: lookup,
    sendActivity: async (_sender: unknown, recipients: unknown, activity: unknown) => {
      sent.push({ activity, recipients })
    },
  }
  const federation = { createContext: () => ctx } as unknown as Federation<void>
  return { federation, sent }
}

const entry = (over: Partial<TimelineEntryInput> = {}): TimelineEntryInput => ({
  actor_uri: ALICE,
  content: '<p>Ran a 5k</p>',
  display_name: 'Alice',
  handle: '@alice@mastodon.example',
  object_uri: 'https://mastodon.example/notes/1',
  published_at: new Date('2026-07-01T10:00:00Z'),
  ...over,
})

const followAlice = (user: string) =>
  upsertFeedFollowing(user, {
    actor_uri: ALICE,
    inbox_uri: `${ALICE}/inbox`,
    shared_inbox_uri: 'https://mastodon.example/inbox',
  })

describe('Outbound reactions (integration)', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('like records the reaction, delivers a Like to the author, and marks the entry', async () => {
    const user = getTestUser()
    await followAlice(user)
    const record = await upsertTimelineEntry(user, entry())
    const { federation, sent } = fakeFederation()

    const result = await createReactionActions({ federation, origin: ORIGIN }).like(user, record.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.liked).toBe(true)
    expect(result.entry.id).toBe(record.id)

    const stored = await getFeedReaction(user, 'like', 'https://mastodon.example/notes/1')
    expect(stored?.actor_uri).toBe(ALICE)
    // The cached followee inbox is stored, so the Undo needs no re-resolve.
    expect(stored?.inbox_uri).toBe(`${ALICE}/inbox`)
    expect(sent).toHaveLength(1)
    expect(sent[0].activity).toBeInstanceOf(Like)
  })

  test('liking twice is a no-op: one row, one delivery', async () => {
    const user = getTestUser()
    await followAlice(user)
    const record = await upsertTimelineEntry(user, entry())
    const { federation, sent } = fakeFederation()
    const actions = createReactionActions({ federation, origin: ORIGIN })

    await actions.like(user, record.id)
    const second = await actions.like(user, record.id)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.entry.liked).toBe(true)
    expect(sent).toHaveLength(1)
  })

  test('unlike delivers an Undo{Like} and drops the row; a second unlike is a no-op', async () => {
    const user = getTestUser()
    await followAlice(user)
    const record = await upsertTimelineEntry(user, entry())
    const { federation, sent } = fakeFederation()
    const actions = createReactionActions({ federation, origin: ORIGIN })

    await actions.like(user, record.id)
    const result = await actions.unlike(user, record.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry).not.toHaveProperty('liked')
    expect(await getFeedReaction(user, 'like', 'https://mastodon.example/notes/1')).toBeNull()
    expect(sent).toHaveLength(2)
    expect(sent[1].activity).toBeInstanceOf(Undo)

    const again = await actions.unlike(user, record.id)
    expect(again.ok).toBe(true)
    expect(sent).toHaveLength(2)
  })

  test('boost fans the Announce out to followers AND the author (two independent sends)', async () => {
    const user = getTestUser()
    await followAlice(user)
    const record = await upsertTimelineEntry(user, entry())
    const { federation, sent } = fakeFederation()

    const result = await createReactionActions({ federation, origin: ORIGIN }).boost(user, record.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry.boosted).toBe(true)
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.activity instanceof Announce)).toBe(true)
    expect(sent[0].recipients).toBe('followers')
  })

  test('reacting to a BOOST card targets the original post, not the Announce id', async () => {
    const user = getTestUser()
    await followAlice(user)
    const record = await upsertTimelineEntry(
      user,
      entry({
        boost_of_uri: 'https://mastodon.example/notes/1',
        boosted_by_actor_uri: 'https://elsewhere.example/users/bob',
        object_uri: 'https://elsewhere.example/users/bob/statuses/9/activity',
      }),
    )
    const { federation } = fakeFederation()

    const result = await createReactionActions({ federation, origin: ORIGIN }).like(user, record.id)
    expect(result.ok).toBe(true)
    expect(await getFeedReaction(user, 'like', 'https://mastodon.example/notes/1')).not.toBeNull()
    expect(
      await getFeedReaction(user, 'like', 'https://elsewhere.example/users/bob/statuses/9/activity'),
    ).toBeNull()
  })

  test('404s an unknown timeline entry without delivering anything', async () => {
    const user = getTestUser()
    const { federation, sent } = fakeFederation()
    const result = await createReactionActions({ federation, origin: ORIGIN }).like(
      user,
      '00000000-0000-0000-0000-000000000000',
    )
    expect(result).toMatchObject({ ok: false, status: 404 })
    expect(sent).toHaveLength(0)
  })

  test('502s when an unfollowed author’s inbox can’t be resolved, and stores no row', async () => {
    const user = getTestUser()
    // No feed_following row → the author must be looked up, and that fails here.
    const record = await upsertTimelineEntry(user, entry())
    const { federation, sent } = fakeFederation(async () => null)

    const result = await createReactionActions({ federation, origin: ORIGIN }).like(user, record.id)
    expect(result).toMatchObject({ ok: false, status: 502 })
    expect(sent).toHaveLength(0)
    // Nothing stored — the card must never claim a reaction that never left.
    expect(await getFeedReaction(user, 'like', 'https://mastodon.example/notes/1')).toBeNull()
  })

  test('falls back to a live actor lookup for an author we don’t follow', async () => {
    const user = getTestUser()
    const record = await upsertTimelineEntry(user, entry())
    const { federation, sent } = fakeFederation(
      async () =>
        new Person({
          id: new URL(ALICE),
          inbox: new URL(`${ALICE}/inbox`),
          preferredUsername: 'alice',
        }),
    )

    const result = await createReactionActions({ federation, origin: ORIGIN }).like(user, record.id)
    expect(result.ok).toBe(true)
    expect((await getFeedReaction(user, 'like', 'https://mastodon.example/notes/1'))?.inbox_uri).toBe(
      `${ALICE}/inbox`,
    )
    expect(sent).toHaveLength(1)
  })
})
