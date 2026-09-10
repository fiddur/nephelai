import type { RequestHandler } from 'express'
import type { AddressInfo } from 'node:net'

import express from 'express'
import supertest from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Integration test for the owner-facing article routes on the feed router
 * (`POST /feed/articles`, `PATCH /feed/articles/:postId`) against a live
 * database — the route + `buildArticleContent`/`mergeArticleContent` service +
 * serializer composition over the already-unit-tested pieces. A fake `deliver`
 * spy covers the article fan-out branches (including `kind === 'article'` on the
 * generic `PATCH /:postId`); the actual AS2 delivery is unit-tested in `deliver`.
 */
import { insertActivity } from '../db/activities/index.ts'
import { createChallenge, createChallengeParticipation } from '../db/challenges.ts'
import { upsertFeedPostReaction } from '../db/feed-reactions.ts'
import { createFeedPost } from '../db/feed.ts'
import { insertTimeSeries } from '../db/time-series.ts'
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../test/db-test-helper.ts'
import { type FeedDeliver, createFeedRouter } from './feed-router.ts'

const CONTAINER_TIMEOUT = 120_000

const auth: RequestHandler = (req, _res, next) => {
  req.user = getTestUser()
  next()
}

const startApp = (deliver?: FeedDeliver, apiBaseUrl?: string, webHost?: string) => {
  const app = express()
  app.use(express.json())
  app.use('/feed', createFeedRouter(auth, deliver, undefined, apiBaseUrl, undefined, webHost))
  const server = app.listen(0)
  const port = (server.address() as AddressInfo).port
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return { close, request: supertest(`http://127.0.0.1:${port}`) }
}

const articleBody = () => ({
  blocks: [
    { markdown: '# Sleep vs HRV\n\nA look at the week.', type: 'prose' },
    { caption: 'Resting HR', metric: 'heart_rate', type: 'chart' }, // inherits the default window
  ],
  default_end: '2026-07-07T00:00:00.000Z',
  default_start: '2026-07-01T00:00:00.000Z',
  title: 'A week of sleep and HRV',
  visibility: 'public',
})

describe('Article feed routes (integration)', () => {
  let app: ReturnType<typeof startApp>

  beforeAll(async () => {
    await startTestDb()
    app = startApp()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await app.close()
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('POST /feed/articles creates an article and returns the serialized post', async () => {
    const res = await app.request.post('/feed/articles').send(articleBody())
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.post.kind).toBe('article')
    expect(res.body.post.activity_id).toBeNull()
    expect(res.body.post.article.title).toBe('A week of sleep and HRV')
    expect(res.body.post.article.blocks).toHaveLength(2)
    expect(res.body.post.visibility).toBe('public')
  })

  test('POST /feed/articles rejects a chart block with no resolvable window (400)', async () => {
    const res = await app.request.post('/feed/articles').send({
      // No default window and the chart block has none either.
      blocks: [{ metric: 'heart_rate', type: 'chart' }],
      title: 'Broken',
      visibility: 'public',
    })
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.error).toContain('no time window')
  })

  test('PATCH /feed/articles/:postId replaces provided fields', async () => {
    const created = await app.request.post('/feed/articles').send(articleBody())
    const id = created.body.post.id

    const res = await app.request
      .patch(`/feed/articles/${id}`)
      .send({ blocks: [{ markdown: 'Rewritten.', type: 'prose' }], title: 'Revised', visibility: 'unlisted' })
    expect(res.status).toBe(200)
    expect(res.body.post.article.title).toBe('Revised')
    expect(res.body.post.article.blocks).toEqual([{ markdown: 'Rewritten.', type: 'prose' }])
    expect(res.body.post.visibility).toBe('unlisted')
    // The default window was not part of the patch, so it is preserved.
    expect(res.body.post.article.default_start).toBe('2026-07-01T00:00:00.000Z')
  })

  test('PATCH /feed/articles/:postId 404s for an unknown id', async () => {
    const res = await app.request
      .patch('/feed/articles/00000000-0000-0000-0000-000000000000')
      .send({ title: 'x' })
    expect(res.status).toBe(404)
  })

  test('PATCH /feed/articles/:postId 404s for a non-article (activity) post', async () => {
    const activityPost = await createFeedPost(getTestUser(), {
      activity_id: null,
      include_chart: false,
      include_map: false,
      included_metrics: [],
      series_metrics: [],
      visibility: 'public',
    })
    const res = await app.request.patch(`/feed/articles/${activityPost.id}`).send({ title: 'nope' })
    expect(res.status).toBe(404)
  })

  test('DELETE /feed/:postId removes an article', async () => {
    const created = await app.request.post('/feed/articles').send(articleBody())
    const del = await app.request.delete(`/feed/${created.body.post.id}`)
    expect(del.status).toBe(200)
    const list = await app.request.get('/feed')
    expect(list.body.posts.map((p: { id: string }) => p.id)).not.toContain(created.body.post.id)
  })

  test('article fan-out: create → createdArticle; generic PATCH /:postId → updatedArticle (not updated)', async () => {
    const deliver: FeedDeliver = {
      created: vi.fn(),
      createdArticle: vi.fn(),
      deleted: vi.fn(),
      updated: vi.fn(),
      createdChallenge: vi.fn(),
      updatedArticle: vi.fn(),
      updatedChallenge: vi.fn(),
    }
    const spied = startApp(deliver)
    try {
      const created = await spied.request.post('/feed/articles').send(articleBody())
      expect(created.status).toBe(200)
      expect(deliver.createdArticle).toHaveBeenCalledTimes(1)

      // The GENERIC patch (not /feed/articles/:postId) on an article must route
      // through `updatedArticle` — `updated` no-ops for a post with no activity.
      const patched = await spied.request
        .patch(`/feed/${created.body.post.id}`)
        .send({ visibility: 'followers' })
      expect(patched.status).toBe(200)
      expect(deliver.updatedArticle).toHaveBeenCalledTimes(1)
      expect(deliver.updated).not.toHaveBeenCalled()
    } finally {
      await spied.close()
    }
  })
})

describe('GET /feed/articles/:postId/export (Reddit/markdown export, C4)', () => {
  let withBase: ReturnType<typeof startApp>
  let noBase: ReturnType<typeof startApp>

  beforeAll(async () => {
    await startTestDb()
    withBase = startApp(undefined, 'https://aurboda.example/api')
    noBase = startApp()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await withBase.close()
    await noBase.close()
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('returns paste-ready markdown linking each block whose image renders (#974)', async () => {
    // Give the chart block real data — the export only links blocks whose image
    // endpoint would actually render (≥ 2 points in the window).
    await insertTimeSeries(getTestUser(), [
      { metric: 'heart_rate', source: 'garmin', time: new Date('2026-07-02T08:00:00Z'), value: 62 },
      { metric: 'heart_rate', source: 'garmin', time: new Date('2026-07-03T08:00:00Z'), value: 58 },
      { metric: 'heart_rate', source: 'garmin', time: new Date('2026-07-04T08:00:00Z'), value: 60 },
    ])
    const created = await withBase.request.post('/feed/articles').send(articleBody())
    const postId = created.body.post.id
    const res = await withBase.request.get(`/feed/articles/${postId}/export`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.markdown).toContain('# A week of sleep and HRV')
    expect(res.body.markdown).toContain('A look at the week.')
    expect(res.body.markdown).toContain(
      `https://aurboda.example/api/public/${getTestUser()}/feed/${postId}/blocks/1/image.png`,
    )
  })

  test('a block whose image would 404 (no data) gets a note instead of a dead link (#974)', async () => {
    const created = await withBase.request.post('/feed/articles').send(articleBody())
    const postId = created.body.post.id
    // Clean DB: the heart_rate window has no samples, so the image endpoint 404s.
    const res = await withBase.request.get(`/feed/articles/${postId}/export`)
    expect(res.status).toBe(200)
    expect(res.body.markdown).not.toContain('image.png')
    expect(res.body.markdown).toContain('*Resting HR — not enough data in this window.*')
  })

  test('404s for a non-article post', async () => {
    const activityPost = await createFeedPost(getTestUser(), {
      activity_id: null,
      include_chart: false,
      include_map: false,
      included_metrics: [],
      series_metrics: [],
      visibility: 'public',
    })
    const res = await withBase.request.get(`/feed/articles/${activityPost.id}/export`)
    expect(res.status).toBe(404)
  })

  test('503s when the server has no apiBaseUrl configured', async () => {
    const created = await noBase.request.post('/feed/articles').send(articleBody())
    const res = await noBase.request.get(`/feed/articles/${created.body.post.id}/export`)
    expect(res.status).toBe(503)
  })

  test('400s for a followers-only article (its images need a private token)', async () => {
    const created = await withBase.request
      .post('/feed/articles')
      .send({ ...articleBody(), visibility: 'followers' })
    const res = await withBase.request.get(`/feed/articles/${created.body.post.id}/export`)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('followers-only')
  })
})

describe('POST /feed/activities/:id/preview (live share preview — #902)', () => {
  let app: ReturnType<typeof startApp>

  beforeAll(async () => {
    await startTestDb()
    app = startApp()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await app.close()
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('returns the EXACT content a share of the same selection would federate', async () => {
    const user = getTestUser()
    const activityId = await insertActivity(user, {
      activity_type: 'running',
      end_time: new Date('2026-08-01T08:30:00Z'),
      source: 'garmin',
      start_time: new Date('2026-08-01T08:00:00Z'),
      title: 'Morning run',
    })
    const selection = { included_metrics: ['duration'], message: 'So good!', visibility: 'public' }

    const preview = await app.request.post(`/feed/activities/${activityId}/preview`).send(selection)
    expect(preview.status).toBe(200)
    expect(preview.body.content).toContain('<strong>Morning run</strong>')
    expect(preview.body.content).toContain('<p>So good!</p>')
    expect(preview.body.metrics).toEqual([expect.objectContaining({ key: 'duration', value: 1800 })])

    // Nothing was created…
    const listBefore = await app.request.get('/feed')
    expect(listBefore.body.posts).toEqual([])

    // …and an actual share of the same selection federates the same content.
    const shared = await app.request.post(`/feed/activities/${activityId}/share`).send(selection)
    expect(shared.status).toBe(200)
    expect(shared.body.post.content).toBe(preview.body.content)
  })

  test('404s for an unknown activity', async () => {
    const res = await app.request
      .post('/feed/activities/11111111-2222-4333-8444-555555555555/preview')
      .send({ included_metrics: ['duration'] })
    expect(res.status).toBe(404)
  })
})

describe('POST /feed/challenges (share a challenge — #994)', () => {
  let app: ReturnType<typeof startApp>
  let deliver: FeedDeliver

  beforeAll(async () => {
    await startTestDb()
    deliver = {
      created: vi.fn(),
      createdArticle: vi.fn(),
      createdChallenge: vi.fn(),
      deleted: vi.fn(),
      updated: vi.fn(),
      updatedArticle: vi.fn(),
      updatedChallenge: vi.fn(),
    }
    app = startApp(deliver, undefined, 'https://aurboda.example')
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await app.close()
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
    vi.clearAllMocks()
  })

  const spec = {
    activity_type_id: null,
    aggregation: 'sum' as const,
    bucket_size: '1d' as const,
    pattern: 'steps',
    source_type: 'metric' as const,
    unit: 'steps',
  }

  test('shares one of my own challenges: resolves name + canonical share URL server-side', async () => {
    const user = getTestUser()
    const challenge = await createChallenge(user, {
      announce_winner: true,
      end_ts: new Date('2026-08-31T00:00:00Z'),
      is_public: true,
      name: 'August 10k',
      spec,
      start_ts: new Date('2026-08-01T00:00:00Z'),
      timezone: 'Europe/Stockholm',
    })

    const res = await app.request
      .post('/feed/challenges')
      .send({ challenge_id: challenge.id, message: 'Join me — **daily**!', visibility: 'public' })
    expect(res.status).toBe(200)
    expect(res.body.post.kind).toBe('challenge')
    expect(res.body.post.challenge).toEqual({
      name: 'August 10k',
      url: `https://aurboda.example/u/${user}/${challenge.slug}`,
    })
    expect(res.body.post.message).toBe('Join me — **daily**!')
    expect(deliver.createdChallenge).toHaveBeenCalledTimes(1)
  })

  test('shares a joined (remote) challenge from its stored participation', async () => {
    const user = getTestUser()
    const participation = await createChallengeParticipation(user, {
      challenge_url: 'https://peer.example/u/bob/spring-run',
      end_ts: new Date('2026-08-31T00:00:00Z'),
      host_identity: '@bob@peer.example',
      name: 'Spring run',
      spec,
      start_ts: new Date('2026-08-01T00:00:00Z'),
      timezone: 'UTC',
    })

    const res = await app.request
      .post('/feed/challenges')
      .send({ participation_id: participation.id, visibility: 'followers' })
    expect(res.status).toBe(200)
    expect(res.body.post.challenge).toEqual({
      host_identity: '@bob@peer.example',
      name: 'Spring run',
      url: 'https://peer.example/u/bob/spring-run',
    })
    expect(res.body.post.visibility).toBe('followers')
  })

  test('400s unless exactly one of challenge_id/participation_id is given', async () => {
    const both = await app.request.post('/feed/challenges').send({
      challenge_id: '11111111-2222-4333-8444-555555555555',
      participation_id: '11111111-2222-4333-8444-555555555556',
    })
    expect(both.status).toBe(400)
    const neither = await app.request.post('/feed/challenges').send({})
    expect(neither.status).toBe(400)
  })

  test('404s for an unknown challenge or participation', async () => {
    const c = await app.request
      .post('/feed/challenges')
      .send({ challenge_id: '11111111-2222-4333-8444-555555555555' })
    expect(c.status).toBe(404)
    const p = await app.request
      .post('/feed/challenges')
      .send({ participation_id: '11111111-2222-4333-8444-555555555555' })
    expect(p.status).toBe(404)
  })

  test('a visibility flip via the generic PATCH federates through the challenge path', async () => {
    const user = getTestUser()
    const challenge = await createChallenge(user, {
      announce_winner: true,
      end_ts: new Date('2026-08-31T00:00:00Z'),
      is_public: true,
      name: 'August 10k',
      spec,
      start_ts: new Date('2026-08-01T00:00:00Z'),
      timezone: 'UTC',
    })
    const created = await app.request.post('/feed/challenges').send({ challenge_id: challenge.id })
    const patched = await app.request.patch(`/feed/${created.body.post.id}`).send({ visibility: 'unlisted' })
    expect(patched.status).toBe(200)
    expect(deliver.updatedChallenge).toHaveBeenCalledTimes(1)
    expect(deliver.updated).not.toHaveBeenCalled()
    expect(deliver.updatedArticle).not.toHaveBeenCalled()
  })
})

describe('Feed post reactions (integration)', () => {
  let app: ReturnType<typeof startApp>

  const post = () =>
    createFeedPost(getTestUser(), {
      activity_id: null,
      include_chart: false,
      include_map: false,
      included_metrics: [],
      series_metrics: [],
      visibility: 'public',
    })

  beforeAll(async () => {
    await startTestDb()
    app = startApp()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await app.close()
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('GET /feed/:postId/reactions lists who liked and boosted, newest first', async () => {
    const user = getTestUser()
    const created = await post()
    await upsertFeedPostReaction(user, {
      actor_uri: 'https://mastodon.example/users/alice',
      display_name: 'Alice',
      handle: '@alice@mastodon.example',
      kind: 'like',
      post_id: created.id,
    })
    await upsertFeedPostReaction(user, {
      actor_uri: 'https://remote.example/users/bob',
      handle: '@bob@remote.example',
      kind: 'announce',
      post_id: created.id,
    })

    const res = await app.request.get(`/feed/${created.id}/reactions`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.reactions).toHaveLength(2)
    expect(res.body.reactions.map((r: { kind: string }) => r.kind).sort()).toEqual(['announce', 'like'])
    // Internal bookkeeping never reaches the wire.
    expect(res.body.reactions[0]).not.toHaveProperty('post_id')
  })

  test('GET /feed/:postId/reactions 404s an unknown or non-UUID post id', async () => {
    expect((await app.request.get('/feed/00000000-0000-0000-0000-000000000000/reactions')).status).toBe(404)
    expect((await app.request.get('/feed/not-a-uuid/reactions')).status).toBe(404)
  })

  test('GET /feed attaches like_count / boost_count to the listing', async () => {
    const user = getTestUser()
    const counted = await post()
    const uncounted = await post()
    await upsertFeedPostReaction(user, {
      actor_uri: 'https://mastodon.example/users/alice',
      kind: 'like',
      post_id: counted.id,
    })
    await upsertFeedPostReaction(user, {
      actor_uri: 'https://remote.example/users/bob',
      kind: 'like',
      post_id: counted.id,
    })

    const res = await app.request.get('/feed')
    const byId = Object.fromEntries(
      res.body.posts.map((p: { id: string; like_count: number; boost_count: number }) => [
        p.id,
        { boost: p.boost_count, like: p.like_count },
      ]),
    )
    expect(byId[counted.id]).toEqual({ boost: 0, like: 2 })
    expect(byId[uncounted.id]).toEqual({ boost: 0, like: 0 })
  })
})
