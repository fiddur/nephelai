import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration tests for the remote-follower store.
 */
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import {
  countFeedFollowers,
  getFeedFollowerByActor,
  getFeedFollowerById,
  listFeedFollowers,
  removeFeedFollower,
  removeFeedFollowerById,
  setFeedFollowerAccepted,
  updateFeedFollowerPresentation,
  upsertFeedFollower,
} from './feed-follower.ts'

const CONTAINER_TIMEOUT = 120_000

const alice = {
  actor_uri: 'https://mastodon.example/users/alice',
  avatar_url: 'https://mastodon.example/avatars/alice.png',
  display_name: 'Alice',
  follow_activity_uri: 'https://mastodon.example/users/alice/follows/1',
  handle: '@alice@mastodon.example',
  inbox_uri: 'https://mastodon.example/users/alice/inbox',
  shared_inbox_uri: 'https://mastodon.example/inbox',
}

const bob = {
  actor_uri: 'https://remote.example/users/bob',
  inbox_uri: 'https://remote.example/users/bob/inbox',
}

describe('Feed followers integration', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('adds a follower with presentation + follow id and lists it', async () => {
    const user = getTestUser()
    const rec = await upsertFeedFollower(user, { ...alice, accepted: true })
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rec.actor_uri).toBe(alice.actor_uri)
    expect(rec.inbox_uri).toBe(alice.inbox_uri)
    expect(rec.shared_inbox_uri).toBe(alice.shared_inbox_uri)
    expect(rec.handle).toBe('@alice@mastodon.example')
    expect(rec.display_name).toBe('Alice')
    expect(rec.avatar_url).toBe(alice.avatar_url)
    expect(rec.follow_activity_uri).toBe(alice.follow_activity_uri)
    expect(rec.accepted).toBe(true)

    const followers = await listFeedFollowers(user)
    expect(followers.map((f) => f.actor_uri)).toEqual([alice.actor_uri])
  })

  test('defaults accepted to false and optional fields to null', async () => {
    const user = getTestUser()
    const rec = await upsertFeedFollower(user, bob)
    expect(rec.accepted).toBe(false)
    expect(rec.shared_inbox_uri).toBeNull()
    expect(rec.handle).toBeNull()
    expect(rec.display_name).toBeNull()
    expect(rec.avatar_url).toBeNull()
    expect(rec.follow_activity_uri).toBeNull()
  })

  test('re-following updates in place, keeps the id, and keeps last-known presentation', async () => {
    const user = getTestUser()
    const first = await upsertFeedFollower(user, { ...alice, accepted: false })
    // A re-delivered Follow that couldn't re-extract presentation must not wipe it,
    // but should refresh the inbox and can flip acceptance.
    const updated = await upsertFeedFollower(user, {
      accepted: true,
      actor_uri: alice.actor_uri,
      inbox_uri: 'https://mastodon.example/users/alice/inbox2',
    })
    expect(updated.id).toBe(first.id)
    expect(updated.accepted).toBe(true)
    expect(updated.inbox_uri).toBe('https://mastodon.example/users/alice/inbox2')
    expect(updated.handle).toBe('@alice@mastodon.example')
    expect(updated.display_name).toBe('Alice')

    expect(await listFeedFollowers(user)).toHaveLength(1)
  })

  test('lists pending vs accepted with the status filter', async () => {
    const user = getTestUser()
    await upsertFeedFollower(user, { ...alice, accepted: true })
    await upsertFeedFollower(user, { ...bob, accepted: false })

    expect((await listFeedFollowers(user, { accepted: true })).map((f) => f.actor_uri)).toEqual([
      alice.actor_uri,
    ])
    expect((await listFeedFollowers(user, { accepted: false })).map((f) => f.actor_uri)).toEqual([
      bob.actor_uri,
    ])
    expect(await listFeedFollowers(user)).toHaveLength(2)
  })

  test('counts only accepted followers', async () => {
    const user = getTestUser()
    expect(await countFeedFollowers(user)).toBe(0)
    await upsertFeedFollower(user, { ...alice, accepted: true })
    await upsertFeedFollower(user, { ...bob, accepted: false })
    // Only alice (accepted) is counted; bob is a pending request.
    expect(await countFeedFollowers(user)).toBe(1)
  })

  test('fetches a follower by id and by actor uri', async () => {
    const user = getTestUser()
    const rec = await upsertFeedFollower(user, alice)
    expect((await getFeedFollowerById(user, rec.id))?.actor_uri).toBe(alice.actor_uri)
    expect((await getFeedFollowerByActor(user, alice.actor_uri))?.id).toBe(rec.id)
    expect(await getFeedFollowerById(user, '00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(await getFeedFollowerByActor(user, 'https://nope.example/x')).toBeNull()
  })

  test('approves a pending follower by id', async () => {
    const user = getTestUser()
    const rec = await upsertFeedFollower(user, { ...alice, accepted: false })
    const approved = await setFeedFollowerAccepted(user, rec.id)
    expect(approved?.accepted).toBe(true)
    expect((await getFeedFollowerById(user, rec.id))?.accepted).toBe(true)
    expect(await setFeedFollowerAccepted(user, '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  test('removes a follower by id, returning the removed row', async () => {
    const user = getTestUser()
    const rec = await upsertFeedFollower(user, alice)
    const removed = await removeFeedFollowerById(user, rec.id)
    expect(removed?.inbox_uri).toBe(alice.inbox_uri)
    expect(await getFeedFollowerById(user, rec.id)).toBeNull()
    expect(await removeFeedFollowerById(user, rec.id)).toBeNull()
  })

  test('removes a follower by actor uri (e.g. on Undo Follow)', async () => {
    const user = getTestUser()
    await upsertFeedFollower(user, alice)
    expect(await removeFeedFollower(user, alice.actor_uri)).toBe(true)
    expect(await removeFeedFollower(user, alice.actor_uri)).toBe(false)
    expect(await listFeedFollowers(user)).toEqual([])
  })

  test('refreshes a follower’s presentation from an inbound Update{Person} (#1057)', async () => {
    const user = getTestUser()
    await upsertFeedFollower(user, { ...alice, accepted: true })

    expect(
      await updateFeedFollowerPresentation(user, alice.actor_uri, {
        avatar_url: null,
        display_name: 'Alice Renamed',
        handle: '@alice@mastodon.example',
      }),
    ).toBe(true)

    const row = await getFeedFollowerByActor(user, alice.actor_uri)
    expect(row?.display_name).toBe('Alice Renamed')
    // The served actor document is authoritative — a removed avatar really goes.
    expect(row?.avatar_url).toBeNull()
    // Delivery addressing and the acceptance state are untouched.
    expect(row?.inbox_uri).toBe(alice.inbox_uri)
    expect(row?.shared_inbox_uri).toBe(alice.shared_inbox_uri)
    expect(row?.accepted).toBe(true)

    // An actor we have no follower row for changes nothing.
    expect(
      await updateFeedFollowerPresentation(user, bob.actor_uri, {
        avatar_url: null,
        display_name: 'Bob',
        handle: '@bob@remote.example',
      }),
    ).toBe(false)
  })
})
