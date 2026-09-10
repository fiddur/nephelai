/**
 * The comments under one of the owner's own posts.
 *
 * These are not fetched from anywhere: a reply to one of the owner's posts is
 * delivered to their inbox and admitted to the timeline on ingest (#1060), so
 * the comments are `timeline_entry` rows this instance already holds. That makes
 * each comment a full `TimelineEntry` — same head, same ⭐ / 🔄 / 🗨 row as a
 * home-timeline card — so the owner can favourite, boost or reply to a comment
 * without leaving their own post.
 *
 * The count rides along on the feed listing (one batched query per page); the
 * comments themselves load only when the reader expands the chip.
 */
import type { FeedPost } from '@aurboda/api-spec'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'preact/hooks'

import { fetchFeedPostReplies } from '../../state/api'
import { TimelineActions } from './TimelineActions'
import { TimelineEntryHead } from './TimelineEntryHead'

/** Query key for one own post's comment list. */
const postRepliesKey = (postId: string) => ['feed', 'posts', postId, 'replies'] as const

/**
 * The owner's own post footer: a "🗨 n" chip (from the count the listing already
 * carries) that expands into the comments. Rendered as a fragment inside
 * `.feed-post-footer`, which wraps so the list gets its own row. Absent entirely
 * for a post nobody has replied to.
 */
export function PostReplySummary({ post }: { post: FeedPost }) {
  const [expanded, setExpanded] = useState(false)
  const count = post.reply_count ?? 0
  if (count === 0) return null
  return (
    <>
      <button
        type="button"
        class="feed-post-reaction-chips"
        aria-expanded={expanded}
        title="See the replies"
        onClick={() => setExpanded((open) => !open)}
      >
        <span>🗨 {count}</span>
      </button>
      {expanded && <PostReplies postId={post.id} />}
    </>
  )
}

export function PostReplies({ postId }: { postId: string }) {
  const query = useQuery({
    queryFn: () => fetchFeedPostReplies(postId),
    queryKey: postRepliesKey(postId),
    staleTime: 60 * 1000,
  })

  if (query.isLoading) return <p class="feed-post-reactions-status">Loading…</p>
  if (query.isError) return <p class="feed-post-reactions-status">Couldn't load the replies.</p>
  const replies = query.data ?? []
  if (replies.length === 0) return <p class="feed-post-reactions-status">No replies yet.</p>

  return (
    <div class="feed-post-comments">
      {replies.map((entry) => (
        <article key={entry.id} class="feed-post-comment">
          <TimelineEntryHead entry={entry} compact />
          {/* Sanitised server-side on ingest (timeline-ingest.ts) — safe to render. */}
          <div class="feed-post-reply-content" dangerouslySetInnerHTML={{ __html: entry.content }} />
          {/* Replying here answers the COMMENT, so the new reply belongs to that
              sub-thread rather than this list — nothing to refetch. */}
          <TimelineActions entry={entry} />
        </article>
      ))}
    </div>
  )
}
