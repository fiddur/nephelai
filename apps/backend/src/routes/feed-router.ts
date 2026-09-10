/**
 * Feed route group (owner-facing).
 *
 * Handles: /feed/*
 *
 * Publish an activity to the user's federated feed with an explicit metric
 * selection, and manage the resulting posts. Consistent with the other
 * owner-facing routers, the acting user comes from `req.user` (not the path);
 * the public read surface lives in `feed-public-router.ts`.
 */
import {
  type ArticleExportResponse,
  type BaseResponse,
  type CreateArticleBody,
  createArticleBodySchema,
  type FeedPostReactionsResponse,
  type FeedPostResponse,
  type FeedPostsQuery,
  feedPostsQuerySchema,
  type FeedPostsResponse,
  type ShareActivityBody,
  shareActivityBodySchema,
  type SharePreviewResponse,
  type ShareChallengeBody,
  shareChallengeBodySchema,
  type TimelineEntryResponse,
  type TimelineQuery,
  timelineQuerySchema,
  type TimelineRepliesResponse,
  type TimelineResponse,
  type UpdateArticleBody,
  updateArticleBodySchema,
  type UpdateFeedPostBody,
  updateFeedPostBodySchema,
} from '@aurboda/api-spec'

import type { Activity, FeedPostRecord } from '../db/index.ts'
import type { ReactionActions, ReactionResult } from '../services/feed-reactions.ts'
import type { TimelineHub } from '../services/timeline-hub.ts'
import type { RetroEnrichTrigger } from '../services/timeline-retro-enrich.ts'

import {
  createArticlePost,
  createChallengePost,
  createFeedPost,
  deleteFeedPost,
  getActivityById,
  getFeedPostById,
  getTimelineEntryById,
  listFeedPostReactions,
  updateFeedPost,
} from '../db/index.ts'
import { isPubliclyVisible } from '../services/activitypub/object.ts'
import { fetchRemoteReplies } from '../services/activitypub/remote-replies.ts'
import { buildArticleMarkdown, renderableArticleBlocks } from '../services/article-export.ts'
import { buildArticleContent, mergeArticleContent } from '../services/article.ts'
import { resolveChallengeShare } from '../services/challenge-share.ts'
import { serializeFeedPostReaction } from '../services/feed-reactions.ts'
import {
  getFeedPage,
  normalizeFeedMessage,
  previewActivityShare,
  serializeFeedPost,
} from '../services/feed.ts'
import { getSettings } from '../services/settings.ts'
import { getTimelinePage } from '../services/timeline.ts'
import { withTimeout } from '../services/with-timeout.ts'
import { type AnyMiddleware, type TypedRouter, typedRouter } from '../typed-router.ts'
import { validateBody, validateQuery } from '../validation.ts'

/**
 * Fire-and-forget federation delivery hooks for the feed-post lifecycle,
 * injected so the router + MCP tools stay decoupled from the ActivityPub layer
 * (and testable without it). Each impl signs + fans the corresponding activity
 * out to the user's followers: `created` → `Create`, `updated` → `Update`,
 * `deleted` → `Delete{Tombstone}`.
 *
 * `created` receives the activity because the share handler already resolved it
 * (for the 404 check), so there's no double fetch. `updated`/`deleted` take only
 * the post: their implementation resolves whatever it needs *inside* the
 * fire-and-forget boundary, so a post-mutation lookup can never turn a
 * successful edit/delete into a 500.
 */
export interface FeedDeliver {
  created: (user: string, post: FeedPostRecord, activity: Activity) => void
  updated: (user: string, post: FeedPostRecord) => void
  deleted: (user: string, post: FeedPostRecord) => void
  /** Fan a freshly-published article out to followers (no linked activity). */
  createdArticle: (user: string, post: FeedPostRecord) => void
  /** Federate an article edit as an `Update` so followers replace the stored object. */
  updatedArticle: (user: string, post: FeedPostRecord) => void
  /** Fan a freshly-shared challenge invitation out to followers (#994). */
  createdChallenge: (user: string, post: FeedPostRecord) => void
  /** Federate a challenge-share edit as an `Update`. */
  updatedChallenge: (user: string, post: FeedPostRecord) => void
}

/** RFC 4122 canonical form — timeline entry ids are UUIDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Total budget for one reply-thread snapshot (object + collection + authors). */
const REPLIES_TIMEOUT_MS = 12_000

/** Newest-first cap on the "who liked / boosted this" list. */
const MAX_POST_REACTIONS = 100

/**
 * Map a reaction toggle's outcome to its HTTP status + body. Pure, so the four
 * toggle routes below stay one-liners that differ only in which action they call.
 */
const reactionResponse = (result: ReactionResult): { status: number; body: TimelineEntryResponse } =>
  result.ok
    ? { body: { entry: result.entry, success: true }, status: 200 }
    : { body: { error: result.error, success: false }, status: result.status }

export const createFeedRouter = (
  authMiddleware: AnyMiddleware,
  deliver?: FeedDeliver,
  hub?: TimelineHub,
  apiBaseUrl?: string,
  retroEnrichTimeline?: RetroEnrichTrigger,
  /** Canonical web origin, to build a shared challenge's public URL (#994). */
  webHost?: string,
  /** Outbound like ⭐ / boost 🔄 toggles; absent → those routes answer 503. */
  reactions?: ReactionActions,
): TypedRouter => {
  const router = typedRouter()

  router.get<Record<string, never>, FeedPostsResponse, unknown, FeedPostsQuery>(
    '/',
    authMiddleware,
    validateQuery(feedPostsQuerySchema),
    async (req, res) => {
      const user = req.user!
      const settings = await getSettings(user).catch(() => null)
      const { next_cursor, posts } = await getFeedPage(user, req.query.limit, req.query.cursor, {
        includeStructured: true,
        settings,
      })
      res.json({ next_cursor, posts, success: true })
    },
  )

  // Live home-timeline updates over Server-Sent Events. Each ping (`event: new`)
  // means "a new post arrived — refetch the newest page"; the payload is empty so
  // no post content crosses the wire. The client falls back to polling if this
  // stream can't be opened or drops. Registered before `/:postId`-style routes.
  router.get<Record<string, never>, BaseResponse>('/timeline/stream', authMiddleware, async (req, res) => {
    const user = req.user!
    if (!hub) return res.status(503).json({ error: 'Live updates unavailable', success: false })

    // `X-Accel-Buffering: no` tells nginx not to buffer the stream (SSE needs
    // each event flushed immediately, not held back for a full response body).
    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    })
    const write = (chunk: string) => {
      if (res.writableEnded) return
      try {
        res.write(chunk)
      } catch {
        /* client vanished mid-write */
      }
    }
    write(': connected\n\n')

    // Comment heartbeats keep the connection from being reaped as idle.
    const heartbeat = setInterval(() => write(': ping\n\n'), 25_000)
    let unsubscribe: (() => Promise<void>) | null = null
    let closed = false
    const cleanup = async () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (unsubscribe) await unsubscribe().catch(() => {})
    }
    req.on('close', () => void cleanup())

    try {
      unsubscribe = await hub.subscribe(user, () => write('event: new\ndata: {}\n\n'))
      // The client may have disconnected while the channel was opening.
      if (closed) await unsubscribe().catch(() => {})
    } catch {
      // Couldn't open the live channel — end the stream so the client polls instead.
      await cleanup()
      if (!res.writableEnded) res.end()
    }
  })

  router.get<Record<string, never>, TimelineResponse, unknown, TimelineQuery>(
    '/timeline',
    authMiddleware,
    validateQuery(timelineQuerySchema),
    async (req, res) => {
      const user = req.user!
      const { entries, next_cursor } = await getTimelinePage(user, req.query.limit, req.query.cursor, {
        origin: webHost,
      })
      retroEnrichTimeline?.(user)
      res.json({ entries, next_cursor, success: true })
    },
  )

  // Live snapshot of a timeline post's remote reply thread (#1060). Nothing is
  // stored; `no-store` because the origin's thread changes under us. Bounded
  // fetch budget inside, plus a hard timeout so a slow origin can't pin the
  // request.
  router.get<{ id: string }, TimelineRepliesResponse>(
    '/timeline/:id/replies',
    authMiddleware,
    async (req, res) => {
      const user = req.user!
      if (!UUID_RE.test(req.params.id)) {
        return res.status(404).json({ error: 'Not found', partial: false, replies: [], success: false })
      }
      const entry = await getTimelineEntryById(user, req.params.id)
      if (entry == null) {
        return res.status(404).json({ error: 'Not found', partial: false, replies: [], success: false })
      }
      const { partial, replies } = await withTimeout(
        fetchRemoteReplies(entry.object_uri),
        REPLIES_TIMEOUT_MS,
      ).catch(() => ({ partial: true, replies: [] }))
      res.setHeader('Cache-Control', 'no-store')
      res.json({ partial, replies, success: true })
    },
  )

  // Like ⭐ / boost 🔄 one home-timeline post, addressed by the entry's LOCAL id
  // (what the card has). All four are idempotent: a repeat POST returns the entry
  // unchanged and delivers nothing, a DELETE of a reaction that isn't there is a
  // no-op. Registered before the generic `/:postId` routes.
  router.post<{ id: string }, TimelineEntryResponse>(
    '/timeline/:id/like',
    authMiddleware,
    async (req, res) => {
      if (!reactions) return res.status(503).json({ error: 'Reactions are not available', success: false })
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found', success: false })
      const { body, status } = reactionResponse(await reactions.like(req.user!, req.params.id))
      res.status(status).json(body)
    },
  )

  router.delete<{ id: string }, TimelineEntryResponse>(
    '/timeline/:id/like',
    authMiddleware,
    async (req, res) => {
      if (!reactions) return res.status(503).json({ error: 'Reactions are not available', success: false })
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found', success: false })
      const { body, status } = reactionResponse(await reactions.unlike(req.user!, req.params.id))
      res.status(status).json(body)
    },
  )

  router.post<{ id: string }, TimelineEntryResponse>(
    '/timeline/:id/boost',
    authMiddleware,
    async (req, res) => {
      if (!reactions) return res.status(503).json({ error: 'Reactions are not available', success: false })
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found', success: false })
      const { body, status } = reactionResponse(await reactions.boost(req.user!, req.params.id))
      res.status(status).json(body)
    },
  )

  router.delete<{ id: string }, TimelineEntryResponse>(
    '/timeline/:id/boost',
    authMiddleware,
    async (req, res) => {
      if (!reactions) return res.status(503).json({ error: 'Reactions are not available', success: false })
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Not found', success: false })
      const { body, status } = reactionResponse(await reactions.unboost(req.user!, req.params.id))
      res.status(status).json(body)
    },
  )

  // Who liked / boosted one of the owner's OWN posts (newest first). Registered
  // before the generic `/:postId` routes so `reactions` is never read as a verb
  // on a post id.
  router.get<{ postId: string }, FeedPostReactionsResponse>(
    '/:postId/reactions',
    authMiddleware,
    async (req, res) => {
      const user = req.user!
      if (!UUID_RE.test(req.params.postId)) {
        return res.status(404).json({ error: 'Feed post not found', reactions: [], success: false })
      }
      if ((await getFeedPostById(user, req.params.postId)) == null) {
        return res.status(404).json({ error: 'Feed post not found', reactions: [], success: false })
      }
      const rows = await listFeedPostReactions(user, req.params.postId, MAX_POST_REACTIONS)
      res.json({ reactions: rows.map(serializeFeedPostReaction), success: true })
    },
  )

  router.post<{ id: string }, FeedPostResponse, ShareActivityBody>(
    '/activities/:id/share',
    authMiddleware,
    validateBody(shareActivityBodySchema),
    async (req, res) => {
      const user = req.user!
      const activity = await getActivityById(user, req.params.id)
      if (!activity) {
        return res.status(404).json({ error: 'Activity not found', success: false })
      }
      const record = await createFeedPost(user, {
        activity_id: activity.id ?? req.params.id,
        include_chart: req.body.include_chart,
        include_map: req.body.include_map,
        included_metrics: req.body.included_metrics,
        message: normalizeFeedMessage(req.body.message) ?? null,
        series_metrics: req.body.series_metrics,
        visibility: req.body.visibility,
      })
      // Fan the post out to followers (best-effort; never blocks the response).
      deliver?.created(user, record, activity)
      res.json({ post: await serializeFeedPost(user, record, { includeStructured: true }), success: true })
    },
  )

  // Live share preview (#902): what would this selection federate? Resolves the
  // exact content/scalars the share would produce, creates nothing.
  router.post<{ id: string }, SharePreviewResponse, ShareActivityBody>(
    '/activities/:id/preview',
    authMiddleware,
    validateBody(shareActivityBodySchema),
    async (req, res) => {
      const user = req.user!
      const activity = await getActivityById(user, req.params.id)
      if (!activity) {
        return res.status(404).json({ error: 'Activity not found', success: false })
      }
      const preview = await previewActivityShare(user, activity, {
        included_metrics: req.body.included_metrics,
        ...(req.body.message === undefined ? {} : { message: req.body.message }),
      })
      res.json({ content: preview.content, metrics: preview.metrics, success: true })
    },
  )

  // Challenge shares (#994): publish an invitation to one of the user's own
  // challenges (`challenge_id`) or a challenge they joined (`participation_id`)
  // — exactly one. The linked name/URL are resolved server-side so a post can
  // never carry a spoofed link. Registered before the generic `/:postId` routes.
  router.post<Record<string, never>, FeedPostResponse, ShareChallengeBody>(
    '/challenges',
    authMiddleware,
    validateBody(shareChallengeBodySchema),
    async (req, res) => {
      const user = req.user!
      const resolved = await resolveChallengeShare(user, req.body, webHost)
      if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error, success: false })
      const record = await createChallengePost(user, {
        challenge: resolved.challenge,
        message: normalizeFeedMessage(req.body.message) ?? null,
        visibility: req.body.visibility,
      })
      deliver?.createdChallenge(user, record)
      res.json({ post: await serializeFeedPost(user, record), success: true })
    },
  )

  // Article posts (long-form: title + prose + inline chart/correlation blocks).
  // Create/edit have their own body shape; delete reuses `DELETE /:postId`.
  // Registered before the generic `/:postId` routes. Federated as a `Note`
  // (fan-out is best-effort and never blocks the response).
  router.post<Record<string, never>, FeedPostResponse, CreateArticleBody>(
    '/articles',
    authMiddleware,
    validateBody(createArticleBodySchema),
    async (req, res) => {
      const user = req.user!
      const built = buildArticleContent({
        blocks: req.body.blocks,
        default_end: req.body.default_end,
        default_start: req.body.default_start,
        title: req.body.title,
      })
      if (!built.ok) return res.status(400).json({ error: built.error, success: false })
      const record = await createArticlePost(user, {
        article: built.article,
        visibility: req.body.visibility,
      })
      deliver?.createdArticle(user, record)
      res.json({ post: await serializeFeedPost(user, record), success: true })
    },
  )

  router.patch<{ postId: string }, FeedPostResponse, UpdateArticleBody>(
    '/articles/:postId',
    authMiddleware,
    validateBody(updateArticleBodySchema),
    async (req, res) => {
      const user = req.user!
      const existing = await getFeedPostById(user, req.params.postId)
      if (!existing || existing.kind !== 'article' || existing.article == null) {
        return res.status(404).json({ error: 'Article not found', success: false })
      }
      const built = buildArticleContent(mergeArticleContent(existing.article, req.body))
      if (!built.ok) return res.status(400).json({ error: built.error, success: false })
      const record = await updateFeedPost(user, req.params.postId, {
        article: built.article,
        visibility: req.body.visibility,
      })
      if (!record) return res.status(404).json({ error: 'Article not found', success: false })
      deliver?.updatedArticle(user, record)
      res.json({ post: await serializeFeedPost(user, record), success: true })
    },
  )

  // Reddit/markdown export (C4): a paste-ready rendering of the article's title
  // + prose + one image link per chart/correlation block (the C1 endpoint).
  // Registered before the generic `/:postId` routes, like the other `/articles`
  // sub-routes.
  router.get<{ postId: string }, ArticleExportResponse>(
    '/articles/:postId/export',
    authMiddleware,
    async (req, res) => {
      const user = req.user!
      const post = await getFeedPostById(user, req.params.postId)
      if (!post || post.kind !== 'article' || post.article == null) {
        return res.status(404).json({ error: 'Article not found', success: false })
      }
      // The export is for pasting to a PUBLIC destination; a followers-only
      // article's chart images require its private capability token, so refuse
      // rather than emit that token into publicly-pasted text.
      if (!isPubliclyVisible(post.visibility)) {
        return res.status(400).json({
          error:
            'A followers-only article can’t be exported — its charts need a private link. Make it public or unlisted first.',
          success: false,
        })
      }
      if (!apiBaseUrl) {
        return res.status(503).json({ error: 'Export is not available', success: false })
      }
      const markdown = buildArticleMarkdown(
        apiBaseUrl,
        user,
        post.id,
        post.visibility,
        post.image_token,
        post.updated_at,
        post.article,
        // Blocks whose image would 404 (no data) get a note, not a dead link (#974).
        await renderableArticleBlocks(user, post.article),
      )
      res.json({ markdown, success: true })
    },
  )

  router.patch<{ postId: string }, FeedPostResponse, UpdateFeedPostBody>(
    '/:postId',
    authMiddleware,
    validateBody(updateFeedPostBodySchema),
    async (req, res) => {
      const user = req.user!
      const record = await updateFeedPost(user, req.params.postId, {
        include_chart: req.body.include_chart,
        include_map: req.body.include_map,
        included_metrics: req.body.included_metrics,
        message: normalizeFeedMessage(req.body.message),
        series_metrics: req.body.series_metrics,
        visibility: req.body.visibility,
      })
      if (!record) {
        return res.status(404).json({ error: 'Feed post not found', success: false })
      }
      // Federate the edit as an Update so followers replace the stored object.
      // Fire-and-forget: the impl resolves what it needs, so it can't 500 here.
      // An article (e.g. a visibility flip via this generic route) has no linked
      // activity, so it must go through the article path — `updated` would no-op.
      if (record.kind === 'article') deliver?.updatedArticle(user, record)
      else if (record.kind === 'challenge') deliver?.updatedChallenge(user, record)
      else deliver?.updated(user, record)
      res.json({ post: await serializeFeedPost(user, record, { includeStructured: true }), success: true })
    },
  )

  router.delete<{ postId: string }, FeedPostResponse>('/:postId', authMiddleware, async (req, res) => {
    const user = req.user!
    // Capture the post before deleting so its Delete can be addressed by the
    // same visibility and reference the right object id.
    const existing = await getFeedPostById(user, req.params.postId)
    const deleted = await deleteFeedPost(user, req.params.postId)
    if (!deleted || !existing) {
      return res.status(404).json({ error: 'Feed post not found', success: false })
    }
    deliver?.deleted(user, existing)
    res.json({ success: true })
  })

  return router
}
