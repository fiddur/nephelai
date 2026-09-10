import { Announce, Like, Undo } from '@fedify/fedify/vocab'
import { describe, expect, test } from 'vitest'

import type { FeedPostReactionRecord, FeedReactionRecord } from '../db/index.ts'

import {
  buildReactionActivity,
  buildUndoReactionActivity,
  type ReactionActorContext,
  reactionActivityId,
  serializeFeedPostReaction,
} from './feed-reactions.ts'

const ORIGIN = 'https://aurboda.example'
const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

const ctx: ReactionActorContext = {
  actorUri: new URL(`${ORIGIN}/users/freja`),
  followersUri: new URL(`${ORIGIN}/users/freja/followers`),
  origin: ORIGIN,
  user: 'freja',
}

const row = (over: Partial<FeedReactionRecord> = {}): FeedReactionRecord => ({
  actor_uri: 'https://mastodon.example/users/alice',
  created_at: new Date('2026-07-02T10:00:00Z'),
  id: '11111111-1111-1111-1111-111111111111',
  inbox_uri: 'https://mastodon.example/users/alice/inbox',
  kind: 'like',
  object_uri: 'https://mastodon.example/notes/1',
  shared_inbox_uri: 'https://mastodon.example/inbox',
  ...over,
})

describe('reactionActivityId', () => {
  test('mints a stable per-row id under the reacting user’s actor', () => {
    expect(reactionActivityId(ORIGIN, 'freja', 'like', 'abc').href).toBe(
      'https://aurboda.example/users/freja/likes/abc',
    )
    expect(reactionActivityId(ORIGIN, 'freja', 'announce', 'abc').href).toBe(
      'https://aurboda.example/users/freja/announces/abc',
    )
  })

  test('percent-encodes the username and tolerates a trailing slash on the origin', () => {
    expect(reactionActivityId('https://aurboda.example/', 'a b', 'like', 'x').href).toBe(
      'https://aurboda.example/users/a%20b/likes/x',
    )
  })
})

describe('buildReactionActivity', () => {
  test('a Like is addressed to nobody — it goes to the author’s inbox alone', async () => {
    const like = buildReactionActivity(ctx, row())
    expect(like).toBeInstanceOf(Like)
    expect(like.id?.href).toBe(
      'https://aurboda.example/users/freja/likes/11111111-1111-1111-1111-111111111111',
    )
    expect(like.actorId?.href).toBe(`${ORIGIN}/users/freja`)
    expect(like.objectId?.href).toBe('https://mastodon.example/notes/1')
    expect(like.toIds).toEqual([])
    expect(like.ccIds).toEqual([])
  })

  test('an Announce is public and cc’d to our followers AND the boosted author', () => {
    const announce = buildReactionActivity(ctx, row({ kind: 'announce' }))
    expect(announce).toBeInstanceOf(Announce)
    expect(announce.id?.href).toBe(
      'https://aurboda.example/users/freja/announces/11111111-1111-1111-1111-111111111111',
    )
    expect(announce.toIds.map((u) => u.href)).toEqual([AS_PUBLIC])
    expect(announce.ccIds.map((u) => u.href)).toEqual([
      `${ORIGIN}/users/freja/followers`,
      'https://mastodon.example/users/alice',
    ])
    // The boost time, so remote servers order the reblog correctly.
    expect(announce.published?.epochMilliseconds).toBe(new Date('2026-07-02T10:00:00Z').getTime())
  })
})

describe('buildUndoReactionActivity', () => {
  test('wraps the same activity at `#undo` of its id, mirroring its recipients', async () => {
    const undoLike = buildUndoReactionActivity(ctx, row())
    expect(undoLike).toBeInstanceOf(Undo)
    expect(undoLike.id?.href).toBe(
      'https://aurboda.example/users/freja/likes/11111111-1111-1111-1111-111111111111#undo',
    )
    expect(await undoLike.getObject()).toBeInstanceOf(Like)
    expect(undoLike.ccIds).toEqual([])

    const undoBoost = buildUndoReactionActivity(ctx, row({ kind: 'announce' }))
    expect(undoBoost.id?.href).toBe(
      'https://aurboda.example/users/freja/announces/11111111-1111-1111-1111-111111111111#undo',
    )
    expect(await undoBoost.getObject()).toBeInstanceOf(Announce)
    // A boost's retraction has to reach everyone the boost did.
    expect(undoBoost.toIds.map((u) => u.href)).toEqual([AS_PUBLIC])
    expect(undoBoost.ccIds.map((u) => u.href)).toEqual([
      `${ORIGIN}/users/freja/followers`,
      'https://mastodon.example/users/alice',
    ])
  })
})

describe('serializeFeedPostReaction', () => {
  test('maps a stored inbound reaction to the DTO with an ISO timestamp', () => {
    const record: FeedPostReactionRecord = {
      activity_uri: 'https://mastodon.example/users/bob#likes/7',
      actor_uri: 'https://mastodon.example/users/bob',
      avatar_url: 'https://mastodon.example/avatars/bob.png',
      created_at: new Date('2026-07-03T09:00:00Z'),
      display_name: 'Bob',
      handle: '@bob@mastodon.example',
      kind: 'like',
      post_id: '22222222-2222-2222-2222-222222222222',
    }
    const dto = serializeFeedPostReaction(record)
    expect(dto).toEqual({
      actor_uri: 'https://mastodon.example/users/bob',
      avatar_url: 'https://mastodon.example/avatars/bob.png',
      created_at: '2026-07-03T09:00:00.000Z',
      display_name: 'Bob',
      handle: '@bob@mastodon.example',
      kind: 'like',
    })
    // Internal bookkeeping (which post, which remote activity) stays server-side.
    expect(dto).not.toHaveProperty('post_id')
    expect(dto).not.toHaveProperty('activity_uri')
  })
})
