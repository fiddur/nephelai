import { describe, expect, test } from 'vitest'

import { actorUriToHandle, renderReplyContent, replyMentionName } from './reply-object.ts'

describe('actorUriToHandle', () => {
  test('maps a Mastodon-style actor URI to `@user@host`', () => {
    expect(actorUriToHandle('https://mastodon.example/users/alice')).toBe('@alice@mastodon.example')
  })

  test('handles a percent-encoded username and a sub-path instance', () => {
    expect(actorUriToHandle('https://host.example/aurboda/users/a%20b')).toBe('@a b@host.example')
  })

  test('is null for a non-URL or a path with no last segment', () => {
    expect(actorUriToHandle('not a url')).toBeNull()
    expect(actorUriToHandle('https://mastodon.example/')).toBeNull()
  })
})

describe('replyMentionName', () => {
  const base = { in_reply_to_actor_uri: 'https://mastodon.example/users/alice', message: null }

  test('prefers the snapshot taken at reply time', () => {
    expect(replyMentionName({ ...base, in_reply_to_handle: '@alice@mastodon.example' })).toBe(
      '@alice@mastodon.example',
    )
  })

  test('derives one from the actor URI when there is no snapshot', () => {
    expect(replyMentionName({ ...base, in_reply_to_handle: null })).toBe('@alice@mastodon.example')
  })

  test('falls back to the actor URI rather than naming nobody', () => {
    expect(
      replyMentionName({ in_reply_to_actor_uri: 'weird://x', in_reply_to_handle: null, message: null }),
    ).toBe('weird://x')
  })
})

describe('renderReplyContent', () => {
  const post = {
    in_reply_to_actor_uri: 'https://mastodon.example/users/alice',
    in_reply_to_handle: '@alice@mastodon.example',
    message: 'Nice **run**!',
  }

  test('leads with the mention link, then the rendered markdown', () => {
    const html = renderReplyContent(post)
    expect(html).toContain(
      '<a href="https://mastodon.example/users/alice" class="u-url mention">@alice@mastodon.example</a>',
    )
    expect(html).toContain('class="h-card"')
    expect(html.indexOf('u-url mention')).toBeLessThan(html.indexOf('<strong>run</strong>'))
  })

  test('sanitises the author’s markdown at the outbound boundary', () => {
    const html = renderReplyContent({ ...post, message: 'hi <script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('hi')
  })

  test('escapes a hostile handle instead of letting it close the anchor', () => {
    const html = renderReplyContent({ ...post, in_reply_to_handle: '"><img src=x onerror=1>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('renders bare prose when there is no resolvable target', () => {
    const html = renderReplyContent({ in_reply_to_actor_uri: null, in_reply_to_handle: null, message: 'hi' })
    expect(html).not.toContain('mention')
    expect(html).toContain('hi')
  })

  test('drops a mention whose actor URI is not http(s)', () => {
    // The rendered content is federated AND fed to the web's HTML sink, so a
    // non-http scheme must not survive as an href — escaping wouldn't stop the
    // click. Unreachable from a stored actor_uri today; a belt on top of braces.
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'not a url']) {
      const html = renderReplyContent({
        in_reply_to_actor_uri: hostile,
        in_reply_to_handle: '@mallory@evil.example',
        message: 'hi',
      })
      expect(html).not.toContain('href')
      expect(html).not.toContain('mention')
      expect(html).toContain('hi')
    }
  })

  test('is empty for a reply with neither target nor text', () => {
    expect(renderReplyContent({ in_reply_to_actor_uri: null, in_reply_to_handle: null, message: null })).toBe(
      '',
    )
  })
})
