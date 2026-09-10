import type { TimelineEntry } from '@aurboda/api-spec'
import type { RequestHandler } from 'express'
import type { AddressInfo } from 'node:net'

import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'

import type { ReactionActions } from '../services/feed-reactions.ts'
import type { TimelineHub } from '../services/timeline-hub.ts'

import { createFeedRouter } from './feed-router.ts'

/** Stand-in auth that just sets the acting user, like the real middleware does. */
const auth: RequestHandler = (req, _res, next) => {
  req.user = 'tester'
  next()
}

/** A fake hub that captures the SSE listener so the test can fire pings, and records teardown. */
const fakeHub = () => {
  let fire: (() => void) | null = null
  let unsubscribed = false
  const hub: TimelineHub = {
    notify: async () => {},
    subscribe: async (_user, onEvent) => {
      fire = onEvent
      return async () => {
        unsubscribed = true
      }
    },
  }
  return { fire: () => fire?.(), hub, wasUnsubscribed: () => unsubscribed }
}

const startApp = (hub?: TimelineHub) => {
  const app = express()
  app.use('/feed', createFeedRouter(auth, undefined, hub))
  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { close, url: `http://127.0.0.1:${port}` }
}

describe('GET /feed/timeline/stream', () => {
  test('returns 503 when live updates are unavailable (no hub wired)', async () => {
    const app = express()
    app.use('/feed', createFeedRouter(auth, undefined, undefined))
    const res = await supertest(app).get('/feed/timeline/stream')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Live updates unavailable', success: false })
  })

  test('opens an SSE stream and forwards a hub ping as `event: new`', async () => {
    const { hub, fire } = fakeHub()
    const { url, close } = startApp(hub)
    const ctrl = new AbortController()
    try {
      const res = await fetch(`${url}/feed/timeline/stream`, { signal: ctrl.signal })
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('x-accel-buffering')).toBe('no')

      const reader = res.body?.getReader()
      if (!reader) throw new Error('no response body')
      const decoder = new TextDecoder()

      const connected = await reader.read()
      expect(decoder.decode(connected.value)).toContain(': connected')

      fire()
      const event = await reader.read()
      expect(decoder.decode(event.value)).toContain('event: new')

      ctrl.abort()
      await reader.cancel().catch(() => {})
    } finally {
      await close()
    }
  })

  test('unsubscribes from the hub when the client disconnects', async () => {
    const { hub, wasUnsubscribed } = fakeHub()
    const { url, close } = startApp(hub)
    const ctrl = new AbortController()
    try {
      const res = await fetch(`${url}/feed/timeline/stream`, { signal: ctrl.signal })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('no response body')
      await reader.read() // wait until the stream is live (subscribed)
      ctrl.abort()
      await reader.cancel().catch(() => {})
      // The server-side 'close' → cleanup is async; poll briefly for the teardown.
      for (let i = 0; i < 50 && !wasUnsubscribed(); i++) await new Promise((r) => setTimeout(r, 20))
      expect(wasUnsubscribed()).toBe(true)
    } finally {
      await close()
    }
  })
})

const ENTRY_ID = '11111111-1111-1111-1111-111111111111'

const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  actor_uri: 'https://mastodon.example/users/alice',
  avatar_url: null,
  content: '<p>Ran a 5k</p>',
  display_name: 'Alice',
  handle: '@alice@mastodon.example',
  id: ENTRY_ID,
  object_uri: 'https://mastodon.example/notes/1',
  published_at: '2026-07-01T08:00:00.000Z',
  received_at: '2026-07-01T08:00:05.000Z',
  url: 'https://mastodon.example/@alice/1',
  ...over,
})

/** A ReactionActions stub that records its calls and replays canned results. */
const fakeReactions = (
  result: Awaited<ReturnType<ReactionActions['like']>> = { entry: entry({ liked: true }), ok: true },
) => {
  const calls: string[] = []
  const record = (name: string) => async (_user: string, entryId: string) => {
    calls.push(`${name}:${entryId}`)
    return result
  }
  const actions: ReactionActions = {
    boost: record('boost'),
    like: record('like'),
    unboost: record('unboost'),
    unlike: record('unlike'),
  }
  return { actions, calls }
}

const reactionApp = (reactions?: ReactionActions) => {
  const app = express()
  app.use('/feed', createFeedRouter(auth, undefined, undefined, undefined, undefined, undefined, reactions))
  return app
}

describe('timeline reaction routes', () => {
  test('POST /feed/timeline/:id/like returns the updated entry', async () => {
    const { actions, calls } = fakeReactions()
    const res = await supertest(reactionApp(actions)).post(`/feed/timeline/${ENTRY_ID}/like`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.entry.liked).toBe(true)
    expect(calls).toEqual([`like:${ENTRY_ID}`])
  })

  test('each verb+path pair reaches its own action', async () => {
    const { actions, calls } = fakeReactions()
    const app = reactionApp(actions)
    await supertest(app).delete(`/feed/timeline/${ENTRY_ID}/like`)
    await supertest(app).post(`/feed/timeline/${ENTRY_ID}/boost`)
    await supertest(app).delete(`/feed/timeline/${ENTRY_ID}/boost`)
    expect(calls).toEqual([`unlike:${ENTRY_ID}`, `boost:${ENTRY_ID}`, `unboost:${ENTRY_ID}`])
  })

  test('surfaces a failure’s own status (e.g. an unreachable author is a 502)', async () => {
    const { actions } = fakeReactions({
      error: 'Couldn’t reach the author’s server. Please try again later.',
      ok: false,
      status: 502,
    })
    const res = await supertest(reactionApp(actions)).post(`/feed/timeline/${ENTRY_ID}/like`)
    expect(res.status).toBe(502)
    expect(res.body).toEqual({
      error: 'Couldn’t reach the author’s server. Please try again later.',
      success: false,
    })
  })

  test('404s a non-UUID entry id without calling the action', async () => {
    const { actions, calls } = fakeReactions()
    const res = await supertest(reactionApp(actions)).post('/feed/timeline/not-a-uuid/like')
    expect(res.status).toBe(404)
    expect(calls).toEqual([])
  })

  test('503s when reactions are not wired', async () => {
    const res = await supertest(reactionApp()).post(`/feed/timeline/${ENTRY_ID}/boost`)
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: 'Reactions are not available', success: false })
  })
})
