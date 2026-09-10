import type { ArticleContent } from '@aurboda/api-spec'

import { describe, expect, test, vi } from 'vitest'

import type { FeedPostRecord } from '../db/index.ts'
import type { ScatterSvgData } from '../services/charts/scatter-svg.ts'

import {
  createNegativeCache,
  createRenderCache,
  type FeedImageDeps,
  type ImageActivity,
  renderArticleBlockImage,
  resolveArticleBlock,
  type ResolvedArticleBlock,
  resolveImageWindow,
} from './feed-image-router.ts'

const POST_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ACTIVITY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const activity: ImageActivity = {
  end_time: new Date('2026-07-01T07:11:00Z'),
  start_time: new Date('2026-07-01T06:30:00Z'),
}

const makePost = (overrides: Partial<FeedPostRecord> = {}): FeedPostRecord => ({
  activity_id: ACTIVITY_ID,
  article: null,
  autoshare_rule_id: null,
  challenge: null,
  created_at: new Date('2026-07-01T08:00:00Z'),
  id: POST_ID,
  image_token: 'secret-token',
  in_reply_to_actor_uri: null,
  in_reply_to_handle: null,
  in_reply_to_uri: null,
  include_chart: true,
  include_map: true,
  included_metrics: [],
  kind: 'activity',
  message: null,
  series_metrics: [],
  updated_at: new Date('2026-07-01T08:00:00Z'),
  visibility: 'public',
  ...overrides,
})

const deps = (post: FeedPostRecord | null, act: ImageActivity | null = activity) => ({
  getActivity: async () => act,
  getPost: async () => post,
})

describe('resolveImageWindow', () => {
  test('resolves the activity window for an eligible public opted-in post', async () => {
    expect(await resolveImageWindow(deps(makePost()), 'fiddur', POST_ID, 'include_chart')).toEqual(activity)
  })

  test('null for an invalid username or non-UUID post id (no DB hit)', async () => {
    expect(await resolveImageWindow(deps(makePost()), 'Bad..Name', POST_ID, 'include_chart')).toBeNull()
    expect(await resolveImageWindow(deps(makePost()), 'fiddur', 'not-a-uuid', 'include_chart')).toBeNull()
  })

  test('null when the post is missing', async () => {
    expect(await resolveImageWindow(deps(null), 'fiddur', POST_ID, 'include_chart')).toBeNull()
  })

  test('null for a followers-only post without a token', async () => {
    const post = makePost({ image_token: 'secret-token', visibility: 'followers' })
    expect(await resolveImageWindow(deps(post), 'fiddur', POST_ID, 'include_chart')).toBeNull()
  })

  test('null for a followers-only post with the wrong token', async () => {
    const post = makePost({ image_token: 'secret-token', visibility: 'followers' })
    expect(await resolveImageWindow(deps(post), 'fiddur', POST_ID, 'include_chart', 'wrong')).toBeNull()
    // A prefix of the real token must not pass (length-checked constant-time compare).
    expect(await resolveImageWindow(deps(post), 'fiddur', POST_ID, 'include_chart', 'secret')).toBeNull()
  })

  test('resolves a followers-only post when the capability token matches (#893)', async () => {
    const post = makePost({ image_token: 'secret-token', visibility: 'followers' })
    expect(await resolveImageWindow(deps(post), 'fiddur', POST_ID, 'include_chart', 'secret-token')).toEqual(
      activity,
    )
  })

  test('a token is ignored for a public post (already unauthenticated)', async () => {
    expect(
      await resolveImageWindow(deps(makePost()), 'fiddur', POST_ID, 'include_chart', 'anything'),
    ).toEqual(activity)
  })

  test('null when the requested attachment was not opted into', async () => {
    const post = makePost({ include_chart: false })
    expect(await resolveImageWindow(deps(post), 'fiddur', POST_ID, 'include_chart')).toBeNull()
    // ...but the map flag is still on for the same post.
    expect(await resolveImageWindow(deps(post), 'fiddur', POST_ID, 'include_map')).toEqual(activity)
  })

  test('null when the post has no linked activity', async () => {
    expect(
      await resolveImageWindow(deps(makePost({ activity_id: null })), 'fiddur', POST_ID, 'include_chart'),
    ).toBeNull()
  })

  test('null for an open-ended activity (no bounded window)', async () => {
    const openEnded = { start_time: activity.start_time }
    expect(await resolveImageWindow(deps(makePost(), openEnded), 'fiddur', POST_ID, 'include_map')).toBeNull()
  })
})

const WINDOW = { end: '2026-07-02T00:00:00Z', start: '2026-07-01T00:00:00Z' }

const article = (blocks: ArticleContent['blocks'], extra: Partial<ArticleContent> = {}): ArticleContent => ({
  blocks,
  title: 'My analysis',
  ...extra,
})

const articlePost = (content: ArticleContent, overrides: Partial<FeedPostRecord> = {}): FeedPostRecord =>
  makePost({ activity_id: null, article: content, kind: 'article', ...overrides })

describe('resolveArticleBlock', () => {
  const chart = article([{ end: WINDOW.end, metric: 'heart_rate', start: WINDOW.start, type: 'chart' }])
  const correlation = article([
    {
      end: WINDOW.end,
      outcome: { kind: 'metric', metric: 'sleep_score' },
      start: WINDOW.start,
      trigger: { kind: 'metric', metric: 'steps' },
      type: 'correlation',
    },
  ])

  test('resolves a chart block to its metric and window', async () => {
    const block = await resolveArticleBlock(deps(articlePost(chart)), 'fiddur', POST_ID, 0)
    expect(block).toMatchObject({
      end: new Date(WINDOW.end),
      metric: 'heart_rate',
      start: new Date(WINDOW.start),
      type: 'chart',
    })
  })

  test('resolves a correlation block with its selectors', async () => {
    const block = await resolveArticleBlock(deps(articlePost(correlation)), 'fiddur', POST_ID, 0)
    expect(block).toMatchObject({
      outcome: { kind: 'metric', metric: 'sleep_score' },
      trigger: { kind: 'metric', metric: 'steps' },
      type: 'correlation',
    })
  })

  test('correlation day bounds are the ISO window’s date part (matches the web toDay)', async () => {
    // Windows are Z-only (iso8601DateTimeSchema), so the day is `iso.slice(0, 10)` —
    // slicing the raw string, not round-tripping through Date, keeps web parity exact.
    const corr = article([
      {
        end: '2026-07-10T06:00:00Z',
        outcome: { kind: 'metric', metric: 'sleep_score' },
        start: '2026-07-01T18:00:00Z',
        trigger: { kind: 'metric', metric: 'steps' },
        type: 'correlation',
      },
    ])
    const block = await resolveArticleBlock(deps(articlePost(corr)), 'fiddur', POST_ID, 0)
    expect(block).toMatchObject({ periodEnd: '2026-07-10', periodStart: '2026-07-01', type: 'correlation' })
  })

  test('inherits the article default window when the block omits its own', async () => {
    const content = article([{ metric: 'heart_rate', type: 'chart' }], {
      default_end: WINDOW.end,
      default_start: WINDOW.start,
    })
    const block = await resolveArticleBlock(deps(articlePost(content)), 'fiddur', POST_ID, 0)
    expect(block).toMatchObject({ end: new Date(WINDOW.end), start: new Date(WINDOW.start), type: 'chart' })
  })

  test('carries the post updated_at (so an edit busts the image cache)', async () => {
    const updated_at = new Date('2026-07-05T09:00:00Z')
    const block = await resolveArticleBlock(deps(articlePost(chart, { updated_at })), 'fiddur', POST_ID, 0)
    expect(block?.updatedAt).toEqual(updated_at)
  })

  test('null for a prose block, an out-of-range, negative, or non-integer index', async () => {
    const content = article([{ markdown: '# hi', type: 'prose' }, ...chart.blocks])
    expect(await resolveArticleBlock(deps(articlePost(content)), 'fiddur', POST_ID, 0)).toBeNull() // prose
    expect(await resolveArticleBlock(deps(articlePost(content)), 'fiddur', POST_ID, 5)).toBeNull() // out of range
    expect(await resolveArticleBlock(deps(articlePost(content)), 'fiddur', POST_ID, -1)).toBeNull()
    expect(await resolveArticleBlock(deps(articlePost(content)), 'fiddur', POST_ID, 1.5)).toBeNull()
    expect(await resolveArticleBlock(deps(articlePost(content)), 'fiddur', POST_ID, Number.NaN)).toBeNull()
  })

  test('null for a non-article post', async () => {
    expect(await resolveArticleBlock(deps(makePost()), 'fiddur', POST_ID, 0)).toBeNull()
  })

  test('gated on visibility only — no include_chart flag needed for an article', async () => {
    // A public article block resolves even with include_chart off (articles have
    // no opt-in flag; visibility is the whole boundary, #943).
    const post = articlePost(chart, { include_chart: false })
    expect(await resolveArticleBlock(deps(post), 'fiddur', POST_ID, 0)).not.toBeNull()
  })

  test('followers-only: null without a token, resolves with the matching token, null with a wrong one', async () => {
    const post = articlePost(chart, { image_token: 'secret-token', visibility: 'followers' })
    expect(await resolveArticleBlock(deps(post), 'fiddur', POST_ID, 0)).toBeNull()
    expect(await resolveArticleBlock(deps(post), 'fiddur', POST_ID, 0, 'wrong')).toBeNull()
    expect(await resolveArticleBlock(deps(post), 'fiddur', POST_ID, 0, 'secret-token')).not.toBeNull()
  })

  test('null when a block resolves to an unbounded or non-increasing window', async () => {
    const noWindow = article([{ metric: 'heart_rate', type: 'chart' }]) // no block window, no article default
    expect(await resolveArticleBlock(deps(articlePost(noWindow)), 'fiddur', POST_ID, 0)).toBeNull()
    const reversed = article([{ end: WINDOW.start, metric: 'heart_rate', start: WINDOW.end, type: 'chart' }])
    expect(await resolveArticleBlock(deps(articlePost(reversed)), 'fiddur', POST_ID, 0)).toBeNull()
  })

  test('null for an invalid username or non-UUID post id (no DB hit)', async () => {
    expect(await resolveArticleBlock(deps(articlePost(chart)), 'Bad..Name', POST_ID, 0)).toBeNull()
    expect(await resolveArticleBlock(deps(articlePost(chart)), 'fiddur', 'not-a-uuid', 0)).toBeNull()
  })
})

describe('renderArticleBlockImage', () => {
  const START = new Date('2026-07-01T00:00:00Z')
  const END = new Date('2026-07-08T00:00:00Z')
  const UPDATED = new Date('2026-07-09T00:00:00Z')
  const series: [Date, number][] = [
    [START, 60],
    [END, 65],
  ]
  const scatter: ScatterSvgData = {
    group_comparison: null,
    n: 5,
    outcome: { kind: 'metric', metric: 'sleep_score' },
    pearson: 0.5,
    pearson_p: 0.01,
    series: [{ outcome: 2, trigger: 1 }],
    spearman: 0.5,
    trigger: { kind: 'metric', metric: 'steps' },
  }

  const chartBlock: ResolvedArticleBlock = {
    end: END,
    metric: 'heart_rate',
    start: START,
    type: 'chart',
    updatedAt: UPDATED,
  }
  const correlationBlock: ResolvedArticleBlock = {
    outcome: { kind: 'metric', metric: 'sleep_score' },
    periodEnd: '2026-07-08',
    periodStart: '2026-07-01',
    trigger: { kind: 'metric', metric: 'steps' },
    type: 'correlation',
    updatedAt: UPDATED,
  }

  const mkDeps = (over: Partial<FeedImageDeps> = {}): FeedImageDeps => ({
    getActivity: async () => null,
    getArticleChartSeries: vi.fn(async () => series),
    getCorrelationScatter: vi.fn(async () => scatter),
    getPost: async () => null,
    getRoute: async () => [],
    getSeries: async () => [],
    renderChart: vi.fn(async () => Buffer.from('chart-png')),
    renderChartSvg: vi.fn(() => '<svg>chart</svg>'),
    renderRoute: async () => Buffer.from(''),
    renderScatter: vi.fn(async () => Buffer.from('scatter-png')),
    renderScatterSvg: vi.fn(() => '<svg>scatter</svg>'),
    ...over,
  })

  test('renders a chart block as PNG (labelled with the metric display name)', async () => {
    const d = mkDeps()
    const png = await renderArticleBlockImage(d, 'fiddur', chartBlock, 'png')
    expect(png).toEqual(Buffer.from('chart-png'))
    expect(d.getArticleChartSeries).toHaveBeenCalledWith('fiddur', 'heart_rate', START, END, '1d')
    expect(d.renderChart).toHaveBeenCalledWith(series, { color: '#673ab8', label: 'Heart Rate' })
  })

  test('renders a chart block as SVG bytes', async () => {
    const d = mkDeps()
    const svg = await renderArticleBlockImage(d, 'fiddur', chartBlock, 'svg')
    expect(svg).toEqual(Buffer.from('<svg>chart</svg>', 'utf8'))
    expect(d.renderScatter).not.toHaveBeenCalled()
  })

  test('renders a correlation block via the scatter renderer', async () => {
    const d = mkDeps()
    const png = await renderArticleBlockImage(d, 'fiddur', correlationBlock, 'png')
    expect(png).toEqual(Buffer.from('scatter-png'))
    expect(d.getCorrelationScatter).toHaveBeenCalledWith('fiddur', {
      lagDays: undefined,
      outcome: correlationBlock.type === 'correlation' ? correlationBlock.outcome : undefined,
      periodEnd: '2026-07-08',
      periodStart: '2026-07-01',
      trigger: correlationBlock.type === 'correlation' ? correlationBlock.trigger : undefined,
    })
  })

  test('null when the chart has < 2 points', async () => {
    const d = mkDeps({ getArticleChartSeries: vi.fn(async () => [[START, 60]] as [Date, number][]) })
    expect(await renderArticleBlockImage(d, 'fiddur', chartBlock, 'png')).toBeNull()
  })

  test('null when the correlation is too sparse (getCorrelationScatter → null)', async () => {
    const d = mkDeps({ getCorrelationScatter: vi.fn(async () => null) })
    expect(await renderArticleBlockImage(d, 'fiddur', correlationBlock, 'png')).toBeNull()
  })

  test('null for a zero-duration bucket, without hitting the DB (avoids a date_bin 500)', async () => {
    const d = mkDeps()
    const png = await renderArticleBlockImage(d, 'fiddur', { ...chartBlock, bucket: '0s' }, 'png')
    expect(png).toBeNull()
    expect(d.getArticleChartSeries).not.toHaveBeenCalled()
  })
})

describe('createNegativeCache', () => {
  test('remembers a negative key and evicts the oldest past the bound', () => {
    const neg = createNegativeCache(2)
    expect(neg.has('a')).toBe(false)
    neg.add('a')
    neg.add('b')
    expect(neg.has('a')).toBe(true)
    neg.add('c') // over the bound → evicts the oldest ('a')
    expect(neg.has('a')).toBe(false)
    expect(neg.has('c')).toBe(true)
  })
})

describe('createRenderCache', () => {
  const png = (s: string) => Buffer.from(s)

  test('renders once per key, then serves the cached buffer', async () => {
    const cached = createRenderCache()
    const produce = vi.fn(async () => png('a'))
    expect(await cached('k', produce)).toEqual(png('a'))
    expect(await cached('k', produce)).toEqual(png('a'))
    expect(produce).toHaveBeenCalledTimes(1)
  })

  test('de-duplicates concurrent misses into a single render', async () => {
    const cached = createRenderCache()
    const produce = vi.fn(async () => png('b'))
    const [a, b] = await Promise.all([cached('k', produce), cached('k', produce)])
    expect(a).toEqual(png('b'))
    expect(b).toEqual(png('b'))
    expect(produce).toHaveBeenCalledTimes(1)
  })

  test('renders separately per key', async () => {
    const cached = createRenderCache()
    const produce = vi.fn(async (): Promise<Buffer | null> => png('x'))
    await cached('k1', produce)
    await cached('k2', produce)
    expect(produce).toHaveBeenCalledTimes(2)
  })

  test('does not cache a null (no-data) result', async () => {
    const cached = createRenderCache()
    const produce = vi.fn(async (): Promise<Buffer | null> => null)
    expect(await cached('k', produce)).toBeNull()
    expect(await cached('k', produce)).toBeNull()
    expect(produce).toHaveBeenCalledTimes(2)
  })

  test('evicts the oldest entry past the bound', async () => {
    const cached = createRenderCache(1)
    const produce = vi.fn(async (): Promise<Buffer | null> => png('v'))
    await cached('k1', produce) // cached
    await cached('k2', produce) // evicts k1
    await cached('k1', produce) // re-renders (was evicted)
    expect(produce).toHaveBeenCalledTimes(3)
  })
})
