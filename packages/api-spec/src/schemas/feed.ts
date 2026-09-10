/**
 * Federated activity feed schemas.
 *
 * A *feed post* publishes one of a user's activities (exercise, sleep, …) to
 * their public feed, choosing per-post exactly which data leaves the instance:
 *
 * - `included_metrics` — the scalar summaries the user opted to share (e.g.
 *   `duration`, `distance`, `heart_rate_avg`, `hr_zone_minutes`). These are the
 *   single source of truth for the human-readable summary and the machine
 *   scalars a remote Aurboda instance reads.
 * - `series_metrics` — a *separate, explicit* opt-in for high-resolution
 *   continuous series (e.g. per-5s heart rate). A per-sample trace is far more
 *   revealing than an average, so series are off unless deliberately chosen.
 *
 * The `series_metrics` set is the authorization boundary for the public,
 * read-only `GET /public/:username/series` endpoint: that endpoint resolves a
 * metric only when a feed post shared *that series* for an activity whose
 * window covers the requested range. See `PublicSeriesQuery`.
 *
 * ActivityPub delivery (actor, outbox, HTTP signatures) and image rendering are
 * layered on top of this persistence model in follow-up work; these schemas are
 * the storage + public-read foundation.
 */

import { z } from 'zod'

import { challengeResultSchema } from './challenges.ts'
import { baseResponseSchema, iso8601DateTimeSchema, metricTypeSchema } from './common.ts'
import { selectorSchema } from './correlations.ts'
import {
  feedStructuredMetricSchema,
  feedStructuredPostSchema,
  publicSeriesSampleSchema,
} from './feed-structured.ts'
import { shareVisibilityValues } from './visibility.ts'

/**
 * Who a feed post is addressed to.
 *
 * - `public` — listed on the public timeline and deliverable to the wider fediverse.
 * - `unlisted` — reachable but not surfaced on public timelines.
 * - `followers` — only the actor's followers.
 *
 * This is the shared `ShareVisibility` vocabulary (`public`/`unlisted`) plus the
 * feed-only `followers` audience. Only non-`followers` posts back the public
 * `/series` endpoint, since that endpoint has no viewer authentication.
 */
export const feedVisibilitySchema = z
  .enum([...shareVisibilityValues, 'followers'])
  .meta({ description: 'Audience for a feed post', id: 'FeedVisibility' })

export type FeedVisibility = z.infer<typeof feedVisibilitySchema>

/** A scalar-summary metric key (e.g. `duration`, `distance`, `heart_rate_avg`). */
const scalarMetricKeySchema = z.string().min(1).max(64)

/**
 * Max length of a post's personal message. Exported so the share dialog can cap
 * its textarea at the same limit the schemas validate (single source of truth).
 */
export const feedPostMessageMaxLength = 2000

/**
 * Body for sharing an activity to the feed.
 *
 * Defaults are privacy-conservative: nothing is shared unless listed, and
 * high-resolution `series_metrics` default to empty (opt-in only).
 */
export const shareActivityBodySchema = z
  .object({
    include_chart: z
      .boolean()
      .default(false)
      .meta({ description: 'Attach a rendered chart image (drawn only from shared metrics)' }),
    include_map: z
      .boolean()
      .default(false)
      .meta({ description: 'Attach a rendered route-map image (GPS activities only)' }),
    included_metrics: z
      .array(scalarMetricKeySchema)
      .max(64)
      .default([])
      .meta({ description: 'Scalar-summary metric keys to share (the single source of truth for the post)' }),
    message: z.string().max(feedPostMessageMaxLength).optional().meta({
      description:
        'Personal message shown above the shared stats (plain text; linebreaks preserved). Empty/absent shares no text.',
    }),
    series_metrics: z.array(metricTypeSchema).max(64).default([]).meta({
      description:
        'Metrics whose full high-resolution series are explicitly shared. Separate opt-in from the scalar summary; empty by default.',
    }),
    visibility: feedVisibilitySchema.default('public'),
  })
  .meta({ id: 'ShareActivityBody' })

export type ShareActivityBody = z.infer<typeof shareActivityBodySchema>

/** Body for editing a feed post (all fields optional). */
export const updateFeedPostBodySchema = z
  .object({
    include_chart: z.boolean().optional().meta({ description: 'Attach a rendered chart image' }),
    include_map: z.boolean().optional().meta({ description: 'Attach a rendered route-map image' }),
    included_metrics: z
      .array(scalarMetricKeySchema)
      .max(64)
      .optional()
      .meta({ description: 'Replacement set of shared scalar-summary metric keys' }),
    message: z.string().max(feedPostMessageMaxLength).optional().meta({
      description: 'Replacement personal message; an empty string clears it. Omit to keep the current one.',
    }),
    series_metrics: z
      .array(metricTypeSchema)
      .max(64)
      .optional()
      .meta({ description: 'Replacement set of explicitly-shared series metrics' }),
    visibility: feedVisibilitySchema.optional(),
  })
  .meta({ id: 'UpdateFeedPostBody' })

export type UpdateFeedPostBody = z.infer<typeof updateFeedPostBodySchema>

// =============================================================================
// Article posts (long-form: title + markdown prose + inline chart blocks)
// =============================================================================

/**
 * The kind of a feed post. `activity` (the default) shares one of the user's
 * activities; `article` is a long-form post carrying markdown prose and inline
 * chart blocks over locked time windows; `challenge` invites people to a
 * challenge (a personal note plus the challenge's canonical join-by-URL link);
 * `reply` is a Mastodon-style comment on another post (`inReplyTo` + a `Mention`
 * of its author). Modelled as a post *kind* rather than a separate entity so
 * every kind reuses the whole feed (visibility, federation, home timeline, the
 * public-profile feed, permalinks).
 */
export const feedPostKindSchema = z.enum(['activity', 'article', 'challenge', 'reply']).meta({
  description:
    'Feed post kind: an activity share, a long-form article, a challenge invitation, or a reply to another post',
  id: 'FeedPostKind',
})

export type FeedPostKind = z.infer<typeof feedPostKindSchema>

// =============================================================================
// Reply posts (comment on another post — AS2 `Create{Note inReplyTo}`)
// =============================================================================

/**
 * Body for replying to a post in the home timeline. The reply target (the
 * object id, its author's actor URI and `@user@host` handle) is resolved
 * server-side from the addressed timeline entry, never client-supplied, so a
 * reply can never claim to answer a post it doesn't.
 *
 * `visibility` defaults to `unlisted`, matching Mastodon's convention that a
 * reply belongs to its thread rather than on public timelines; the author can
 * still choose `public` or `followers`.
 */
export const replyToPostBodySchema = z
  .object({
    message: z
      .string()
      .min(1)
      .max(feedPostMessageMaxLength)
      .refine((text) => text.trim().length > 0, { message: 'Reply text cannot be blank' })
      .meta({
        description:
          'The reply text (markdown, rendered through the shared sanitiser). Must be non-blank after trimming.',
      }),
    visibility: feedVisibilitySchema.default('unlisted'),
  })
  .meta({ id: 'ReplyToPostBody' })

export type ReplyToPostBody = z.infer<typeof replyToPostBodySchema>

// =============================================================================
// Challenge posts (share a challenge to the feed — #994)
// =============================================================================

/**
 * The stored payload of a `challenge` post: what the post links to. A snapshot
 * of the challenge's name plus its canonical public URL — the same join-by-URL
 * target the challenge page shares — resolved server-side at share time (from
 * the owner's own challenge, or from a joined remote challenge's
 * participation), never client-supplied. Deliberately carries no join token or
 * standings data; anyone following the link goes through the normal public
 * page / join flow.
 */
export const challengeShareSchema = z
  .object({
    host_identity: z.string().max(200).optional().meta({
      description:
        "The hosting instance's identity (e.g. `@user@host`) when sharing a joined remote challenge",
    }),
    name: z.string().min(1).max(200).meta({ description: 'Challenge name at share time' }),
    result: challengeResultSchema.optional().meta({
      description:
        'Final standings, present only on the completion post the host instance publishes when the challenge ends',
    }),
    url: z
      .string()
      .url()
      .max(500)
      .meta({ description: "The challenge's canonical public page URL (the join-by-URL target)" }),
  })
  .meta({ id: 'ChallengeShare' })

export type ChallengeShare = z.infer<typeof challengeShareSchema>

/**
 * Body for sharing a challenge to the feed. Exactly ONE of `challenge_id` (one
 * of the user's own challenges) or `participation_id` (a challenge they joined,
 * possibly hosted elsewhere) — the server resolves the linked name/URL itself,
 * so a post can never carry a spoofed link.
 */
export const shareChallengeBodySchema = z
  .object({
    challenge_id: z
      .string()
      .uuid()
      .optional()
      .meta({ description: 'One of your own challenges to share (exclusive with `participation_id`)' }),
    message: z.string().max(feedPostMessageMaxLength).optional().meta({
      description:
        'Personal note shown above the link (markdown, rendered through the shared sanitiser). Empty/absent shares no text.',
    }),
    participation_id: z
      .string()
      .uuid()
      .optional()
      .meta({ description: 'A challenge you joined to share (exclusive with `challenge_id`)' }),
    visibility: feedVisibilitySchema.default('public'),
  })
  .meta({ id: 'ShareChallengeBody' })

export type ShareChallengeBody = z.infer<typeof shareChallengeBodySchema>

/** A prose block: a run of markdown, rendered through the shared sanitiser (#910). */
export const articleProseBlockSchema = z
  .object({
    markdown: z
      .string()
      .max(20_000)
      .meta({ description: 'Markdown prose (rendered to sanitised HTML at the sink)' }),
    type: z.literal('prose'),
  })
  .meta({ description: 'A markdown prose block', id: 'ArticleProseBlock' })

/**
 * A chart block: one shared metric drawn over a locked `[start, end]` window.
 * The window is what makes the chart stable and citable — data is re-resolved
 * live against it, never snapshotted. When `start`/`end` are omitted the block
 * inherits the article's default window.
 */
export const articleChartBlockSchema = z
  .object({
    bucket: z
      .string()
      .regex(/^\d+[smhd]$/, 'Must be {number}{unit} where unit is s, m, h, or d')
      .optional()
      .meta({
        description: 'Bucket granularity (e.g. `5s`, `1h`, `1d`); the server picks a default if omitted',
      }),
    caption: z.string().max(280).optional().meta({ description: 'Optional caption shown under the chart' }),
    end: iso8601DateTimeSchema
      .optional()
      .meta({ description: "Window end (ISO 8601); inherits the article's default window if omitted" }),
    metric: metricTypeSchema.meta({ description: 'The metric to chart' }),
    start: iso8601DateTimeSchema
      .optional()
      .meta({ description: "Window start (ISO 8601); inherits the article's default window if omitted" }),
    type: z.literal('chart'),
  })
  .meta({ description: 'A metric chart over a locked window', id: 'ArticleChartBlock' })

/**
 * Pick a bucket granularity for an article chart block from its window span when
 * the block doesn't fix one (`bucket` omitted). Shared single source used by both
 * the web inline render and the backend server-side chart PNG, so a chart buckets
 * the same in-app and in a federated/exported image: hourly for a window up to
 * two days, otherwise daily.
 */
export const defaultArticleChartBucket = (start: Date, end: Date): string =>
  end.getTime() - start.getTime() <= 2 * 86_400_000 ? '1h' : '1d'

/**
 * A correlation block: a scatter of two data dimensions (a `trigger` predictor
 * against an `outcome`) over a locked `[start, end]` window, reusing the
 * exploratory correlation engine's selectors. Like a chart block, the window is
 * re-resolved live (never snapshotted) and inherits the article's default window
 * when `start`/`end` are omitted. `lag_days` shifts the outcome forward relative
 * to the trigger (e.g. does today's training load predict tomorrow's HRV).
 */
export const articleCorrelationBlockSchema = z
  .object({
    caption: z.string().max(280).optional().meta({ description: 'Optional caption shown under the scatter' }),
    end: iso8601DateTimeSchema
      .optional()
      .meta({ description: "Window end (ISO 8601); inherits the article's default window if omitted" }),
    lag_days: z
      .number()
      .int()
      .optional()
      .meta({ description: 'Days the outcome lags the trigger (default: 0)' }),
    outcome: selectorSchema.meta({ description: 'Outcome dimension' }),
    start: iso8601DateTimeSchema
      .optional()
      .meta({ description: "Window start (ISO 8601); inherits the article's default window if omitted" }),
    trigger: selectorSchema.meta({ description: 'Trigger / predictor dimension' }),
    type: z.literal('correlation'),
  })
  .meta({ description: 'A correlation scatter over a locked window', id: 'ArticleCorrelationBlock' })

/** An ordered content block of an article. */
export const articleBlockSchema = z
  .discriminatedUnion('type', [
    articleProseBlockSchema,
    articleChartBlockSchema,
    articleCorrelationBlockSchema,
  ])
  .meta({ description: 'An article content block (prose, chart, or correlation)', id: 'ArticleBlock' })

export type ArticleBlock = z.infer<typeof articleBlockSchema>

/**
 * The stored content of an article post: a title, an optional article-level
 * default window that chart and correlation blocks inherit, and the ordered blocks.
 */
export const articleContentSchema = z
  .object({
    blocks: z.array(articleBlockSchema).max(100).meta({ description: 'Ordered content blocks' }),
    default_end: iso8601DateTimeSchema
      .optional()
      .meta({ description: 'Default window end inherited by chart and correlation blocks (ISO 8601)' }),
    default_start: iso8601DateTimeSchema
      .optional()
      .meta({ description: 'Default window start inherited by chart and correlation blocks (ISO 8601)' }),
    title: z.string().min(1).max(200).meta({ description: 'Article title' }),
  })
  .meta({ id: 'ArticleContent' })

export type ArticleContent = z.infer<typeof articleContentSchema>

/** A feed post as seen by its owner. */
export const feedPostSchema = z
  .object({
    activity_id: z
      .string()
      .uuid()
      .nullable()
      .meta({ description: 'The shared activity, or null for a non-activity post' }),
    // Resolved from the shared activity at query time (not stored on the post, so
    // a rename stays consistent). The window is the *merged* span — the same one
    // the detail view and share dialog present — so a client can show the title
    // and edit the metric selection without a second per-post activity fetch.
    // Absent when there is no activity, or it was deleted.
    activity_end_time: z
      .string()
      .optional()
      .meta({ description: "The shared activity's merged-span end (ISO 8601)" }),
    activity_start_time: z
      .string()
      .optional()
      .meta({ description: "The shared activity's merged-span start (ISO 8601)" }),
    activity_title: z
      .string()
      .optional()
      .meta({ description: "The shared activity's title, resolved at query time" }),
    activity_type: z
      .string()
      .optional()
      .meta({ description: "The shared activity's type (e.g. `exercise`)" }),
    // Present only for `article` posts (the stored title + default window +
    // ordered blocks); absent for `activity` posts.
    article: articleContentSchema
      .optional()
      .meta({ description: 'Article content, present only for `article` posts' }),
    autoshare_rule_id: z.string().uuid().optional().meta({
      description: 'The auto-share rule that created this post (#903), absent for manual posts',
    }),
    // Attached by the feed LISTING only (one batched count query per page);
    // single-post responses (share / update) leave both absent.
    boost_count: z.number().int().optional().meta({
      description: 'How many remote actors boosted (`Announce`d) this post; absent on single-post responses',
    }),
    challenge: challengeShareSchema
      .optional()
      .meta({ description: 'Challenge link payload, present only for `challenge` posts' }),
    // The exact HTML `content` that federates for this post (headline + shared
    // scalar summary), so a client can render the post WYSIWYG — matching what
    // Mastodon shows — instead of reconstructing it from the metric keys. Absent
    // when there is no resolvable activity.
    content: z
      .string()
      .optional()
      .meta({ description: 'Rendered AS2 `content` HTML for the post (as federated)' }),
    created_at: z.string().meta({ description: 'Creation timestamp (ISO 8601)' }),
    id: z.string().uuid().meta({ description: 'Feed post ID' }),
    include_chart: z.boolean().meta({ description: 'Whether a chart image is attached' }),
    include_map: z.boolean().meta({ description: 'Whether a route-map image is attached' }),
    included_metrics: z.array(z.string()).meta({ description: 'Shared scalar-summary metric keys' }),
    // Present only for `reply` posts: what this post answers. The handle is a
    // snapshot taken at reply time (it names the federated `Mention`), the same
    // rule `TimelineEntry.handle` follows.
    in_reply_to_actor_uri: z.string().optional().meta({
      description: "The replied-to post author's actor URI, present only for `reply` posts",
    }),
    in_reply_to_handle: z.string().optional().meta({
      description: "The replied-to post author's `@user@host` handle at reply time (`reply` posts)",
    }),
    in_reply_to_uri: z
      .string()
      .optional()
      .meta({ description: 'The replied-to object id, present only for `reply` posts' }),
    kind: feedPostKindSchema.meta({
      description: 'Post kind: `activity`, `article`, `challenge` or `reply`',
    }),
    like_count: z.number().int().optional().meta({
      description: 'How many remote actors favourited (`Like`d) this post; absent on single-post responses',
    }),
    message: z
      .string()
      .optional()
      .meta({ description: 'Personal message shared with the post (plain text), if any' }),
    // The resolved scalar values behind `included_metrics`, typed — the same
    // shapes the structured-enrichment payload carries — so the web can render a
    // native stat grid instead of parsing the flattened `content` HTML. Resolved
    // at query time like `content`; absent when there is no resolvable activity.
    metrics: z
      .array(feedStructuredMetricSchema)
      .optional()
      .meta({ description: 'Resolved typed scalar values for the shared metrics (activity posts)' }),
    // Attached by the feed LISTING only, like the reaction counts above.
    reply_count: z.number().int().optional().meta({
      description:
        'How many replies (comments) this instance holds for this post; absent on single-post responses',
    }),
    series_metrics: z.array(z.string()).meta({ description: 'Explicitly-shared series metrics' }),
    structured: feedStructuredPostSchema.optional().meta({
      description:
        "The post's native structured payload (typed metrics + inline series), identical to what a subscribing peer receives — drives the owner's native card render",
    }),
    updated_at: z.string().meta({ description: 'Last update timestamp (ISO 8601)' }),
    visibility: feedVisibilitySchema,
  })
  .meta({ id: 'FeedPost' })

export type FeedPost = z.infer<typeof feedPostSchema>

/** Response wrapping a single feed post. */
export const feedPostResponseSchema = baseResponseSchema
  .extend({ post: feedPostSchema.optional() })
  .meta({ id: 'FeedPostResponse' })

export type FeedPostResponse = z.infer<typeof feedPostResponseSchema>

/** Query for the owner's feed listing (keyset pagination, like the home timeline). */
export const feedPostsQuerySchema = z
  .object({
    cursor: z.string().optional().meta({ description: "Opaque cursor from a previous page's `next_cursor`" }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .meta({ description: 'Max posts to return (1–50, default 20)' }),
  })
  .meta({ id: 'FeedPostsQuery' })

export type FeedPostsQuery = z.infer<typeof feedPostsQuerySchema>

/**
 * Response wrapping a list of feed posts. The owner's `GET /feed` pages with
 * `next_cursor` (null on the last page); the bounded public-profile listing
 * omits it.
 */
export const feedPostsResponseSchema = baseResponseSchema
  .extend({
    next_cursor: z
      .string()
      .nullable()
      .optional()
      .meta({ description: 'Cursor for the next page; null on the last page; absent when unpaginated' }),
    posts: z.array(feedPostSchema),
  })
  .meta({ id: 'FeedPostsResponse' })

export type FeedPostsResponse = z.infer<typeof feedPostsResponseSchema>

/**
 * Response for the share PREVIEW (#902): the exact federated `content` HTML a
 * Mastodon follower would see and the typed scalars behind the native stat
 * grid, resolved for a given share selection WITHOUT creating a post — so the
 * dialog shows precisely what would leave the instance.
 */
export const sharePreviewResponseSchema = baseResponseSchema
  .extend({
    content: z
      .string()
      .optional()
      .meta({ description: 'The AS2 `content` HTML the post would federate with' }),
    metrics: z
      .array(feedStructuredMetricSchema)
      .optional()
      .meta({ description: 'The resolved typed scalar values for the selection' }),
  })
  .meta({ id: 'SharePreviewResponse' })

export type SharePreviewResponse = z.infer<typeof sharePreviewResponseSchema>

/**
 * Body for creating an article post. No activity anchor and no shared
 * metrics/series — an article carries its own title, default window, and blocks.
 */
export const createArticleBodySchema = z
  .object({
    blocks: z
      .array(articleBlockSchema)
      .max(100)
      .default([])
      .meta({ description: 'Ordered content blocks (prose, charts, correlations)' }),
    default_end: iso8601DateTimeSchema
      .optional()
      .meta({ description: 'Default window end inherited by chart and correlation blocks (ISO 8601)' }),
    default_start: iso8601DateTimeSchema
      .optional()
      .meta({ description: 'Default window start inherited by chart and correlation blocks (ISO 8601)' }),
    title: z.string().min(1).max(200).meta({ description: 'Article title' }),
    visibility: feedVisibilitySchema.default('public'),
  })
  .meta({ id: 'CreateArticleBody' })

export type CreateArticleBody = z.infer<typeof createArticleBodySchema>

/** Body for editing an article post (all fields optional; a given field replaces the stored one). */
export const updateArticleBodySchema = z
  .object({
    blocks: z
      .array(articleBlockSchema)
      .max(100)
      .optional()
      .meta({ description: 'Replacement ordered content blocks' }),
    default_end: iso8601DateTimeSchema.optional().meta({ description: 'Default window end (ISO 8601)' }),
    default_start: iso8601DateTimeSchema.optional().meta({ description: 'Default window start (ISO 8601)' }),
    title: z.string().min(1).max(200).optional().meta({ description: 'Article title' }),
    visibility: feedVisibilitySchema.optional(),
  })
  .meta({ id: 'UpdateArticleBody' })

export type UpdateArticleBody = z.infer<typeof updateArticleBodySchema>

// =============================================================================
// Following (the actors this user follows — inbound feed direction)
// =============================================================================

/** Body for following an actor. */
export const followActorBodySchema = z
  .object({
    handle: z.string().trim().min(1).max(512).meta({
      description: 'The actor to follow: a fediverse handle (`@user@host` or `user@host`) or an actor URL',
      example: '@alice@mastodon.social',
    }),
  })
  .meta({ id: 'FollowActorBody' })

export type FollowActorBody = z.infer<typeof followActorBodySchema>

/**
 * An actor this user follows. Internal delivery details (the followee's inbox /
 * shared-inbox URIs) are deliberately NOT exposed — only presentation fields and
 * the acceptance state. `accepted` is false while a sent Follow awaits the
 * followee's `Accept`.
 */
export const followingActorSchema = z
  .object({
    accepted: z
      .boolean()
      .meta({ description: 'Whether the followee has accepted the follow (else pending)' }),
    actor_uri: z.string().meta({ description: "The followee's ActivityPub actor URI" }),
    avatar_url: z.string().nullable().meta({ description: "The followee's avatar URL, if known" }),
    created_at: iso8601DateTimeSchema.meta({ description: 'When the follow was initiated (ISO 8601)' }),
    display_name: z.string().nullable().meta({ description: "The followee's display name, if known" }),
    handle: z.string().nullable().meta({ description: "The followee's `@user@host` handle, if resolvable" }),
    id: z.string().uuid().meta({ description: 'Local id of the follow (used to unfollow)' }),
    notify_on_post: z.boolean().meta({
      description: "Whether to notify on this actor's new posts (used by the app for push notifications)",
    }),
  })
  .meta({ id: 'FollowingActor' })

export type FollowingActor = z.infer<typeof followingActorSchema>

/** Body for updating a follow's per-actor settings (currently the notify toggle). */
export const updateFollowingBodySchema = z
  .object({
    notify_on_post: z.boolean().meta({
      description: "Whether to notify on this actor's new posts",
    }),
  })
  .meta({ id: 'UpdateFollowingBody' })

export type UpdateFollowingBody = z.infer<typeof updateFollowingBodySchema>

/** Response wrapping a single follow (e.g. the result of following an actor). */
export const followActorResponseSchema = baseResponseSchema
  .extend({ actor: followingActorSchema.optional() })
  .meta({ id: 'FollowActorResponse' })

export type FollowActorResponse = z.infer<typeof followActorResponseSchema>

/** Response wrapping the owner's list of followed actors. */
export const followingResponseSchema = baseResponseSchema
  .extend({ following: z.array(followingActorSchema) })
  .meta({ id: 'FollowingResponse' })

export type FollowingResponse = z.infer<typeof followingResponseSchema>

// =============================================================================
// Followers (remote actors that follow this user — owner-facing management)
// =============================================================================

/** Acceptance state of a follower, and the filter used when listing them. */
export const followerStatusValues = ['pending', 'accepted', 'all'] as const

export const followerStatusSchema = z.enum(followerStatusValues).meta({
  description:
    'Follower acceptance filter: `pending` (awaiting your approval), `accepted` (approved), or `all`.',
  id: 'FollowerStatus',
})

export type FollowerStatus = z.infer<typeof followerStatusSchema>

/** Query for listing followers, optionally filtered by acceptance state. */
export const followersQuerySchema = z
  .object({
    status: followerStatusSchema.default('all').meta({
      description: 'Which followers to return (defaults to `all`).',
    }),
  })
  .meta({ id: 'FollowersQuery' })

export type FollowersQuery = z.infer<typeof followersQuerySchema>

/**
 * A remote actor that follows this user. Internal delivery details (the
 * follower's inbox / shared-inbox URIs) are deliberately NOT exposed — only
 * presentation fields and the acceptance state. `accepted` is false while their
 * Follow awaits the owner's approval (manual-approval mode).
 */
export const followerActorSchema = z
  .object({
    accepted: z
      .boolean()
      .meta({ description: 'Whether you have approved this follower (else a pending request)' }),
    actor_uri: z.string().meta({ description: "The follower's ActivityPub actor URI" }),
    avatar_url: z.string().nullable().meta({ description: "The follower's avatar URL, if known" }),
    created_at: iso8601DateTimeSchema.meta({ description: 'When the Follow arrived (ISO 8601)' }),
    display_name: z.string().nullable().meta({ description: "The follower's display name, if known" }),
    handle: z.string().nullable().meta({ description: "The follower's `@user@host` handle, if resolvable" }),
    id: z.string().uuid().meta({ description: 'Local id of the follower (used to approve/reject)' }),
  })
  .meta({ id: 'FollowerActor' })

export type FollowerActor = z.infer<typeof followerActorSchema>

/** Response wrapping the owner's list of followers (pending and/or accepted). */
export const followersResponseSchema = baseResponseSchema
  .extend({ followers: z.array(followerActorSchema) })
  .meta({ id: 'FollowersResponse' })

export type FollowersResponse = z.infer<typeof followersResponseSchema>

/** Response wrapping a single follower (e.g. the result of approving a request). */
export const followerResponseSchema = baseResponseSchema
  .extend({ follower: followerActorSchema.optional() })
  .meta({ id: 'FollowerResponse' })

export type FollowerResponse = z.infer<typeof followerResponseSchema>

// =============================================================================
// Home timeline (posts received from followed actors)
// =============================================================================

/**
 * An image attached to a received post (e.g. a rendered chart or route map, or a
 * Mastodon photo). Captured from the delivered Note's `attachment`s so the home
 * timeline can show it — the fallback when a post carries no native structured
 * chart. The `url` is served by the author's origin instance (a `followers`-only
 * post's URL carries its capability token).
 */
export const timelineImageSchema = z
  .object({
    height: z.number().int().optional().meta({ description: 'Intrinsic height in px, if known' }),
    media_type: z.string().optional().meta({ description: 'MIME type, e.g. `image/png`' }),
    name: z.string().optional().meta({ description: 'Alt text / caption, if any' }),
    url: z.string().meta({ description: 'Image URL (served by the author’s origin instance)' }),
    width: z.number().int().optional().meta({ description: 'Intrinsic width in px, if known' }),
  })
  .meta({ id: 'TimelineImage' })

export type TimelineImage = z.infer<typeof timelineImageSchema>

/**
 * The followee who boosted (AS2 `Announce`d) a post into the reader's timeline —
 * present only on a **boost card**, whose author fields describe the ORIGINAL
 * post. Mastodon shows the same "X boosted" line above the original card.
 */
export const timelineBoostedBySchema = z
  .object({
    actor_uri: z.string().meta({ description: "The booster's ActivityPub actor URI" }),
    display_name: z.string().nullable().meta({ description: "The booster's display name, if known" }),
    handle: z.string().nullable().meta({ description: "The booster's `@user@host` handle, if known" }),
  })
  .meta({ id: 'TimelineBoostedBy' })

export type TimelineBoostedBy = z.infer<typeof timelineBoostedBySchema>

/** A post received from a followed actor, as shown in the home timeline. */
export const timelineEntrySchema = z
  .object({
    actor_uri: z.string().meta({ description: "The author's ActivityPub actor URI" }),
    avatar_url: z.string().nullable().meta({ description: "The author's avatar URL, if known" }),
    boost_of_uri: z.string().optional().meta({
      description:
        'On a boost card, the id of the ORIGINAL Note that was boosted (this entry’s `object_uri` is the `Announce` activity id). Absent on a direct entry.',
    }),
    boosted: z.boolean().optional().meta({
      description: 'Present (and true) when YOU have boosted this post (an `Announce` you sent)',
    }),
    boosted_by: timelineBoostedBySchema.optional().meta({
      description: 'On a boost card, the followee who boosted the original post',
    }),
    content: z
      .string()
      .meta({ description: 'The post HTML (already sanitised server-side; safe to render)' }),
    display_name: z.string().nullable().meta({ description: "The author's display name, if known" }),
    handle: z.string().nullable().meta({ description: "The author's `@user@host` handle, if known" }),
    id: z.string().uuid().meta({ description: 'Local id of the timeline entry' }),
    liked: z.boolean().optional().meta({
      description: 'Present (and true) when YOU have favourited this post (a `Like` you sent)',
    }),
    in_reply_to_mine: z.boolean().optional().meta({
      description:
        'True when this is a reply to one of YOUR posts (present only on replies) — such replies always show and notify regardless of the `timeline_show_replies` setting',
    }),
    in_reply_to_uri: z.string().nullable().optional().meta({
      description: 'The `inReplyTo` object id when this post is a reply, else absent/null',
    }),
    mentions_me: z.boolean().optional().meta({
      description:
        'True when the post carries a Mention of you — such posts always show and notify regardless of the `timeline_show_replies` setting',
    }),
    images: z.array(timelineImageSchema).optional().meta({
      description:
        'Image attachments (e.g. a rendered chart or route map), shown when the post carries no native structured chart.',
    }),
    object_uri: z.string().meta({ description: "The remote post's canonical id" }),
    published_at: iso8601DateTimeSchema.meta({ description: 'When the post was published (ISO 8601)' }),
    received_at: iso8601DateTimeSchema.meta({
      description:
        'When this instance received the post (ISO 8601). Monotonic per timeline — the correct high-water mark for "what have I already seen", since `published_at` can arrive out of order after federation retries.',
    }),
    structured: feedStructuredPostSchema.optional().meta({
      description:
        'Native structured data (an activity share’s typed metrics/series, or an article’s title + resolved blocks), present only for posts from Aurboda instances — drives a native render instead of the HTML.',
    }),
    url: z.string().nullable().meta({ description: 'Link to the original post' }),
  })
  .meta({ id: 'TimelineEntry' })

export type TimelineEntry = z.infer<typeof timelineEntrySchema>

/**
 * Response wrapping a single home-timeline entry — what a like/boost toggle
 * returns, so the client can replace its optimistic patch with the server's
 * authoritative row.
 */
export const timelineEntryResponseSchema = baseResponseSchema
  .extend({ entry: timelineEntrySchema.optional() })
  .meta({ id: 'TimelineEntryResponse' })

export type TimelineEntryResponse = z.infer<typeof timelineEntryResponseSchema>

/** Query for the home-timeline endpoint (keyset pagination). */
export const timelineQuerySchema = z
  .object({
    cursor: z.string().optional().meta({ description: "Opaque cursor from a previous page's `next_cursor`" }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .meta({ description: 'Max entries to return (1–50, default 20)' }),
  })
  .meta({ id: 'TimelineQuery' })

export type TimelineQuery = z.infer<typeof timelineQuerySchema>

/**
 * One reply in a post's thread snapshot: fetched live from the origin's
 * `replies` collection, or one of the reader's OWN replies merged in (`mine`)
 * — the origin may not list ours yet, and a thread that hides its own author's
 * reply reads as if it were never sent.
 */
export const timelineReplySchema = z
  .object({
    actor_uri: z.string().nullable().meta({ description: "The reply author's actor URI, if declared" }),
    content: z.string().meta({ description: 'The reply HTML (sanitised server-side; safe to render)' }),
    display_name: z.string().nullable().meta({ description: "The author's display name, if resolved" }),
    handle: z.string().nullable().meta({ description: "The author's `@user@host` handle, if resolved" }),
    mine: z.boolean().optional().meta({
      description: 'Present (and true) when this reply is one YOU published from this instance',
    }),
    object_uri: z
      .string()
      .nullable()
      .meta({ description: "The reply's canonical AS2 object id, when it declares one" }),
    published_at: iso8601DateTimeSchema.nullable().meta({ description: 'When the reply was published' }),
    url: z.string().nullable().meta({ description: 'Link to the reply on its origin' }),
  })
  .meta({ id: 'TimelineReply' })

export type TimelineReply = z.infer<typeof timelineReplySchema>

/** Replies fetched live from the remote post behind one timeline entry. */
export const timelineRepliesResponseSchema = baseResponseSchema
  .extend({
    fetched: z.boolean().meta({
      description:
        "False when the origin's thread could not be read at all (the post or its first page never loaded) — an empty list then means 'unknown', not 'no replies'",
    }),
    partial: z.boolean().meta({
      description:
        'True when the fetch hit its budget (count/time) before exhausting the collection — more replies may exist on the origin',
    }),
    replies: z.array(timelineReplySchema).meta({ description: 'The fetched replies, oldest first' }),
  })
  .meta({ id: 'TimelineRepliesResponse' })

export type TimelineRepliesResponse = z.infer<typeof timelineRepliesResponseSchema>

/** A page of the home timeline, newest first, with an opaque cursor for the next page. */
export const timelineResponseSchema = baseResponseSchema
  .extend({
    entries: z.array(timelineEntrySchema),
    next_cursor: z
      .string()
      .nullable()
      .meta({ description: 'Cursor for the next page, or null if this is the last page' }),
  })
  .meta({ id: 'TimelineResponse' })

export type TimelineResponse = z.infer<typeof timelineResponseSchema>

/**
 * The comments under one of the owner's OWN posts: the replies this instance
 * already holds as timeline entries (ingested from any actor whose Note replied
 * to that post — #1060), oldest first. No network: the origin of each reply is
 * whoever delivered it. They are full `TimelineEntry`s, so each carries the
 * reader's like/boost state and can itself be replied to.
 */
export const feedPostRepliesResponseSchema = baseResponseSchema
  .extend({
    replies: z
      .array(timelineEntrySchema)
      .meta({ description: 'Replies received for this post, oldest first' }),
  })
  .meta({ id: 'FeedPostRepliesResponse' })

export type FeedPostRepliesResponse = z.infer<typeof feedPostRepliesResponseSchema>

// =============================================================================
// Reactions on the owner's own posts (inbound Like / Announce)
// =============================================================================

/** Whether a reaction is a favourite (AS2 `Like`) or a boost (AS2 `Announce`). */
export const feedReactionKindSchema = z.enum(['like', 'announce']).meta({
  description: 'Reaction kind: `like` (AS2 `Like` — a favourite) or `announce` (AS2 `Announce` — a boost)',
  id: 'FeedReactionKind',
})

export type FeedReactionKind = z.infer<typeof feedReactionKindSchema>

/**
 * One remote actor's reaction to one of the owner's own feed posts, recorded
 * from an inbound `Like`/`Announce`. The presentation fields are a best-effort
 * snapshot taken when the reaction arrived (a remote server need not be
 * reachable later).
 */
export const feedPostReactionSchema = z
  .object({
    actor_uri: z.string().meta({ description: "The reacting actor's ActivityPub actor URI" }),
    avatar_url: z.string().nullable().meta({ description: "The actor's avatar URL, if known" }),
    created_at: iso8601DateTimeSchema.meta({ description: 'When the reaction was received (ISO 8601)' }),
    display_name: z.string().nullable().meta({ description: "The actor's display name, if known" }),
    handle: z.string().nullable().meta({ description: "The actor's `@user@host` handle, if known" }),
    kind: feedReactionKindSchema,
  })
  .meta({ id: 'FeedPostReaction' })

export type FeedPostReaction = z.infer<typeof feedPostReactionSchema>

/** Who liked / boosted one of the owner's posts, newest first. */
export const feedPostReactionsResponseSchema = baseResponseSchema
  .extend({ reactions: z.array(feedPostReactionSchema) })
  .meta({ id: 'FeedPostReactionsResponse' })

export type FeedPostReactionsResponse = z.infer<typeof feedPostReactionsResponseSchema>

// =============================================================================
// Public series endpoint (unauthenticated, data-scoped)
// =============================================================================

/**
 * Bucket size for a public series request. Restricted to sub-day units
 * (`s`/`m`/`h`) because a series window is a single activity; server floors the
 * granularity to a minimum (see `PublicSeriesQuery`).
 */
export const seriesBucketSchema = z
  .string()
  .regex(/^\d+[smh]$/, 'Must be {number}{unit} where unit is s, m, or h')
  .meta({
    description: 'Bucket size: {number}{unit} where unit is s (seconds), m (minutes), or h (hours)',
    example: '5s',
    id: 'SeriesBucket',
  })

/**
 * Query for the public, read-only bucketed series endpoint.
 *
 * Resolves ONLY when a feed post shared `metric` as a series for an activity
 * whose window covers `[start, end]`. The effective range is clamped to that
 * activity's window and the bucket granularity is floored server-side. Requests
 * for an unshared metric, or a window not covered by any shared activity, 404.
 */
export const publicSeriesQuerySchema = z
  .object({
    bucket: seriesBucketSchema,
    end: iso8601DateTimeSchema.meta({ description: 'End of the requested window (ISO 8601)' }),
    metric: metricTypeSchema.meta({ description: 'The single metric to fetch' }),
    start: iso8601DateTimeSchema.meta({ description: 'Start of the requested window (ISO 8601)' }),
  })
  .meta({ id: 'PublicSeriesQuery' })

export type PublicSeriesQuery = z.infer<typeof publicSeriesQuerySchema>

/** Response for the public series endpoint. Payload fields optional so 404s type-check. */
export const publicSeriesResponseSchema = baseResponseSchema
  .extend({
    bucket: z.string().optional().meta({ description: 'Effective bucket size after server flooring' }),
    end: z.string().optional().meta({ description: 'Effective end of the returned window (ISO 8601)' }),
    metric: z.string().optional().meta({ description: 'The metric returned' }),
    samples: z.array(publicSeriesSampleSchema).optional().meta({ description: 'Bucketed samples' }),
    start: z.string().optional().meta({ description: 'Effective start of the returned window (ISO 8601)' }),
    unit: z.string().optional().meta({ description: 'Unit of the metric' }),
  })
  .meta({ id: 'PublicSeriesResponse' })

export type PublicSeriesResponse = z.infer<typeof publicSeriesResponseSchema>

/**
 * Response for the public *structured post* endpoint (`GET /public/:username/feed/:postId`).
 * `structured` is absent (with `success: false`) for unknown / non-public posts. Consumed by
 * another Aurboda instance on ingest to render a native chart or article.
 */
export const feedPostStructuredResponseSchema = baseResponseSchema
  .extend({ structured: feedStructuredPostSchema.optional() })
  .meta({ id: 'FeedPostStructuredResponse' })

export type FeedPostStructuredResponse = z.infer<typeof feedPostStructuredResponseSchema>

// =============================================================================
// Reddit/markdown export (C4)
// =============================================================================

/**
 * Response for the article markdown-export endpoint: a paste-ready rendering of
 * the article's title + prose, with each chart/correlation block as a link to
 * its rendered PNG (the C1 block-image endpoint) — meant for pasting into a
 * text-only destination like r/QuantifiedSelf. `markdown` is absent (with
 * `success: false`) for an unknown id or a non-article post.
 */
export const articleExportResponseSchema = baseResponseSchema
  .extend({
    markdown: z.string().optional().meta({
      description: 'Paste-ready markdown: title + prose + one image link per chart/correlation block',
    }),
  })
  .meta({ id: 'ArticleExportResponse' })

export type ArticleExportResponse = z.infer<typeof articleExportResponseSchema>
