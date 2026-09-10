import { describe, expect, it } from 'vitest'

import { entryMarkers, originHost } from './entry-markers'

describe('entryMarkers', () => {
  it('shows nothing for a plain top-level post', () => {
    expect(entryMarkers({})).toEqual([])
  })

  it('marks a reply to somebody else', () => {
    expect(entryMarkers({ in_reply_to_uri: 'https://x.example/1' })).toEqual([
      { icon: '↩', label: 'a reply' },
    ])
  })

  it('marks a reply to you', () => {
    expect(
      entryMarkers({ in_reply_to_mine: true, in_reply_to_uri: 'https://aurboda.example/users/me/feed/1' }),
    ).toEqual([{ icon: '↩', label: 'replied to you' }])
  })

  it('marks a bare mention', () => {
    expect(entryMarkers({ mentions_me: true })).toEqual([{ icon: '@', label: 'mentioned you' }])
  })

  it('shows BOTH when a reply to someone else also mentions you (#1066)', () => {
    expect(entryMarkers({ in_reply_to_uri: 'https://x.example/1', mentions_me: true })).toEqual([
      { icon: '↩', label: 'a reply' },
      { icon: '@', label: 'mentioned you' },
    ])
  })

  it('collapses the mention into "replied to you" — it is already implied', () => {
    expect(
      entryMarkers({
        in_reply_to_mine: true,
        in_reply_to_uri: 'https://aurboda.example/users/me/feed/1',
        mentions_me: true,
      }),
    ).toEqual([{ icon: '↩', label: 'replied to you' }])
  })
})

describe('originHost', () => {
  it('names the serving host', () => {
    expect(originHost('https://mastodon.example/users/alice/statuses/9')).toBe('mastodon.example')
  })

  it('falls back to a generic phrase for an unparseable id', () => {
    expect(originHost('not a url')).toBe('the origin')
  })
})
