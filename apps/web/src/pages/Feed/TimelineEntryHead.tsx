/**
 * The Mastodon-style identity line every received post shows: avatar, author,
 * handle, time, and the "why am I seeing this" markers.
 *
 * Shared by the home-timeline card and by the comment cards under the owner's
 * own posts — a comment IS a timeline entry, so it gets the same head rather
 * than a second, subtly different one.
 */
import type { TimelineEntry } from '@aurboda/api-spec'

import { formatDistanceToNow } from 'date-fns'

import { ActorName } from './ActorName'
import { entryMarkers } from './entry-markers'

/**
 * A fallback avatar (a neutral silhouette) for actors without an icon. Colours use
 * raw `#` — `encodeURIComponent` percent-encodes them exactly once (writing `%23`
 * here too would double-encode to `%2523` and render the fills black).
 */
export const FALLBACK_AVATAR =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><rect width="44" height="44" rx="22" fill="#cbd5e1"/><circle cx="22" cy="17" r="8" fill="#fff"/><path d="M8 40c0-8 6-12 14-12s14 4 14 12" fill="#fff"/></svg>',
  )

export function TimelineEntryHead({ entry, compact = false }: { entry: TimelineEntry; compact?: boolean }) {
  const when = formatDistanceToNow(new Date(entry.published_at), { addSuffix: true })
  const name = entry.display_name ?? entry.handle ?? entry.actor_uri
  const size = compact ? 28 : 44
  return (
    <header class="feed-post-head">
      <img
        class="feed-post-avatar"
        src={entry.avatar_url ?? FALLBACK_AVATAR}
        alt=""
        width={size}
        height={size}
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
        {/* Rules in `entry-markers.ts` (#1066): a reply that ALSO mentions you
            shows both, since the mention is why it reached you at all. */}
        {entryMarkers(entry).map((marker) => (
          <span key={marker.icon} class="feed-post-reply-marker">
            {marker.icon} {marker.label}
          </span>
        ))}
      </div>
    </header>
  )
}
