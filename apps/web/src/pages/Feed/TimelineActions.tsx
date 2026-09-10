/**
 * The ⭐ / 🔄 / 🗨 action row under a received post, plus the inline reply
 * composer 🗨 opens.
 *
 * Like and boost are optimistic: the card flips at once and the patched entry is
 * written into every cached timeline page, so a later render agrees; a failure
 * rolls that one entry back (never the whole cache) and shows the server's
 * reason under the row. On success the server's authoritative entry replaces the
 * guess.
 *
 * A reply is NOT optimistic — it publishes a post that federates, so it waits
 * for the server and reports what actually happened.
 *
 * The local `shown` state is what the buttons read, because a card revealed from
 * the "N new posts" pill isn't in the query cache yet — patching alone would
 * leave those buttons frozen. The same row serves the comment cards under the
 * owner's own posts (a comment is a timeline entry too); their entries aren't in
 * the timeline cache, so the patch there is simply a no-op.
 */
import type { FeedVisibility, TimelineEntry } from '@aurboda/api-spec'

import { feedPostMessageMaxLength } from '@aurboda/api-spec'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'preact/hooks'

import { FEED_VISIBILITY_OPTIONS, VisibilitySelector } from '../../components/VisibilitySelector'
import {
  boostTimelineEntry,
  likeTimelineEntry,
  replyToTimelineEntry,
  unboostTimelineEntry,
  unlikeTimelineEntry,
} from '../../state/api'
import { patchTimelineEntry, type TimelinePages, withReaction } from './timeline-actions'

/** The infinite-query key every timeline page (and every optimistic patch) lives under. */
export const TIMELINE_KEY = ['feed', 'timeline'] as const

/**
 * The inline reply box. Visibility defaults to `unlisted` — Mastodon's
 * convention for replies, which belong to their thread rather than on public
 * timelines — and the author can still widen or narrow it.
 */
function ReplyComposer({
  entry,
  onPosted,
  onCancel,
}: {
  entry: TimelineEntry
  onPosted: () => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [visibility, setVisibility] = useState<FeedVisibility>('unlisted')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const target = entry.handle ?? entry.display_name ?? 'this post'

  const submit = () => {
    const message = text.trim()
    if (message === '' || sending) return
    setError(null)
    setSending(true)
    replyToTimelineEntry(entry.id, { message, visibility })
      .then(() => {
        setText('')
        onPosted()
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setSending(false))
  }

  return (
    <div class="feed-reply-composer">
      <textarea
        class="feed-reply-text"
        value={text}
        rows={3}
        maxLength={feedPostMessageMaxLength}
        placeholder={`Reply to ${target}…`}
        aria-label={`Reply to ${target}`}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
      />
      <VisibilitySelector
        value={visibility}
        onChange={setVisibility}
        options={FEED_VISIBILITY_OPTIONS}
        name={`reply-visibility-${entry.id}`}
        legend="Reply visibility"
        compact
      />
      <div class="feed-reply-composer-actions">
        <button type="button" class="btn-primary" disabled={sending || text.trim() === ''} onClick={submit}>
          {sending ? 'Posting…' : 'Post reply'}
        </button>
        <button type="button" class="btn-secondary" disabled={sending} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <p class="feed-error feed-post-action-error">{error}</p>}
    </div>
  )
}

export function TimelineActions({
  entry,
  onReplied,
}: {
  entry: TimelineEntry
  /** Called after a reply is published, so an expanded thread can refetch. */
  onReplied?: () => void
}) {
  const queryClient = useQueryClient()
  const [shown, setShown] = useState<TimelineEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [posted, setPosted] = useState(false)
  const current = shown ?? entry

  const patch = (next: TimelineEntry) => {
    setShown(next)
    queryClient.setQueryData<TimelinePages>(TIMELINE_KEY, (data) =>
      patchTimelineEntry(data, entry.id, () => next),
    )
  }

  const toggle = (kind: 'boosted' | 'liked', on: boolean, request: () => Promise<TimelineEntry>) => {
    setError(null)
    setPosted(false)
    const before = current
    patch(withReaction(current, kind, on))
    request()
      .then(patch)
      .catch((cause: Error) => {
        setShown(before)
        // Roll THIS entry back, never a whole-cache snapshot: pages fetched (and
        // other cards toggled) while the request was in flight must survive the
        // failure, and restoring an `undefined` snapshot would be ignored anyway.
        queryClient.setQueryData<TimelinePages>(TIMELINE_KEY, (data) =>
          patchTimelineEntry(data, entry.id, () => before),
        )
        setError(cause.message)
      })
  }

  const liked = current.liked === true
  const boosted = current.boosted === true
  return (
    <>
      <div class="feed-post-actions">
        <button
          type="button"
          class={`feed-post-action${liked ? ' active' : ''}`}
          aria-pressed={liked}
          aria-label={liked ? 'Unfavourite' : 'Favourite'}
          title={liked ? 'Unfavourite' : 'Favourite'}
          onClick={() =>
            toggle('liked', !liked, () =>
              liked ? unlikeTimelineEntry(entry.id) : likeTimelineEntry(entry.id),
            )
          }
        >
          ⭐
        </button>
        <button
          type="button"
          class={`feed-post-action feed-post-action--boost${boosted ? ' active' : ''}`}
          aria-pressed={boosted}
          aria-label={boosted ? 'Unboost' : 'Boost'}
          title={boosted ? 'Unboost' : 'Boost'}
          onClick={() =>
            toggle('boosted', !boosted, () =>
              boosted ? unboostTimelineEntry(entry.id) : boostTimelineEntry(entry.id),
            )
          }
        >
          🔄
        </button>
        <button
          type="button"
          class={`feed-post-action feed-post-action--reply${composing ? ' active' : ''}`}
          aria-expanded={composing}
          aria-label="Reply"
          title="Reply"
          onClick={() => {
            setPosted(false)
            setComposing((open) => !open)
          }}
        >
          🗨
        </button>
      </div>
      {composing && (
        <ReplyComposer
          entry={entry}
          onPosted={() => {
            setComposing(false)
            setPosted(true)
            onReplied?.()
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      {posted && !composing && <p class="feed-post-replies-status">Reply posted ✓</p>}
      {error && <p class="feed-error feed-post-action-error">{error}</p>}
    </>
  )
}
