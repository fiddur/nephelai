/**
 * Home timeline — posts received from the fediverse actors the user follows
 * (#884 §3), newest-first, keyset-paginated via the opaque `next_cursor`.
 *
 * Each entry renders as the same Mastodon-style card as the user's own posts,
 * but from a remote author. The `content` HTML was already sanitised server-side
 * on ingest (see `timeline-ingest.ts`), so it's safe to render directly here.
 */
import type { TimelineEntry, TimelineResponse } from '@aurboda/api-spec'
import type { InfiniteData } from '@tanstack/react-query'

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { useState } from 'preact/hooks'

import {
  boostTimelineEntry,
  fetchTimeline,
  fetchTimelineReplies,
  fetchUserSettings,
  likeTimelineEntry,
  unboostTimelineEntry,
  unlikeTimelineEntry,
  updateUserSettings,
} from '../../state/api'
import { ActorName } from './ActorName'
import { patchTimelineEntry, type TimelinePages, withReaction } from './timeline-actions'
import { timelineImageVisible } from './timeline-structured'
import { TimelineStructured } from './TimelineStructured'
import { useTimelineLive } from './useTimelineLive'

/** The infinite-query key every timeline page (and every optimistic patch) lives under. */
const TIMELINE_KEY = ['feed', 'timeline'] as const

/** De-duplicate entries by `object_uri`, keeping the first (newest) occurrence. */
const dedupByUri = (list: TimelineEntry[]): TimelineEntry[] => {
  const seen = new Set<string>()
  const out: TimelineEntry[] = []
  for (const entry of list) {
    if (!seen.has(entry.object_uri)) {
      seen.add(entry.object_uri)
      out.push(entry)
    }
  }
  return out
}

/**
 * A fallback avatar (a neutral silhouette) for actors without an icon. Colours use
 * raw `#` — `encodeURIComponent` percent-encodes them exactly once (writing `%23`
 * here too would double-encode to `%2523` and render the fills black).
 */
const FALLBACK_AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><rect width="44" height="44" rx="22" fill="#cbd5e1"/><circle cx="22" cy="17" r="8" fill="#fff"/><path d="M8 40c0-8 6-12 14-12s14 4 14 12" fill="#fff"/></svg>',
  )

function TimelineCard({ entry }: { entry: TimelineEntry }) {
  const when = formatDistanceToNow(new Date(entry.published_at), { addSuffix: true })
  const name = entry.display_name ?? entry.handle ?? entry.actor_uri
  const booster = entry.boosted_by
  return (
    <article class="feed-post">
      {/* Mastodon's "🔄 X boosted" line: the card below is the ORIGINAL post. */}
      {booster && (
        <p class="feed-post-boost-marker">
          🔄{' '}
          <ActorName
            name={booster.display_name ?? booster.handle ?? booster.actor_uri}
            actorUri={booster.actor_uri}
          />{' '}
          boosted
        </p>
      )}
      <header class="feed-post-head">
        <img
          class="feed-post-avatar"
          src={entry.avatar_url ?? FALLBACK_AVATAR}
          alt=""
          width={44}
          height={44}
          loading="lazy"
        />
        <div class="feed-post-ident">
          <span class="feed-post-name">
            <ActorName name={name} actorUri={entry.actor_uri} />
          </span>
          <span class="feed-post-handle">
            {entry.handle && <>{entry.handle} · </>}
            {entry.url ? (
              <a href={entry.url} target="_blank" rel="noopener noreferrer nofollow">
                <time title={new Date(entry.published_at).toLocaleString()}>{when}</time>
              </a>
            ) : (
              <time title={new Date(entry.published_at).toLocaleString()}>{when}</time>
            )}
          </span>
          {entry.in_reply_to_uri != null ? (
            <span class="feed-post-reply-marker">
              ↩ {entry.in_reply_to_mine ? 'replied to you' : 'a reply'}
            </span>
          ) : entry.mentions_me ? (
            <span class="feed-post-reply-marker">@ mentioned you</span>
          ) : null}
        </div>
      </header>

      {/* Sanitised server-side on ingest (timeline-ingest.ts) — safe to render.
          Suppressed whenever the post has a native structured render (below),
          whose content covers the same title/message/stats (article: title +
          prose + captions; activity: title + message + date + stat grid) — else
          the post shows twice (#997). */}
      {!entry.structured && (
        <div class="feed-post-content" dangerouslySetInnerHTML={{ __html: entry.content }} />
      )}

      {/* Native structured data (Aurboda peers) → a real chart+map / inline
          article; otherwise fall back to the delivered image attachment(s), the
          way Mastodon shows them. `timelineImageVisible` keeps each image
          unless its native counterpart actually renders. */}
      {entry.structured && <TimelineStructured structured={entry.structured} />}
      {entry.images
        ?.filter((img) => timelineImageVisible(entry.structured, img.name))
        .map((img) => (
          <img
            key={img.url}
            class="feed-post-image"
            src={img.url}
            alt={img.name ?? ''}
            width={img.width}
            height={img.height}
            loading="lazy"
          />
        ))}

      <TimelineActions entry={entry} />

      <TimelineReplies entryId={entry.id} />
    </article>
  )
}

/**
 * The ⭐ / 🔄 row. Both toggles are optimistic: the card flips at once and the
 * patched entry is written into every cached timeline page, so a later render
 * agrees; a failure rolls both back and shows the server's reason under the row.
 * On success the server's authoritative entry replaces the guess.
 *
 * The local `shown` state is what the buttons read, because a card revealed from
 * the "N new posts" pill isn't in the query cache yet — patching alone would
 * leave those buttons frozen.
 */
function TimelineActions({ entry }: { entry: TimelineEntry }) {
  const queryClient = useQueryClient()
  const [shown, setShown] = useState<TimelineEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = shown ?? entry

  const patch = (next: TimelineEntry) => {
    setShown(next)
    queryClient.setQueryData<TimelinePages>(TIMELINE_KEY, (data) =>
      patchTimelineEntry(data, entry.id, () => next),
    )
  }

  const toggle = (kind: 'boosted' | 'liked', on: boolean, request: () => Promise<TimelineEntry>) => {
    setError(null)
    const previous = queryClient.getQueryData<TimelinePages>(TIMELINE_KEY)
    patch(withReaction(current, kind, on))
    request()
      .then(patch)
      .catch((cause: Error) => {
        setShown(current)
        queryClient.setQueryData<TimelinePages>(TIMELINE_KEY, previous)
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
      </div>
      {error && <p class="feed-error feed-post-action-error">{error}</p>}
    </>
  )
}

/**
 * Expandable live snapshot of the post's remote reply thread — fetched from the
 * origin only when the reader asks (a bounded, best-effort walk of the AS2
 * `replies` collection; `partial` marks a thread longer than the budget).
 */
function TimelineReplies({ entryId }: { entryId: string }) {
  const [expanded, setExpanded] = useState(false)
  const query = useQuery({
    enabled: expanded,
    queryFn: () => fetchTimelineReplies(entryId),
    queryKey: ['feed', 'timeline', entryId, 'replies'],
    retry: false,
    staleTime: 60 * 1000,
  })

  if (!expanded) {
    return (
      <button type="button" class="feed-post-replies-toggle" onClick={() => setExpanded(true)}>
        Show replies
      </button>
    )
  }
  if (query.isLoading) return <p class="feed-post-replies-status">Loading replies…</p>
  if (query.isError || !query.data?.success) {
    return <p class="feed-post-replies-status">Couldn't fetch replies from the origin.</p>
  }
  const { partial, replies } = query.data
  return (
    <div class="feed-post-replies">
      {replies.length === 0 ? (
        <p class="feed-post-replies-status">No replies found on the origin.</p>
      ) : (
        replies.map((reply, i) => (
          <div key={reply.url ?? i} class="feed-post-reply">
            <span class="feed-post-reply-author">
              {reply.display_name ?? reply.handle ?? reply.actor_uri ?? 'unknown'}
              {reply.handle && reply.display_name ? ` ${reply.handle}` : ''}
              {reply.url && (
                <>
                  {' · '}
                  <a href={reply.url} target="_blank" rel="noopener noreferrer nofollow">
                    {reply.published_at
                      ? formatDistanceToNow(new Date(reply.published_at), { addSuffix: true })
                      : 'link'}
                  </a>
                </>
              )}
            </span>
            {/* Sanitised server-side (remote-replies.ts) — safe to render. */}
            <div class="feed-post-reply-content" dangerouslySetInnerHTML={{ __html: reply.content }} />
          </div>
        ))
      )}
      {partial && <p class="feed-post-replies-status">Thread may be longer — see the original post.</p>}
    </div>
  )
}

/**
 * The `timeline_show_replies` setting, surfaced where the timeline actually is
 * (it also lives on the Settings page). Saving invalidates the timeline query
 * so the filter takes effect immediately.
 */
function ShowRepliesToggle() {
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({
    queryFn: fetchUserSettings,
    queryKey: ['userSettings'],
    staleTime: 60 * 1000,
  })
  const mutation = useMutation({
    mutationFn: (show: boolean) => updateUserSettings({ timeline_show_replies: show }),
    onSuccess: (result) => {
      queryClient.setQueryData(['userSettings'], result)
      void queryClient.invalidateQueries({ queryKey: ['feed', 'timeline'] })
    },
  })
  const show = mutation.isPending
    ? (mutation.variables ?? false)
    : (settingsQuery.data?.timeline_show_replies ?? false)
  return (
    <label class="timeline-replies-toggle">
      <input
        type="checkbox"
        checked={show}
        disabled={settingsQuery.isLoading || mutation.isPending}
        onChange={(e) => mutation.mutate((e.target as HTMLInputElement).checked)}
      />
      <span>Show replies to others (replies to you always show)</span>
    </label>
  )
}

export function HomeTimeline() {
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery<
    TimelineResponse,
    Error,
    InfiniteData<TimelineResponse>,
    readonly string[],
    string | undefined
  >({
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => fetchTimeline(pageParam),
    queryKey: TIMELINE_KEY,
  })

  const entries = data?.pages.flatMap((page) => page.entries) ?? []

  // Posts that arrived live (or via the polling fallback) since the page loaded:
  // buffered in `pending` (shown as a pill) until the user reveals them, then
  // prepended via `revealed`. Both are de-duped against the query data on render.
  const [pending, setPending] = useState<TimelineEntry[]>([])
  const [revealed, setRevealed] = useState<TimelineEntry[]>([])

  // On a live ping (or poll tick), refetch the newest page and buffer anything we
  // aren't already showing. Cheap: one page, and only when the server says so.
  const checkForNew = async () => {
    try {
      const { entries: latest } = await fetchTimeline()
      const known = new Set([...revealed, ...pending, ...entries].map((entry) => entry.object_uri))
      const fresh = latest.filter((entry) => !known.has(entry.object_uri))
      if (fresh.length > 0) setPending((prev) => dedupByUri([...fresh, ...prev]))
    } catch {
      // A transient refetch failure just means the pill doesn't update this tick.
    }
  }
  useTimelineLive(() => void checkForNew())

  const reveal = () => {
    setRevealed((prev) => dedupByUri([...pending, ...prev]))
    setPending([])
    window.scrollTo({ behavior: 'smooth', top: 0 })
  }

  const displayed = dedupByUri([...revealed, ...entries])

  return (
    <section class="timeline-section">
      <h2 class="feed-section-title">Home timeline</h2>
      <ShowRepliesToggle />
      {pending.length > 0 && (
        <button type="button" class="timeline-new-pill" onClick={reveal}>
          {pending.length} new post{pending.length === 1 ? '' : 's'}
        </button>
      )}
      {isLoading && <p>Loading…</p>}
      {error && <p class="feed-error">Couldn't load your timeline. Please try again.</p>}
      {!isLoading && !error && displayed.length === 0 && (
        <p class="feed-empty">
          No posts yet. Follow some fediverse accounts above and their posts will appear here.
        </p>
      )}
      {displayed.map((entry) => (
        <TimelineCard key={entry.object_uri} entry={entry} />
      ))}
      {hasNextPage && (
        <button
          type="button"
          class="btn-secondary timeline-more"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  )
}
