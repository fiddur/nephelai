/**
 * Unit tests for the pure parts of challenge federation: how a public challenge
 * link is canonicalised (what every URL comparison keys off) and parsed.
 */
import { describe, expect, test } from 'vitest'

import { canonicalChallengeUrl, parseChallengeUrl } from './challenge-federation.ts'

describe('canonicalChallengeUrl', () => {
  test('drops the query, the fragment, trailing slashes and a default port', () => {
    expect(canonicalChallengeUrl('https://peer.example/u/alice/abc?embed=1')).toBe(
      'https://peer.example/u/alice/abc',
    )
    expect(canonicalChallengeUrl('https://peer.example/u/alice/abc#standings')).toBe(
      'https://peer.example/u/alice/abc',
    )
    expect(canonicalChallengeUrl('https://peer.example/u/alice/abc///')).toBe(
      'https://peer.example/u/alice/abc',
    )
    expect(canonicalChallengeUrl('https://peer.example:443/u/alice/abc')).toBe(
      'https://peer.example/u/alice/abc',
    )
  })

  test('lowercases scheme and host but not the path', () => {
    expect(canonicalChallengeUrl('HTTPS://Peer.Example/u/Alice/AbC')).toBe('https://peer.example/u/Alice/AbC')
  })

  test('keeps a non-default port and a sub-path base', () => {
    expect(canonicalChallengeUrl('http://localhost:8080/u/alice/abc/')).toBe(
      'http://localhost:8080/u/alice/abc',
    )
    expect(canonicalChallengeUrl('https://peer.example/aurboda/u/alice/abc')).toBe(
      'https://peer.example/aurboda/u/alice/abc',
    )
  })

  test('null for anything that is not an http(s) URL', () => {
    expect(canonicalChallengeUrl('not a url')).toBeNull()
    expect(canonicalChallengeUrl('/u/alice/abc')).toBeNull()
    expect(canonicalChallengeUrl('ftp://peer.example/u/alice/abc')).toBeNull()
    expect(canonicalChallengeUrl('javascript:alert(1)')).toBeNull()
  })

  test('a canonicalised link parses without the query glued to the slug', () => {
    const url = canonicalChallengeUrl('https://peer.example/u/alice/abc?embed=1')
    expect(url && parseChallengeUrl(url)).toEqual({
      base: 'https://peer.example',
      slug: 'abc',
      username: 'alice',
    })
    // What the raw link would have parsed to, and why canonicalising comes first.
    expect(parseChallengeUrl('https://peer.example/u/alice/abc?embed=1')?.slug).toBe('abc?embed=1')
  })
})

describe('parseChallengeUrl', () => {
  test('splits `<base>/u/<username>/<slug>`, sub-path base included', () => {
    expect(parseChallengeUrl('https://peer.example/u/alice/abc')).toEqual({
      base: 'https://peer.example',
      slug: 'abc',
      username: 'alice',
    })
    expect(parseChallengeUrl('https://peer.example/aurboda/u/alice/abc/')).toEqual({
      base: 'https://peer.example/aurboda',
      slug: 'abc',
      username: 'alice',
    })
  })

  test('null without a `/u/` segment, a username or a slug', () => {
    expect(parseChallengeUrl('https://peer.example/alice/abc')).toBeNull()
    expect(parseChallengeUrl('https://peer.example/u/alice')).toBeNull()
    expect(parseChallengeUrl('/u/alice/abc')).toBeNull()
  })
})
