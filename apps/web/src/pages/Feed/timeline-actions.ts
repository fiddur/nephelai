/**
 * Pure cache surgery for the home timeline's like ⭐ / boost 🔄 buttons.
 *
 * A toggle has to show immediately, but the entry lives inside an infinite-query
 * cache (`['feed','timeline']` → pages of `TimelineResponse`). Patching it is the
 * only stateful part of the interaction, so it lives here as a pure function:
 * optimistic update, rollback on error, and replacement with the server's row
 * all go through the same call.
 */
import type { TimelineEntry, TimelineResponse } from '@aurboda/api-spec'
import type { InfiniteData } from '@tanstack/react-query'

/** The infinite-query shape the home timeline stores. */
export type TimelinePages = InfiniteData<TimelineResponse>

/**
 * Replace entry `id` in every page with `patch(entry)`. Returns the input
 * unchanged when there is no cache yet or the entry isn't in it, so a caller can
 * always hand the result straight back to `setQueryData`.
 */
export const patchTimelineEntry = (
  data: TimelinePages | undefined,
  id: string,
  patch: (entry: TimelineEntry) => TimelineEntry,
): TimelinePages | undefined => {
  if (data == null) return data
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      entries: page.entries.map((entry) => (entry.id === id ? patch(entry) : entry)),
    })),
  }
}

/**
 * The optimistic result of toggling one reaction. `liked`/`boosted` are present
 * ONLY when true (the api-spec convention), so turning one off deletes the key
 * rather than setting it false — otherwise the card would read as reacted.
 */
export const withReaction = (entry: TimelineEntry, kind: 'boosted' | 'liked', on: boolean): TimelineEntry => {
  if (on) return { ...entry, [kind]: true }
  const { [kind]: _removed, ...rest } = entry
  return rest
}
