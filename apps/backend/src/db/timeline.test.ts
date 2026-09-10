import { describe, expect, test } from 'vitest'

import { escapeLike, timelineReplyFilterSql } from './timeline.ts'

describe('escapeLike', () => {
  test('escapes LIKE’s own wildcards so a prefix stays literal', () => {
    // Without this, `foo_bar` matches `fooxbar`: `_` is LIKE's single-character
    // wildcard, and a username may contain one.
    expect(escapeLike('foo_bar')).toBe('foo\\_bar')
    expect(escapeLike('50%')).toBe('50\\%')
    expect(escapeLike('back\\slash')).toBe('back\\\\slash')
  })

  test('leaves a plain prefix untouched', () => {
    expect(escapeLike('https://aurboda.example/users/freja/feed/')).toBe(
      'https://aurboda.example/users/freja/feed/',
    )
  })
})

describe('timelineReplyFilterSql', () => {
  test('places the caller’s placeholders and keeps every always-visible clause', () => {
    const sql = timelineReplyFilterSql('$4', '$5')
    expect(sql).toContain('$4::boolean')
    expect(sql).toContain('LIKE $5')
    // A boost card is never filtered as a reply, involvement always shows, and a
    // reply to a post already in this timeline shows.
    expect(sql).toContain('boost_of_uri IS NOT NULL')
    expect(sql).toContain('mentions_me')
    expect(sql).toContain('p.object_uri = timeline_entry.in_reply_to_uri')
  })
})
