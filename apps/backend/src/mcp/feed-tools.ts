/**
 * MCP feed tools — publish activities to the user's federated feed, manage the
 * resulting posts, and follow/unfollow other actors. Mirrors the REST `/feed`
 * and `/feed/following` capabilities.
 */
import {
  createArticleBodySchema,
  feedPostsQuerySchema,
  shareChallengeBodySchema,
  followActorBodySchema,
  followersQuerySchema,
  replyToPostBodySchema,
  shareActivityBodySchema,
  timelineQuerySchema,
  updateArticleBodySchema,
  updateFeedPostBodySchema,
  updateFollowingBodySchema,
} from '@aurboda/api-spec'
import { z } from 'zod'

import type { FeedDeliver } from '../routes/feed-router.ts'
import type { ReactionActions, ReactionResult, ReplyResult } from '../services/feed-reactions.ts'
import type { FollowerActions } from '../services/followers.ts'
import type { FollowActions } from '../services/following.ts'
import type { RetroEnrichTrigger } from '../services/timeline-retro-enrich.ts'

import {
  createArticlePost,
  createChallengePost,
  createFeedPost,
  deleteFeedPost,
  getActivityById,
  getFeedPostById,
  getTimelineEntryById,
  listFeedFollowers,
  listFeedFollowing,
  listFeedPostReactions,
  updateFeedFollowingNotify,
  updateFeedPost,
} from '../db/index.ts'
import { isPubliclyVisible } from '../services/activitypub/object.ts'
import { REPLIES_TIMEOUT_MS } from '../services/activitypub/remote-replies.ts'
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
import { serializeFollower } from '../services/followers.ts'
import { serializeFollowing } from '../services/following.ts'
import { getSettings } from '../services/settings.ts'
import { getThreadSnapshot, listOwnPostReplies, MAX_POST_REPLIES } from '../services/timeline-replies.ts'
import { getTimelinePage, reactionTarget } from '../services/timeline.ts'
import { withTimeout } from '../services/with-timeout.ts'
import { errorResponse, jsonResponse, type McpServer } from './helpers.ts'

/** Map the `status` filter to the follower-list DB options. */
const followerStatusFilter = (status: 'accepted' | 'all' | 'pending'): { accepted?: boolean } => {
  if (status === 'pending') return { accepted: false }
  if (status === 'accepted') return { accepted: true }
  return {}
}

/** Newest-first cap on the "who liked / boosted this" list (parity with the REST route). */
const MAX_POST_REACTIONS = 100

/** The injectable collaborators behind the feed tools (all optional). */
export interface FeedToolsOptions {
  deliver?: FeedDeliver
  followActions?: FollowActions
  followerActions?: FollowerActions
  /** Outbound like ⭐ / boost 🔄 / reply 🗨 actions; absent → those tools report unavailable. */
  reactionActions?: ReactionActions
  apiBaseUrl?: string
  retroEnrichTimeline?: RetroEnrichTrigger
  /** Canonical web origin, to build a shared challenge's public URL (#994). */
  webHost?: string
}

export const registerFeedTools = (server: McpServer, user: string, options: FeedToolsOptions = {}) => {
  const {
    apiBaseUrl,
    deliver,
    followActions,
    followerActions,
    reactionActions,
    retroEnrichTimeline,
    webHost,
  } = options

  /** Answer a reaction toggle with the updated entry, or the failure as a tool error. */
  const reactionResult = (result: ReactionResult) =>
    result.ok ? jsonResponse(result.entry) : errorResponse(result.error)
  /** Answer a reply with the created post, or the failure as a tool error. */
  const replyResult = (result: ReplyResult) =>
    result.ok ? jsonResponse(result.post) : errorResponse(result.error)
  server.tool(
    'list_feed',
    "List posts you have published to your feed, newest first, with their shared metric selection, series opt-in, and visibility. Pass `cursor` (from a previous call's `next_cursor`) to page.",
    { ...feedPostsQuerySchema.shape },
    async ({ cursor, limit }) => {
      const settings = await getSettings(user).catch(() => null)
      return jsonResponse(await getFeedPage(user, limit, cursor, { origin: webHost, settings }))
    },
  )

  server.tool(
    'share_activity',
    'Publish an activity to your feed. `included_metrics` are the scalar summaries shared; `series_metrics` is a SEPARATE, explicit opt-in that also exposes those metrics on the public read-only series endpoint. Both default to empty (privacy-conservative) — a high-resolution series is far more revealing than an average, so only opt in deliberately.',
    { activity_id: z.string().uuid().describe('The activity to share'), ...shareActivityBodySchema.shape },
    async ({ activity_id, ...body }) => {
      const activity = await getActivityById(user, activity_id)
      if (!activity) return errorResponse('Activity not found')
      const record = await createFeedPost(user, {
        activity_id: activity.id ?? activity_id,
        include_chart: body.include_chart,
        include_map: body.include_map,
        included_metrics: body.included_metrics,
        message: normalizeFeedMessage(body.message) ?? null,
        series_metrics: body.series_metrics,
        visibility: body.visibility,
      })
      // Fan out to followers (best-effort), same as the REST share route.
      deliver?.created(user, record, activity)
      return jsonResponse(await serializeFeedPost(user, record))
    },
  )

  server.tool(
    'preview_activity_share',
    'Preview what sharing an activity WOULD federate — the exact post text (HTML) and resolved metric values for a given selection — without creating a post. Use before share_activity to show the user what leaves the instance.',
    { activity_id: z.string().uuid().describe('The activity to preview'), ...shareActivityBodySchema.shape },
    async ({ activity_id, ...body }) => {
      const activity = await getActivityById(user, activity_id)
      if (!activity) return errorResponse('Activity not found')
      return jsonResponse(
        await previewActivityShare(user, activity, {
          included_metrics: body.included_metrics,
          ...(body.message === undefined ? {} : { message: body.message }),
        }),
      )
    },
  )

  server.tool(
    'update_feed_post',
    'Update a feed post (scalar metric selection, series opt-in, visibility, attachments). Only provided fields change.',
    { id: z.string().uuid().describe('Feed post ID'), ...updateFeedPostBodySchema.shape },
    async ({ id, ...body }) => {
      const record = await updateFeedPost(user, id, {
        include_chart: body.include_chart,
        include_map: body.include_map,
        included_metrics: body.included_metrics,
        message: normalizeFeedMessage(body.message),
        series_metrics: body.series_metrics,
        visibility: body.visibility,
      })
      if (!record) return errorResponse('Feed post not found')
      // Federate the edit as an Update, same as the REST update route. Articles
      // and challenge shares have no linked activity, so they must go through
      // their own paths — the generic `updated` would silently no-op.
      if (record.kind === 'article') deliver?.updatedArticle(user, record)
      else if (record.kind === 'challenge') deliver?.updatedChallenge(user, record)
      else if (record.kind === 'reply') deliver?.updatedReply(user, record)
      else deliver?.updated(user, record)
      return jsonResponse(await serializeFeedPost(user, record))
    },
  )

  server.tool(
    'share_challenge',
    "Publish a challenge INVITATION to your feed: your personal note (markdown) plus the challenge's canonical join-by-URL link. Pass exactly one of `challenge_id` (one of your own challenges) or `participation_id` (a challenge you joined, possibly hosted elsewhere) — the server resolves the linked name/URL itself.",
    { ...shareChallengeBodySchema.shape },
    async ({ challenge_id, message, participation_id, visibility }) => {
      const resolved = await resolveChallengeShare(user, { challenge_id, participation_id }, webHost)
      if (!resolved.ok) return errorResponse(resolved.error)
      const record = await createChallengePost(user, {
        challenge: resolved.challenge,
        message: normalizeFeedMessage(message) ?? null,
        visibility,
      })
      deliver?.createdChallenge(user, record)
      return jsonResponse(await serializeFeedPost(user, record))
    },
  )

  server.tool(
    'create_article',
    'Publish a long-form ARTICLE to your feed: a title, markdown prose, and inline chart blocks over locked time windows. `blocks` is an ordered list of `{type:"prose", markdown}` or `{type:"chart", metric, start?, end?, bucket?, caption?}`. A chart block over `[start, end]` re-resolves live against that window; omit its start/end to inherit `default_start`/`default_end`. Use this (not `share_activity`) for a written analysis spanning multiple charts.',
    { ...createArticleBodySchema.shape },
    async (body) => {
      const built = buildArticleContent({
        blocks: body.blocks,
        default_end: body.default_end,
        default_start: body.default_start,
        title: body.title,
      })
      if (!built.ok) return errorResponse(built.error)
      const record = await createArticlePost(user, { article: built.article, visibility: body.visibility })
      deliver?.createdArticle(user, record)
      return jsonResponse(await serializeFeedPost(user, record))
    },
  )

  server.tool(
    'update_article',
    'Update an ARTICLE post (title, blocks, default window, visibility). Provided fields replace the stored ones; omitted fields are unchanged. The `blocks` array, when given, replaces the whole ordered block list.',
    { id: z.string().uuid().describe('Feed post ID'), ...updateArticleBodySchema.shape },
    async ({ id, ...body }) => {
      const existing = await getFeedPostById(user, id)
      if (!existing || existing.kind !== 'article' || existing.article == null) {
        return errorResponse('Article not found')
      }
      const built = buildArticleContent(mergeArticleContent(existing.article, body))
      if (!built.ok) return errorResponse(built.error)
      const record = await updateFeedPost(user, id, { article: built.article, visibility: body.visibility })
      if (!record) return errorResponse('Article not found')
      deliver?.updatedArticle(user, record)
      return jsonResponse(await serializeFeedPost(user, record))
    },
  )

  server.tool(
    'export_article_markdown',
    'Export a published ARTICLE as paste-ready markdown for a text-only destination (e.g. r/QuantifiedSelf): the title, the prose blocks verbatim, and one image link per chart/correlation block pointing at its rendered PNG. Paste the result and add your own write-up around the linked charts.',
    { id: z.string().uuid().describe('Feed post ID (must be an article)') },
    async ({ id }) => {
      const post = await getFeedPostById(user, id)
      if (!post || post.kind !== 'article' || post.article == null) return errorResponse('Article not found')
      // Export targets a public paste; a followers-only article's images need its
      // private token, so refuse rather than leak it (parity with the REST route).
      if (!isPubliclyVisible(post.visibility)) {
        return errorResponse(
          'A followers-only article can’t be exported — its charts need a private link. Make it public or unlisted first.',
        )
      }
      if (!apiBaseUrl) return errorResponse('Export is not available')
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
      return jsonResponse({ markdown })
    },
  )

  server.tool(
    'delete_feed_post',
    'Delete a feed post of any kind (activity share, article, or challenge) by ID. Unpublishes it and stops its public series from resolving.',
    { id: z.string().uuid().describe('Feed post ID') },
    async ({ id }) => {
      const existing = await getFeedPostById(user, id)
      if (!existing) return errorResponse('Feed post not found')
      await deleteFeedPost(user, id)
      // Retract from followers with a Delete{Tombstone}, same as the REST route.
      deliver?.deleted(user, existing)
      return jsonResponse({ deleted: true, id })
    },
  )

  server.tool(
    'list_following',
    'List the actors you follow (accepted and pending), with their handle, display name, and acceptance state.',
    {},
    async () => {
      const records = await listFeedFollowing(user)
      return jsonResponse(records.map(serializeFollowing))
    },
  )

  server.tool(
    'list_timeline',
    'List your home timeline: posts received from the actors you follow, newest first. Pass `cursor` (from a previous call) to page.',
    { ...timelineQuerySchema.shape },
    async ({ cursor, limit }) => {
      const page = await getTimelinePage(user, limit, cursor, { origin: webHost })
      retroEnrichTimeline?.(user)
      return jsonResponse(page)
    },
  )

  server.tool(
    'get_timeline_replies',
    "Fetch a bounded snapshot of the replies to one home-timeline post (by the entry's local `id`) from its origin server, with YOUR OWN replies to the same post merged in (`mine: true`). `partial: true` means the fetch budget ran out before the thread did; `fetched: false` means the origin's thread could not be read at all — an empty list then means unknown, not empty.",
    { id: z.string().uuid() },
    async ({ id }) => {
      const entry = await getTimelineEntryById(user, id)
      if (entry == null) return errorResponse('Not found')
      if (!webHost) return errorResponse('Replies are not available')
      // A boost card stands for the ORIGINAL Note — the same target a like or a
      // reply resolves.
      const result = await withTimeout(
        getThreadSnapshot(user, webHost, reactionTarget(entry)),
        REPLIES_TIMEOUT_MS,
      ).catch(() => ({ fetched: false, partial: true, replies: [] }))
      return jsonResponse(result)
    },
  )

  server.tool(
    'reply_to_timeline_post',
    "Reply 🗨 to a post in your home timeline, by the entry's local `id` from `list_timeline`. Publishes a reply post (an AS2 `Create{Note}` with `inReplyTo` and a `Mention` of the author) delivered to your followers AND the author's inbox. `visibility` defaults to `unlisted`, the Mastodon convention for replies. Returns the created feed post.",
    {
      id: z.string().uuid().describe('Home-timeline entry id (the `id` from list_timeline)'),
      ...replyToPostBodySchema.shape,
    },
    async ({ id, ...body }) => {
      if (!reactionActions) return errorResponse('Replies are not available')
      return replyResult(await reactionActions.reply(user, id, body))
    },
  )

  server.tool(
    'get_feed_post_replies',
    'List the comments this instance holds under one of YOUR feed posts (by feed post id), oldest first. These are the replies remote actors delivered to you — no network fetch. Each is a full timeline entry, so it carries your like/boost state and can itself be replied to with `reply_to_timeline_post`.',
    { id: z.string().uuid().describe('Feed post ID') },
    async ({ id }) => {
      if (!webHost) return errorResponse('Replies are not available')
      if ((await getFeedPostById(user, id)) == null) return errorResponse('Feed post not found')
      return jsonResponse(await listOwnPostReplies(user, webHost, id, MAX_POST_REPLIES))
    },
  )

  server.tool(
    'like_timeline_post',
    "Favourite (AS2 `Like`) a post in your home timeline, by the entry's local `id` from `list_timeline`. Delivers the Like to the post author. Idempotent — liking twice changes nothing. Returns the updated entry (`liked: true`).",
    { id: z.string().uuid().describe('Home-timeline entry id (the `id` from list_timeline)') },
    async ({ id }) => {
      if (!reactionActions) return errorResponse('Reactions are not available')
      return reactionResult(await reactionActions.like(user, id))
    },
  )

  server.tool(
    'unlike_timeline_post',
    "Remove your favourite from a home-timeline post (delivers an `Undo{Like}`), by the entry's local `id`. Idempotent — unliking something you never liked changes nothing.",
    { id: z.string().uuid().describe('Home-timeline entry id (the `id` from list_timeline)') },
    async ({ id }) => {
      if (!reactionActions) return errorResponse('Reactions are not available')
      return reactionResult(await reactionActions.unlike(user, id))
    },
  )

  server.tool(
    'boost_timeline_post',
    'Boost (AS2 `Announce`, Mastodon "reblog") a post in your home timeline, by the entry\'s local `id` from `list_timeline`. The boost is public and is delivered to your followers AND the post author. Idempotent. Returns the updated entry (`boosted: true`).',
    { id: z.string().uuid().describe('Home-timeline entry id (the `id` from list_timeline)') },
    async ({ id }) => {
      if (!reactionActions) return errorResponse('Reactions are not available')
      return reactionResult(await reactionActions.boost(user, id))
    },
  )

  server.tool(
    'unboost_timeline_post',
    "Retract your boost of a home-timeline post (delivers an `Undo{Announce}`), by the entry's local `id`. Idempotent.",
    { id: z.string().uuid().describe('Home-timeline entry id (the `id` from list_timeline)') },
    async ({ id }) => {
      if (!reactionActions) return errorResponse('Reactions are not available')
      return reactionResult(await reactionActions.unboost(user, id))
    },
  )

  server.tool(
    'list_feed_post_reactions',
    'List who favourited or boosted one of YOUR feed posts (by feed post id), newest first. Remote servers push these as `Like`/`Announce`; a reaction with no resolvable actor still counts.',
    { id: z.string().uuid().describe('Feed post ID') },
    async ({ id }) => {
      if ((await getFeedPostById(user, id)) == null) return errorResponse('Feed post not found')
      const rows = await listFeedPostReactions(user, id, MAX_POST_REACTIONS)
      return jsonResponse(rows.map(serializeFeedPostReaction))
    },
  )

  server.tool(
    'follow_actor',
    'Follow a fediverse actor so their posts arrive in your feed. `handle` is `@user@host`, `user@host`, or an actor URL. Sends a Follow; the follow is `pending` until the remote server accepts it.',
    { ...followActorBodySchema.shape },
    async ({ handle }) => {
      if (!followActions) return errorResponse('Following is not available')
      const result = await followActions.follow(user, handle)
      if (!result.ok) return errorResponse(result.error)
      return jsonResponse(serializeFollowing(result.record))
    },
  )

  server.tool(
    'unfollow_actor',
    'Unfollow an actor by the local follow id (from `list_following`). Sends an Undo{Follow} and removes them from your following list.',
    { id: z.string().uuid().describe('Local follow id (the `id` from list_following)') },
    async ({ id }) => {
      if (!followActions) return errorResponse('Following is not available')
      const removed = await followActions.unfollow(user, id)
      if (!removed) return errorResponse('Not following that actor')
      return jsonResponse({ id, unfollowed: true })
    },
  )

  server.tool(
    'set_following_notify',
    'Enable or disable notifications for new posts from a followed actor (by the local follow id from `list_following`).',
    {
      id: z.string().uuid().describe('Local follow id (the `id` from list_following)'),
      ...updateFollowingBodySchema.shape,
    },
    async ({ id, notify_on_post }) => {
      const record = await updateFeedFollowingNotify(user, id, notify_on_post)
      if (!record) return errorResponse('Not following that actor')
      return jsonResponse(serializeFollowing(record))
    },
  )

  server.tool(
    'list_followers',
    'List the actors that follow you, with their handle, display name, and acceptance state. Pass `status` to see only `pending` follow requests or only `accepted` followers (default `all`). Requests are pending only when you have enabled manual follower approval.',
    { ...followersQuerySchema.shape },
    async ({ status }) => {
      const records = await listFeedFollowers(user, followerStatusFilter(status))
      return jsonResponse(records.map(serializeFollower))
    },
  )

  server.tool(
    'approve_follower',
    'Approve a pending follow request by the local follower id (from `list_followers`). Marks them an accepted follower and sends the Accept.',
    { id: z.string().uuid().describe('Local follower id (the `id` from list_followers)') },
    async ({ id }) => {
      if (!followerActions) return errorResponse('Follower management is not available')
      const follower = await followerActions.approve(user, id)
      if (!follower) return errorResponse('No such follower')
      return jsonResponse(follower)
    },
  )

  server.tool(
    'reject_follower',
    'Reject a pending follow request, or remove an existing follower, by the local follower id (from `list_followers`). Sends a Reject and drops them.',
    { id: z.string().uuid().describe('Local follower id (the `id` from list_followers)') },
    async ({ id }) => {
      if (!followerActions) return errorResponse('Follower management is not available')
      const removed = await followerActions.reject(user, id)
      if (!removed) return errorResponse('No such follower')
      return jsonResponse({ id, rejected: true })
    },
  )
}
