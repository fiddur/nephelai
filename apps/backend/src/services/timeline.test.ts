import { describe, expect, test } from 'vitest'

import type { TimelineCursor, TimelineEntryRecord } from '../db/index.ts'

import { getTimelinePage, serializeTimelineEntry } from './timeline.ts'

const record = (over: Partial<TimelineEntryRecord> = {}): TimelineEntryRecord => ({
  actor_uri: 'https://remote.example/users/alice',
  avatar_url: 'https://remote.example/avatars/alice.png',
  boost_of_uri: null,
  boosted_by_actor_uri: null,
  boosted_by_display_name: null,
  boosted_by_handle: null,
  content: '<p>Ran a 5k</p>',
  display_name: 'Alice',
  handle: '@alice@remote.example',
  id: '00000000-0000-0000-0000-000000000001',
  images: null,
  in_reply_to_uri: null,
  mentions_me: false,
  object_uri: 'https://remote.example/notes/1',
  published_at: new Date('2026-07-01T08:00:00.000Z'),
  received_at: new Date('2026-07-01T08:00:05.000Z'),
  structured: null,
  url: 'https://remote.example/@alice/1',
  ...over,
})

describe('serializeTimelineEntry', () => {
  test('maps a stored record to the DTO with ISO timestamps', () => {
    const dto = serializeTimelineEntry(record())
    expect(dto).toEqual({
      actor_uri: 'https://remote.example/users/alice',
      avatar_url: 'https://remote.example/avatars/alice.png',
      content: '<p>Ran a 5k</p>',
      display_name: 'Alice',
      handle: '@alice@remote.example',
      id: '00000000-0000-0000-0000-000000000001',
      object_uri: 'https://remote.example/notes/1',
      published_at: '2026-07-01T08:00:00.000Z',
      received_at: '2026-07-01T08:00:05.000Z',
      url: 'https://remote.example/@alice/1',
    })
    // A top-level post carries no reply fields at all.
    expect(dto).not.toHaveProperty('in_reply_to_uri')
  })

  test('marks a reply to the reader’s own post when given the own-object prefix', () => {
    const reply = record({ in_reply_to_uri: 'https://aurboda.example/users/me/feed/abc' })
    const mine = serializeTimelineEntry(reply, 'https://aurboda.example/users/me/feed/')
    expect(mine.in_reply_to_uri).toBe('https://aurboda.example/users/me/feed/abc')
    expect(mine.in_reply_to_mine).toBe(true)

    const other = serializeTimelineEntry(
      record({ in_reply_to_uri: 'https://remote.example/notes/9' }),
      'https://aurboda.example/users/me/feed/',
    )
    expect(other.in_reply_to_mine).toBe(false)
  })

  test('marks liked/boosted only when the reader actually reacted', () => {
    const plain = serializeTimelineEntry(record(), undefined, new Set())
    // Absent, not `false` — same convention as `mentions_me`.
    expect(plain).not.toHaveProperty('liked')
    expect(plain).not.toHaveProperty('boosted')

    const reacted = serializeTimelineEntry(
      record(),
      undefined,
      new Set(['like:https://remote.example/notes/1']),
    )
    expect(reacted.liked).toBe(true)
    expect(reacted).not.toHaveProperty('boosted')
  })

  test('a boost card exposes boost_of_uri + boosted_by, and reacts on the ORIGINAL post', () => {
    const boost = record({
      boost_of_uri: 'https://remote.example/notes/1',
      boosted_by_actor_uri: 'https://elsewhere.example/users/bob',
      boosted_by_display_name: 'Bob',
      boosted_by_handle: '@bob@elsewhere.example',
      object_uri: 'https://elsewhere.example/users/bob/statuses/9/activity',
    })
    // Liking a boost likes the post it shows (its own object_uri is the
    // Announce id, which nobody can like) — exactly as on Mastodon.
    const dto = serializeTimelineEntry(boost, undefined, new Set(['like:https://remote.example/notes/1']))
    expect(dto.boost_of_uri).toBe('https://remote.example/notes/1')
    expect(dto.boosted_by).toEqual({
      actor_uri: 'https://elsewhere.example/users/bob',
      display_name: 'Bob',
      handle: '@bob@elsewhere.example',
    })
    expect(dto.liked).toBe(true)
  })
})

describe('getTimelinePage', () => {
  const rows = (n: number): TimelineEntryRecord[] =>
    Array.from({ length: n }, (_, i) =>
      record({
        id: `00000000-0000-0000-0000-00000000000${i}`,
        object_uri: `https://remote.example/notes/${i}`,
        published_at: new Date(Date.UTC(2026, 6, 1, 8, 0, n - i)), // newest first
      }),
    )

  test('batch-loads the reader’s reactions once per page, keyed on the reacted-to object', async () => {
    const calls: string[][] = []
    const page = await getTimelinePage('user', 20, undefined, {
      fetchEntries: async () => [
        record({ object_uri: 'https://remote.example/notes/1' }),
        record({
          boost_of_uri: 'https://remote.example/notes/2',
          boosted_by_actor_uri: 'https://elsewhere.example/users/bob',
          id: '00000000-0000-0000-0000-000000000002',
          object_uri: 'https://elsewhere.example/users/bob/statuses/9/activity',
        }),
      ],
      fetchReactions: async (_u, uris) => {
        calls.push(uris)
        return [{ kind: 'announce', object_uri: 'https://remote.example/notes/2' }]
      },
    })
    // ONE query for the whole page, and the boost card is looked up by the
    // original Note's id, not its Announce id.
    expect(calls).toEqual([['https://remote.example/notes/1', 'https://remote.example/notes/2']])
    expect(page.entries[0]).not.toHaveProperty('boosted')
    expect(page.entries[1].boosted).toBe(true)
  })

  test('a failed reaction lookup leaves the page unmarked rather than failing the read', async () => {
    const page = await getTimelinePage('user', 20, undefined, {
      fetchEntries: async () => rows(1),
      fetchReactions: async () => {
        throw new Error('db down')
      },
    })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).not.toHaveProperty('liked')
  })

  test('requests limit + 1 rows and passes a decoded cursor of undefined on the first page', async () => {
    const calls: { limit: number; cursor?: TimelineCursor }[] = []
    await getTimelinePage('user', 20, undefined, {
      fetchEntries: async (_u, limit, cursor) => {
        calls.push({ cursor, limit })
        return []
      },
      fetchReactions: async () => [],
    })
    expect(calls).toEqual([{ cursor: undefined, limit: 21 }])
  })

  test('threads the reply filter from settings + origin down to the fetcher', async () => {
    let seen: unknown
    await getTimelinePage('freja', 20, undefined, {
      fetchEntries: async (_u, _l, _c, replies) => {
        seen = replies
        return []
      },
      fetchReactions: async () => [],
      loadSettings: async () => ({ timeline_show_replies: false }),
      origin: 'https://aurboda.example/',
    })
    expect(seen).toEqual({
      own_object_prefix: 'https://aurboda.example/users/freja/feed/',
      show_replies: false,
    })
  })

  test('returns no next_cursor when the fetch yields at most `limit` rows', async () => {
    const page = await getTimelinePage('user', 20, undefined, {
      fetchEntries: async () => rows(20),
      fetchReactions: async () => [],
    })
    expect(page.entries).toHaveLength(20)
    expect(page.next_cursor).toBeNull()
  })

  test('trims the sentinel row and emits a next_cursor when there are more', async () => {
    const page = await getTimelinePage('user', 20, undefined, {
      fetchEntries: async () => rows(21),
      fetchReactions: async () => [],
    })
    expect(page.entries).toHaveLength(20)
    expect(page.next_cursor).toEqual(expect.any(String))
  })

  test('a next_cursor round-trips back to the (published_at, id) of the last returned row', async () => {
    const first = await getTimelinePage('user', 2, undefined, {
      fetchEntries: async () => rows(3),
      fetchReactions: async () => [],
    })
    const lastEntry = first.entries[first.entries.length - 1]

    let received: TimelineCursor | undefined
    await getTimelinePage('user', 2, first.next_cursor ?? undefined, {
      fetchEntries: async (_u, _l, cursor) => {
        received = cursor
        return []
      },
      fetchReactions: async () => [],
    })
    expect(received?.id).toBe(lastEntry.id)
    expect(received?.published_at.toISOString()).toBe(lastEntry.published_at)
  })

  test('treats a malformed cursor as the first page (undefined) rather than throwing', async () => {
    let received: TimelineCursor | undefined = { id: 'sentinel', published_at: new Date(0) }
    await getTimelinePage('user', 20, 'not-a-valid-cursor!!', {
      fetchEntries: async (_u, _l, cursor) => {
        received = cursor
        return []
      },
      fetchReactions: async () => [],
    })
    expect(received).toBeUndefined()
  })

  test('rejects a structurally-valid cursor whose id is not a UUID (avoids a $::uuid 500)', async () => {
    // `12345:not-a-uuid` base64url-decodes with a safe-integer ms but a non-UUID id;
    // it must decode to undefined (first page) rather than reaching the uuid cast.
    const crafted = Buffer.from('12345:not-a-uuid').toString('base64url')
    let received: TimelineCursor | undefined = { id: 'sentinel', published_at: new Date(0) }
    await getTimelinePage('user', 20, crafted, {
      fetchEntries: async (_u, _l, cursor) => {
        received = cursor
        return []
      },
      fetchReactions: async () => [],
    })
    expect(received).toBeUndefined()
  })
})
