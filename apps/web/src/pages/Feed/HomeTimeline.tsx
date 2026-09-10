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

import { fetchTimeline, fetchTimelineReplies, fetchUserSettings, updateUserSettings } from '../../state/api'
import { ActorName } from './ActorName'
import { originHost } from './entry-markers'
import { timelineImageVisible } from './timeline-structured'
import { TimelineActions, TIMELINE_KEY } from './TimelineActions'
import { TimelineEntryHead } from './TimelineEntryHead'
import { TimelineStructured } from './TimelineStructured'
import { useTimelineLive } from './useTimelineLive'

/** Query key for one card's live reply thread. */
const repliesKey = (entryId: string) => ['feed', 'timeline', entryId, 'replies'] as const

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

function TimelineCard({ entry }: { entry: TimelineEntry }) {
  const queryClient = useQueryClient()
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
      <TimelineEntryHead entry={entry} />

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

      <TimelineActions
        entry={entry}
        // A published reply belongs in the thread below — refetch it if the
        // reader has it open (an inactive query is left alone).
        onReplied={() => void queryClient.invalidateQueries({ queryKey: repliesKey(entry.id) })}
      />

      <TimelineReplies entry={entry} />
    </article>
  )
}

/**
 * Expandable snapshot of the post's reply thread — fetched from the origin only
 * when the reader asks (a bounded, best-effort walk of the AS2 `replies`
 * collection), with the reader's OWN replies merged in. `partial` marks a thread
 * longer than the budget; `fetched: false` means the origin's thread couldn't be
 * read at all, which must NOT read as "no replies" (#1065).
 */
function TimelineReplies({ entry }: { entry: TimelineEntry }) {
  const [expanded, setExpanded] = useState(false)
  const query = useQuery({
    enabled: expanded,
    queryFn: () => fetchTimelineReplies(entry.id),
    queryKey: repliesKey(entry.id),
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
  const { fetched, partial, replies } = query.data
  const host = originHost(entry.boost_of_uri ?? entry.object_uri)
  return (
    <div class="feed-post-replies">
      {replies.length === 0 &&
        (fetched ? (
          <p class="feed-post-replies-status">No replies found on the origin.</p>
        ) : (
          <p class="feed-post-replies-status">Couldn't read the thread from {host}.</p>
        ))}
      {replies.map((reply, i) => (
        <div key={reply.object_uri ?? reply.url ?? i} class="feed-post-reply">
          <span class="feed-post-reply-author">
            {reply.display_name ?? reply.handle ?? reply.actor_uri ?? 'unknown'}
            {reply.handle && reply.display_name ? ` ${reply.handle}` : ''}
            {reply.mine && <span class="feed-post-reply-mine">you</span>}
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
      ))}
      {/* A thread we couldn't read is not a short one — say so even when our own
          replies are the only thing showing. */}
      {replies.length > 0 && !fetched && (
        <p class="feed-post-replies-status">Couldn't read the thread from {host}.</p>
      )}
      {partial && fetched && (
        <p class="feed-post-replies-status">Thread may be longer — see the original post.</p>
      )}
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
