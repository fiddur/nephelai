import type { TimelineEntry } from '@aurboda/api-spec'

import { describe, expect, it } from 'vitest'

import { patchTimelineEntry, type TimelinePages, withReaction } from './timeline-actions'

const entry = (id: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  actor_uri: 'https://mastodon.example/users/alice',
  avatar_url: null,
  content: '<p>Ran a 5k</p>',
  display_name: 'Alice',
  handle: '@alice@mastodon.example',
  id,
  object_uri: `https://mastodon.example/notes/${id}`,
  published_at: '2026-07-01T08:00:00.000Z',
  received_at: '2026-07-01T08:00:05.000Z',
  url: null,
  ...over,
})

const pages = (...groups: TimelineEntry[][]): TimelinePages => ({
  pageParams: groups.map(() => undefined),
  pages: groups.map((entries) => ({ entries, next_cursor: null, success: true })),
})

describe('patchTimelineEntry', () => {
  it('patches the entry wherever it sits, across every cached page', () => {
    const data = pages([entry('a'), entry('b')], [entry('c')])
    const patched = patchTimelineEntry(data, 'c', (e) => ({ ...e, liked: true }))
    expect(patched?.pages[1].entries[0].liked).toBe(true)
    // Untouched entries keep their identity, so unrelated cards don't re-render.
    expect(patched?.pages[0].entries[0]).toBe(data.pages[0].entries[0])
  })

  it('leaves the cache alone when the entry is absent, and passes undefined through', () => {
    const data = pages([entry('a')])
    const patched = patchTimelineEntry(data, 'missing', (e) => ({ ...e, liked: true }))
    expect(patched?.pages[0].entries).toEqual(data.pages[0].entries)
    expect(patchTimelineEntry(undefined, 'a', (e) => e)).toBeUndefined()
  })

  it('does not mutate the input (react-query caches must stay immutable)', () => {
    const data = pages([entry('a')])
    patchTimelineEntry(data, 'a', (e) => ({ ...e, boosted: true }))
    expect(data.pages[0].entries[0]).not.toHaveProperty('boosted')
  })
})

describe('withReaction', () => {
  it('sets the flag when turning a reaction on', () => {
    expect(withReaction(entry('a'), 'liked', true).liked).toBe(true)
    expect(withReaction(entry('a'), 'boosted', true).boosted).toBe(true)
  })

  it('REMOVES the flag when turning it off, rather than setting it false', () => {
    // The api-spec convention is "present only when true" — a `liked: false`
    // would still read as truthy-shaped state to anything checking presence.
    const off = withReaction(entry('a', { liked: true }), 'liked', false)
    expect(off).not.toHaveProperty('liked')
  })

  it('leaves the other reaction untouched', () => {
    const both = entry('a', { boosted: true, liked: true })
    expect(withReaction(both, 'liked', false).boosted).toBe(true)
  })
})
