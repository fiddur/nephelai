/**
 * Who favourited ⭐ or boosted 🔄 one of the owner's own posts.
 *
 * The counts ride along on the feed listing (one batched query per page); the
 * names are fetched only when the reader expands a chip, since a post with many
 * reactions would otherwise pull a list nobody asked for.
 */
import type { FeedPost, FeedPostReaction } from '@aurboda/api-spec'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'preact/hooks'

import { fetchFeedPostReactions } from '../../state/api'
import { ActorName } from './ActorName'

const LABEL: Record<FeedPostReaction['kind'], string> = { announce: '🔄', like: '⭐' }

/**
 * The owner's own post footer: "⭐ 3 🔄 1" chips (from the counts the listing
 * already carries) that expand into the list of who reacted. Rendered as a
 * fragment inside `.feed-post-footer`, which wraps so the list gets its own row.
 * Absent entirely for a post nobody has reacted to.
 */
export function PostReactionSummary({ post }: { post: FeedPost }) {
  const [expanded, setExpanded] = useState(false)
  const likes = post.like_count ?? 0
  const boosts = post.boost_count ?? 0
  if (likes === 0 && boosts === 0) return null
  return (
    <>
      <button
        type="button"
        class="feed-post-reaction-chips"
        aria-expanded={expanded}
        title="See who reacted"
        onClick={() => setExpanded((open) => !open)}
      >
        {likes > 0 && <span>⭐ {likes}</span>}
        {boosts > 0 && <span>🔄 {boosts}</span>}
      </button>
      {expanded && <PostReactions postId={post.id} />}
    </>
  )
}

export function PostReactions({ postId }: { postId: string }) {
  const query = useQuery({
    queryFn: () => fetchFeedPostReactions(postId),
    queryKey: ['feed', 'posts', postId, 'reactions'],
    staleTime: 60 * 1000,
  })

  if (query.isLoading) return <p class="feed-post-reactions-status">Loading…</p>
  if (query.isError) return <p class="feed-post-reactions-status">Couldn’t load who reacted.</p>
  const reactions = query.data ?? []
  if (reactions.length === 0) return <p class="feed-post-reactions-status">Nobody yet.</p>

  return (
    <ul class="feed-post-reactions">
      {reactions.map((reaction) => (
        <li key={`${reaction.kind}:${reaction.actor_uri}`} class="feed-post-reaction">
          <span aria-hidden="true">{LABEL[reaction.kind]}</span>
          <ActorName
            name={reaction.display_name ?? reaction.handle ?? reaction.actor_uri}
            actorUri={reaction.actor_uri}
          />
          {reaction.display_name && reaction.handle && (
            <span class="feed-post-reaction-handle">{reaction.handle}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
