import type { TimelineReply } from '@aurboda/api-spec'

import { describe, expect, test } from 'vitest'

import type { FeedPostRecord } from '../db/index.ts'

import {
  getThreadSnapshot,
  mergeOwnReplies,
  ownReplyAuthor,
  ownReplyToTimelineReply,
} from './timeline-replies.ts'

const ORIGIN = 'https://aurboda.example'
const PREFIX = `${ORIGIN}/users/fiddur/feed/`

const remote = (n: number, over: Partial<TimelineReply> = {}): TimelineReply => ({
  actor_uri: `https://mastodon.example/users/u${n}`,
  content: `<p>reply ${n}</p>`,
  display_name: `User ${n}`,
  handle: `@u${n}@mastodon.example`,
  object_uri: `https://mastodon.example/notes/r${n}`,
  published_at: `2026-09-0${n}T10:00:00.000Z`,
  url: `https://mastodon.example/@u${n}/r${n}`,
  ...over,
})

const replyPost = (id: string, createdAt: string, over: Partial<FeedPostRecord> = {}): FeedPostRecord => ({
  activity_id: null,
  article: null,
  autoshare_rule_id: null,
  challenge: null,
  created_at: new Date(createdAt),
  id,
  image_token: 'tok',
  in_reply_to_actor_uri: 'https://mastodon.example/users/alice',
  in_reply_to_handle: '@alice@mastodon.example',
  in_reply_to_uri: 'https://mastodon.example/users/alice/statuses/9',
  include_chart: false,
  include_map: false,
  included_metrics: [],
  kind: 'reply',
  message: 'my reply',
  series_metrics: [],
  updated_at: new Date(createdAt),
  visibility: 'unlisted',
  ...over,
})

describe('ownReplyAuthor', () => {
  test('names the reader as `@user@host` on this instance', () => {
    expect(ownReplyAuthor(ORIGIN, 'fiddur')).toEqual({
      actor_uri: `${ORIGIN}/users/fiddur`,
      handle: '@fiddur@aurboda.example',
    })
  })

  test('an unparseable origin still yields an actor uri, just no handle', () => {
    expect(ownReplyAuthor('not a url', 'fiddur').handle).toBeNull()
  })
})

describe('ownReplyToTimelineReply', () => {
  test('renders the same mention + prose HTML the reply federates, marked mine', () => {
    const own = ownReplyToTimelineReply(
      replyPost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-05T09:00:00.000Z'),
      PREFIX,
      ownReplyAuthor(ORIGIN, 'fiddur'),
    )
    expect(own.mine).toBe(true)
    expect(own.object_uri).toBe(`${PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`)
    expect(own.url).toBe(own.object_uri)
    expect(own.handle).toBe('@fiddur@aurboda.example')
    expect(own.content).toContain('class="u-url mention"')
    expect(own.content).toContain('my reply')
    expect(own.published_at).toBe('2026-09-05T09:00:00.000Z')
  })
})

describe('mergeOwnReplies', () => {
  test('appends an own reply the origin does not list yet', () => {
    const own = ownReplyToTimelineReply(
      replyPost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-05T09:00:00.000Z'),
      PREFIX,
      ownReplyAuthor(ORIGIN, 'fiddur'),
    )
    const merged = mergeOwnReplies([remote(1)], [own])
    expect(merged.map((r) => r.object_uri)).toEqual([
      'https://mastodon.example/notes/r1',
      `${PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    ])
    expect(merged[1].mine).toBe(true)
  })

  test('keeps the ORIGIN’s copy of a reply it already lists, only marking it mine', () => {
    const listed = remote(1, { object_uri: `${PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` })
    const own = ownReplyToTimelineReply(
      replyPost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-05T09:00:00.000Z'),
      PREFIX,
      ownReplyAuthor(ORIGIN, 'fiddur'),
    )
    const merged = mergeOwnReplies([listed], [own])
    expect(merged).toHaveLength(1)
    expect(merged[0].content).toBe(listed.content)
    expect(merged[0].mine).toBe(true)
  })

  test('appends several missing own replies oldest first', () => {
    const author = ownReplyAuthor(ORIGIN, 'fiddur')
    const newer = ownReplyToTimelineReply(
      replyPost('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-09-06T09:00:00.000Z'),
      PREFIX,
      author,
    )
    const older = ownReplyToTimelineReply(
      replyPost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-05T09:00:00.000Z'),
      PREFIX,
      author,
    )
    const merged = mergeOwnReplies([], [newer, older])
    expect(merged.map((r) => r.published_at)).toEqual([
      '2026-09-05T09:00:00.000Z',
      '2026-09-06T09:00:00.000Z',
    ])
  })

  test('leaves a thread with no own replies exactly as the origin ordered it', () => {
    const fetched = [remote(1), remote(2)]
    expect(mergeOwnReplies(fetched, [])).toEqual(fetched)
  })

  test('never drops an own reply whose object id is unknown', () => {
    const orphan: TimelineReply = { ...remote(3), mine: true, object_uri: null }
    expect(mergeOwnReplies([remote(1)], [orphan])).toHaveLength(2)
  })
})

describe('getThreadSnapshot', () => {
  const own = [replyPost('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2026-09-05T09:00:00.000Z')]

  test('merges own replies into the origin snapshot, keeping fetched/partial', async () => {
    const snapshot = await getThreadSnapshot(
      'fiddur',
      ORIGIN,
      'https://mastodon.example/users/alice/statuses/9',
      {
        fetchRemote: async () => ({ fetched: true, partial: true, replies: [remote(1)] }),
        listOwn: async () => own,
      },
    )
    expect(snapshot.fetched).toBe(true)
    expect(snapshot.partial).toBe(true)
    expect(snapshot.replies).toHaveLength(2)
    expect(snapshot.replies[1].mine).toBe(true)
  })

  test('a failed origin fetch still shows the reader their own replies', async () => {
    const snapshot = await getThreadSnapshot(
      'fiddur',
      ORIGIN,
      'https://mastodon.example/users/alice/statuses/9',
      {
        fetchRemote: async () => {
          throw new Error('boom')
        },
        listOwn: async () => own,
      },
    )
    expect(snapshot.fetched).toBe(false)
    expect(snapshot.replies).toHaveLength(1)
    expect(snapshot.replies[0].mine).toBe(true)
  })

  test('a failed own-reply lookup costs the merge, not the thread', async () => {
    const snapshot = await getThreadSnapshot(
      'fiddur',
      ORIGIN,
      'https://mastodon.example/users/alice/statuses/9',
      {
        fetchRemote: async () => ({ fetched: true, partial: false, replies: [remote(1)] }),
        listOwn: async () => {
          throw new Error('db down')
        },
      },
    )
    expect(snapshot.replies).toHaveLength(1)
    expect(snapshot.replies[0].mine).toBeUndefined()
  })
})
