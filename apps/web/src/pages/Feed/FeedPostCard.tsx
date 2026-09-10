/**
 * A single feed post rendered as it actually federates — a Mastodon-style card
 * (author, handle, timestamp, visibility, the AS2 `content` HTML, and any
 * chart/route image attachments) rather than a management chip list (#884 §1).
 *
 * Reusable for the future home timeline: the author identity is passed in, so
 * the same card renders both the viewer's own posts and (later) remote actors'.
 * `footer` carries per-post controls (Edit / Unshare) for the viewer's own posts.
 */
import type { FeedPost, FeedVisibility } from '@aurboda/api-spec'
import type { ComponentChildren } from 'preact'

import { formatDistanceToNow } from 'date-fns'

import { API_URL } from '../../config'
import { renderMarkdown } from '../../utils/markdown'
import { formatEntryWindow } from './activity-stats'
import { ActivityStatGrid } from './ActivityStatGrid'
import { ArticleContent } from './ArticleContent'
import { ChallengeShareContent } from './ChallengeShareContent'
import { structuredHasNativeHrChart, structuredHasNativeMap } from './timeline-structured'
import { TimelineStructured } from './TimelineStructured'
import './FeedPostCard.css'

export interface PostAuthor {
  displayName: string
  /** `@user@host`. */
  handle: string
  /** Local username, used to build the post's image URLs. */
  username: string
  avatarUrl: string
  profileUrl?: string
}

const VISIBILITY: Record<FeedVisibility, { icon: string; label: string }> = {
  followers: { icon: '🔒', label: 'Followers only' },
  public: { icon: '🌐', label: 'Public' },
  unlisted: { icon: '🔓', label: 'Unlisted' },
}

/**
 * A public/unlisted post's rendered image URL, or `null`. `followers`-only images
 * are token-gated and the browser has no token (#893), so they're omitted here.
 */
const imageUrl = (username: string, post: FeedPost, kind: 'chart' | 'route'): string | null =>
  post.visibility === 'followers'
    ? null
    : `${API_URL}/public/${encodeURIComponent(username)}/feed/${post.id}/${kind}.png`

/**
 * The post's static image URLs. Each image is replaced only when its native
 * counterpart ACTUALLY renders — `structured` is attached to every activity
 * post, so keying on its mere presence would drop an image whose native render
 * is empty/undrawable. chart.png draws heart rate only, so only a drawable
 * heart-rate series makes it redundant; route.png only a drawable route.
 */
const mediaUrls = (post: FeedPost, username: string): { chart: string | null; route: string | null } => ({
  chart:
    post.include_chart && !structuredHasNativeHrChart(post.structured)
      ? imageUrl(username, post, 'chart')
      : null,
  route:
    post.include_map && !structuredHasNativeMap(post.structured) ? imageUrl(username, post, 'route') : null,
})

/**
 * Native body for an activity post with resolved typed metrics (#997): title,
 * personal message, the activity's own date (#998), and a stat grid — instead
 * of the flattened `content` HTML Mastodon sees.
 */
const ActivityPostBody = ({ post }: { post: FeedPost }) => (
  <div class="feed-post-content">
    <p class="feed-post-title">
      <strong>{post.activity_title ?? 'Shared activity'}</strong>
    </p>
    {post.message && <p class="feed-post-message">{post.message}</p>}
    {post.activity_start_time && (
      <p class="feed-post-window">{formatEntryWindow(post.activity_start_time, post.activity_end_time)}</p>
    )}
    {post.metrics && <ActivityStatGrid metrics={post.metrics} />}
  </div>
)

/**
 * Native body for a reply post: who it answers (linked to their actor page) and
 * the author's own markdown — the same two pieces the federated Note carries,
 * where the mention is a leading paragraph before the prose.
 */
const ReplyPostBody = ({ post }: { post: FeedPost }) => {
  const who = post.in_reply_to_handle ?? post.in_reply_to_actor_uri
  return (
    <div class="feed-post-content">
      <p class="feed-post-reply-marker">
        ↩ replying to{' '}
        {post.in_reply_to_actor_uri ? (
          <a href={post.in_reply_to_actor_uri} target="_blank" rel="noopener noreferrer nofollow">
            {who}
          </a>
        ) : (
          (who ?? 'a post')
        )}
      </p>
      {post.message && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(post.message) }} />}
    </div>
  )
}

export const FeedPostCard = ({
  post,
  author,
  footer,
}: {
  post: FeedPost
  author: PostAuthor
  footer?: ComponentChildren
}) => {
  const vis = VISIBILITY[post.visibility]
  const when = formatDistanceToNow(new Date(post.created_at), { addSuffix: true })
  const { chart, route } = mediaUrls(post, author.username)

  return (
    <article class="feed-post">
      <header class="feed-post-head">
        <img class="feed-post-avatar" src={author.avatarUrl} alt="" width={44} height={44} />
        <div class="feed-post-ident">
          <span class="feed-post-name">{author.displayName}</span>
          <span class="feed-post-handle">
            {author.handle} · <time title={new Date(post.created_at).toLocaleString()}>{when}</time> ·{' '}
            <span title={vis.label} aria-label={vis.label}>
              {vis.icon}
            </span>
          </span>
        </div>
      </header>

      {/* An article renders its own title + prose/chart blocks (prose sanitised
          via the shared sanitiser). An activity post with the full structured
          payload renders the SAME `TimelineStructured` component a subscribing
          Aurboda peer's home timeline uses (#1008) — interactive hover charts
          included — so the owner and public-profile visitors see exactly what
          a follower sees. Without it (a post whose structured resolve returned
          nothing), the stat-grid `ActivityPostBody`; older payloads fall back
          to the server-built, HTML-escaped `content`. */}
      {post.kind === 'article' && post.article ? (
        <ArticleContent article={post.article} />
      ) : post.kind === 'challenge' && post.challenge ? (
        <ChallengeShareContent challenge={post.challenge} message={post.message} />
      ) : post.kind === 'reply' ? (
        <ReplyPostBody post={post} />
      ) : post.structured ? (
        <TimelineStructured structured={post.structured} />
      ) : post.metrics ? (
        <ActivityPostBody post={post} />
      ) : post.content ? (
        <div class="feed-post-content" dangerouslySetInnerHTML={{ __html: post.content }} />
      ) : (
        <div class="feed-post-content">{post.activity_title ?? 'Shared activity'}</div>
      )}

      {(chart || route) && (
        <div class="feed-post-media">
          {chart && <img class="feed-post-image" src={chart} alt="Heart rate chart" loading="lazy" />}
          {route && <img class="feed-post-image" src={route} alt="Route map" loading="lazy" />}
        </div>
      )}

      {footer && <footer class="feed-post-footer">{footer}</footer>}
    </article>
  )
}
