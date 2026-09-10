import { Document, Image, Note } from '@fedify/fedify/vocab'
import { describe, expect, test } from 'vitest'

import type { FeedFollowingRecord } from '../../db/index.ts'

import { dateToTemporalInstant } from './temporal-interop.ts'
import { extractNoteImages, noteToTimelineInput, sanitizeRemoteHtml } from './timeline-ingest.ts'

/** Build the ambient `Temporal.Instant` a `Note` expects from an ISO string. */
const published = (iso: string) => dateToTemporalInstant(new Date(iso))

describe('sanitizeRemoteHtml', () => {
  test('keeps benign Mastodon-style content', () => {
    const html = '<p>Nice run! <a href="https://ex.ample/tag">#running</a></p>'
    const out = sanitizeRemoteHtml(html)
    expect(out).toContain('<p>')
    expect(out).toContain('#running')
    expect(out).toContain('href="https://ex.ample/tag"')
  })

  test('strips <script> and inline event handlers (XSS)', () => {
    const out = sanitizeRemoteHtml('<p onclick="steal()">hi</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('hi')
  })

  test('drops javascript: and data: URLs on links', () => {
    const out = sanitizeRemoteHtml('<a href="javascript:alert(1)">x</a><a href="data:text/html,x">y</a>')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('data:text/html')
  })

  test('removes images, iframes, and style attributes', () => {
    const out = sanitizeRemoteHtml(
      '<img src="https://x/y.png"><iframe src="https://evil"></iframe><p style="color:red">z</p>',
    )
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('style=')
    expect(out).toContain('z')
  })

  test('forces safe rel/target on surviving links', () => {
    const out = sanitizeRemoteHtml('<a href="https://ex.ample">link</a>')
    expect(out).toContain('rel="nofollow noopener noreferrer"')
    expect(out).toContain('target="_blank"')
  })
})

describe('noteToTimelineInput', () => {
  const author: FeedFollowingRecord = {
    accepted: true,
    actor_uri: 'https://mastodon.example/users/alice',
    avatar_url: 'https://mastodon.example/avatars/alice.png',
    created_at: new Date('2026-07-01T00:00:00Z'),
    display_name: 'Alice',
    handle: '@alice@mastodon.example',
    id: '11111111-1111-1111-1111-111111111111',
    inbox_uri: 'https://mastodon.example/users/alice/inbox',
    notify_on_post: true,
    shared_inbox_uri: null,
  }

  test('maps a Note to a timeline input, sanitising content and using the cached author', () => {
    const note = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>Hello <script>evil()</script></p>',
      id: new URL('https://mastodon.example/notes/1'),
      published: published('2026-07-02T08:30:00Z'),
      url: new URL('https://mastodon.example/@alice/1'),
    })
    const input = noteToTimelineInput(note, author)
    expect(input).not.toBeNull()
    expect(input?.object_uri).toBe('https://mastodon.example/notes/1')
    expect(input?.actor_uri).toBe(author.actor_uri)
    expect(input?.handle).toBe('@alice@mastodon.example')
    expect(input?.content).toContain('Hello')
    expect(input?.content).not.toContain('<script')
    expect(input?.published_at.toISOString()).toBe('2026-07-02T08:30:00.000Z')
    expect(input?.url).toBe('https://mastodon.example/@alice/1')
  })

  test('falls back to the object id when the Note has no url', () => {
    const note = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>x</p>',
      id: new URL('https://mastodon.example/notes/2'),
      published: published('2026-07-02T09:00:00Z'),
    })
    expect(noteToTimelineInput(note, author)?.url).toBe('https://mastodon.example/notes/2')
  })

  test('returns null when the Note lacks an id or published time', () => {
    const noId = new Note({
      attribution: new URL(author.actor_uri),
      content: 'x',
      published: published('2026-07-02T09:00:00Z'),
    })
    expect(noteToTimelineInput(noId, author)).toBeNull()
    const noPublished = new Note({
      attribution: new URL(author.actor_uri),
      content: 'x',
      id: new URL('https://mastodon.example/notes/3'),
    })
    expect(noteToTimelineInput(noPublished, author)).toBeNull()
  })

  test('rejects a Note whose id is on a different host than the sender (id-collision spoof)', () => {
    // An accepted followee delivering a Note with an id on ANOTHER actor's host
    // could otherwise overwrite that actor's entry via the global object_uri key.
    const spoof = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>pwned</p>',
      id: new URL('https://good.example/notes/1'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(noteToTimelineInput(spoof, author)).toBeNull()
  })

  test('rejects a Note that declares no attributedTo at all (#1018)', () => {
    // A same-host Note with no attribution used to pass on host match alone,
    // which let anyone on a followee's host claim an existing entry's object_uri
    // and overwrite it through the upsert.
    const unattributed = new Note({
      content: '<p>whose is this?</p>',
      id: new URL('https://mastodon.example/notes/8'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(noteToTimelineInput(unattributed, author)).toBeNull()
  })

  test('rejects a Note attributed to a different actor', () => {
    const spoof = new Note({
      attribution: new URL('https://mastodon.example/users/mallory'),
      content: '<p>not mine</p>',
      id: new URL('https://mastodon.example/notes/9'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(noteToTimelineInput(spoof, author)).toBeNull()
  })

  test('accepts a Note correctly attributed to the sender', () => {
    const note = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>mine</p>',
      id: new URL('https://mastodon.example/notes/10'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(noteToTimelineInput(note, author)?.object_uri).toBe('https://mastodon.example/notes/10')
  })

  test('clamps a far-future published_at to now (anti-pin), leaving past timestamps intact', () => {
    const now = new Date('2026-07-02T12:00:00Z').getTime()
    const future = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>pinned</p>',
      id: new URL('https://mastodon.example/notes/11'),
      published: published('3000-01-01T00:00:00Z'),
    })
    expect(noteToTimelineInput(future, author, now)?.published_at.toISOString()).toBe(
      '2026-07-02T12:00:00.000Z',
    )
    const past = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>ok</p>',
      id: new URL('https://mastodon.example/notes/12'),
      published: published('2026-07-01T08:00:00Z'),
    })
    expect(noteToTimelineInput(past, author, now)?.published_at.toISOString()).toBe(
      '2026-07-01T08:00:00.000Z',
    )
  })

  describe('boost cards', () => {
    const boosted = new Note({
      attribution: new URL(author.actor_uri),
      content: '<p>original post</p>',
      id: new URL('https://mastodon.example/notes/20'),
      published: published('2026-07-02T08:00:00Z'),
      url: new URL('https://mastodon.example/@alice/20'),
    })
    const boost = {
      actor_uri: 'https://remote.example/users/bob',
      announce_uri: 'https://remote.example/users/bob/statuses/99/activity',
      display_name: 'Bob',
      handle: '@bob@remote.example',
      published_at: new Date('2026-07-02T10:00:00Z'),
    }

    test('keys the row on the Announce id and keeps the original post in boost_of_uri', () => {
      const input = noteToTimelineInput(boosted, author, Date.now(), boost)
      // The Announce id is the upsert key, so two followees boosting one post
      // give two cards and neither collides with the original's own entry.
      expect(input?.object_uri).toBe('https://remote.example/users/bob/statuses/99/activity')
      expect(input?.boost_of_uri).toBe('https://mastodon.example/notes/20')
      // Author + content still describe the ORIGINAL post — that's what renders.
      expect(input?.actor_uri).toBe(author.actor_uri)
      expect(input?.content).toContain('original post')
      expect(input?.url).toBe('https://mastodon.example/@alice/20')
      expect(input?.boosted_by_actor_uri).toBe('https://remote.example/users/bob')
      expect(input?.boosted_by_handle).toBe('@bob@remote.example')
      expect(input?.boosted_by_display_name).toBe('Bob')
    })

    test('sorts at boost time, clamped to now like any other published_at', () => {
      expect(noteToTimelineInput(boosted, author, Date.now(), boost)?.published_at.toISOString()).toBe(
        '2026-07-02T10:00:00.000Z',
      )
      const future = { ...boost, published_at: new Date('3000-01-01T00:00:00Z') }
      const now = new Date('2026-07-02T12:00:00Z').getTime()
      expect(noteToTimelineInput(boosted, author, now, future)?.published_at.toISOString()).toBe(
        '2026-07-02T12:00:00.000Z',
      )
    })

    test('still applies the author host + attribution guards to the boosted Note', () => {
      const elsewhere = new Note({
        attribution: new URL(author.actor_uri),
        content: '<p>spoof</p>',
        id: new URL('https://other.example/notes/1'),
        published: published('2026-07-02T08:00:00Z'),
      })
      expect(noteToTimelineInput(elsewhere, author, Date.now(), boost)).toBeNull()
    })
  })
})

describe('extractNoteImages', () => {
  test('extracts an Image attachment (rendered chart) with its url, media type, alt, and size', async () => {
    const note = new Note({
      attachments: [
        new Image({
          height: 420,
          mediaType: 'image/png',
          name: 'Heart rate',
          url: new URL('https://aurboda.net/api/public/bob/feed/abc/chart.png?token=t'),
          width: 1000,
        }),
      ],
      content: '<p>Slept</p>',
      id: new URL('https://aurboda.net/users/bob/feed/abc'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(await extractNoteImages(note)).toEqual([
      {
        height: 420,
        media_type: 'image/png',
        name: 'Heart rate',
        url: 'https://aurboda.net/api/public/bob/feed/abc/chart.png?token=t',
        width: 1000,
      },
    ])
  })

  test('keeps an https image Document, and skips non-image / non-https / data attachments', async () => {
    const note = new Note({
      attachments: [
        new Document({
          mediaType: 'image/jpeg',
          url: new URL('https://mastodon.example/media/photo.jpg'),
        }),
        // A non-image document is skipped.
        new Document({ mediaType: 'video/mp4', url: new URL('https://mastodon.example/media/clip.mp4') }),
        // An http image is skipped (would be blocked as mixed content on the https app).
        new Image({ mediaType: 'image/png', url: new URL('http://insecure.example/x.png') }),
        // A data: URL is skipped.
        new Image({ mediaType: 'image/png', url: new URL('data:image/png;base64,AAAA') }),
      ],
      content: '<p>pics</p>',
      id: new URL('https://mastodon.example/notes/9'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(await extractNoteImages(note)).toEqual([
      { media_type: 'image/jpeg', url: 'https://mastodon.example/media/photo.jpg' },
    ])
  })

  test('caps the number of kept images at 4 (bounds a hostile followee)', async () => {
    const note = new Note({
      attachments: Array.from(
        { length: 7 },
        (_, i) =>
          new Image({ mediaType: 'image/png', url: new URL(`https://mastodon.example/media/${i}.png`) }),
      ),
      content: '<p>many</p>',
      id: new URL('https://mastodon.example/notes/8'),
      published: published('2026-07-02T08:30:00Z'),
    })
    const images = await extractNoteImages(note)
    expect(images).toHaveLength(4)
    expect(images.map((i) => i.url)).toEqual([
      'https://mastodon.example/media/0.png',
      'https://mastodon.example/media/1.png',
      'https://mastodon.example/media/2.png',
      'https://mastodon.example/media/3.png',
    ])
  })

  test('returns an empty array for a Note with no attachments', async () => {
    const note = new Note({
      content: '<p>text only</p>',
      id: new URL('https://mastodon.example/notes/7'),
      published: published('2026-07-02T08:30:00Z'),
    })
    expect(await extractNoteImages(note)).toEqual([])
  })
})
