import type { AddressInfo } from 'node:net'

import express from 'express'
import supertest from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

/**
 * Integration test for the public profile feed endpoint
 * (`GET /public/:username/posts`) against a live database. Covers the endpoint's
 * own contribution over the already-tested db/serializer layers: the
 * public/unlisted visibility filter, the response shape, and the 404 branches.
 */
import { insertActivity } from '../db/activities/index.ts'
import { createArticlePost, createFeedPost } from '../db/feed.ts'
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import { createFeedPublicRouter } from './feed-public-router.ts'

const CONTAINER_TIMEOUT = 120_000
const START = new Date('2026-07-01T08:00:00Z')
const END = new Date('2026-07-01T08:40:00Z')

const startApp = () => {
  const app = express()
  app.use(createFeedPublicRouter())
  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { close, request: supertest(`http://127.0.0.1:${port}`) }
}

const seedPost = async (user: string, visibility: 'public' | 'unlisted' | 'followers'): Promise<string> => {
  const activityId = await insertActivity(user, {
    activity_type: 'exercise',
    end_time: END,
    source: 'garmin',
    start_time: START,
    title: 'Morning run',
  })
  const post = await createFeedPost(user, {
    activity_id: activityId,
    include_chart: false,
    include_map: false,
    included_metrics: ['duration'],
    series_metrics: [],
    visibility,
  })
  return post.id
}

describe('GET /public/:username/posts', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('serves public and unlisted posts but never followers-only', async () => {
    const user = getTestUser()
    const publicId = await seedPost(user, 'public')
    const unlistedId = await seedPost(user, 'unlisted')
    const followersId = await seedPost(user, 'followers')

    const { request, close } = startApp()
    try {
      const res = await request.get(`/public/${user}/posts`)
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const ids = res.body.posts.map((p: { id: string }) => p.id)
      expect(ids).toContain(publicId)
      expect(ids).toContain(unlistedId)
      expect(ids).not.toContain(followersId)
      // Every returned post is serialized with its visibility.
      for (const post of res.body.posts) {
        expect(['public', 'unlisted']).toContain(post.visibility)
      }
    } finally {
      await close()
    }
  })

  test('attaches the structured payload so the profile page renders natively', async () => {
    const user = getTestUser()
    const id = await seedPost(user, 'public')
    const { request, close } = startApp()
    try {
      const res = await request.get(`/public/${user}/posts`)
      expect(res.status).toBe(200)
      const post = res.body.posts.find((p: { id: string }) => p.id === id)
      expect(post.structured).toMatchObject({
        activity_type: 'exercise',
        kind: 'activity',
        metrics: [{ key: 'duration', unit: 'seconds', value: 2400 }],
        series: [],
        start_time: START.toISOString(),
        title: 'Morning run',
      })
    } finally {
      await close()
    }
  })

  test('pages past the fixed page size with next_cursor (#1055)', async () => {
    const user = getTestUser()
    // Articles: no activity anchor, so the page costs no structured resolution.
    const ids: string[] = []
    for (let i = 0; i < 21; i++) {
      const post = await createArticlePost(user, {
        article: { blocks: [{ markdown: `Body ${i}`, type: 'prose' }], title: `Post ${i}` },
        visibility: 'public',
      })
      ids.push(post.id)
    }

    const { request, close } = startApp()
    try {
      const page1 = await request.get(`/public/${user}/posts`)
      expect(page1.status).toBe(200)
      expect(page1.body.posts).toHaveLength(20)
      expect(page1.body.next_cursor).toEqual(expect.any(String))

      const page2 = await request
        .get(`/public/${user}/posts`)
        .query({ cursor: page1.body.next_cursor as string })
      expect(page2.status).toBe(200)
      // The 21st (oldest) post — unreachable before pagination existed.
      expect(page2.body.posts.map((p: { id: string }) => p.id)).toEqual([ids[0]])
      expect(page2.body.next_cursor).toBeNull()

      // Every post is seen exactly once across the walk.
      const walked = [...page1.body.posts, ...page2.body.posts].map((p: { id: string }) => p.id)
      expect(new Set(walked).size).toBe(21)
    } finally {
      await close()
    }
  })

  test('a malformed cursor falls back to the first page (never a 500)', async () => {
    const user = getTestUser()
    const id = await seedPost(user, 'public')
    const { request, close } = startApp()
    try {
      const res = await request.get(`/public/${user}/posts`).query({ cursor: 'garbage-cursor' })
      expect(res.status).toBe(200)
      expect(res.body.posts.map((p: { id: string }) => p.id)).toEqual([id])
    } finally {
      await close()
    }
  })

  test('returns an empty list for a user with no public posts', async () => {
    const user = getTestUser()
    await seedPost(user, 'followers') // only a followers-only post exists
    const { request, close } = startApp()
    try {
      const res = await request.get(`/public/${user}/posts`)
      expect(res.status).toBe(200)
      expect(res.body.posts).toEqual([])
    } finally {
      await close()
    }
  })

  test('404s for a malformed username (never touches a database)', async () => {
    const { request, close } = startApp()
    try {
      const res = await request.get('/public/Invalid/posts')
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Not found', posts: [], success: false })
    } finally {
      await close()
    }
  })
})
