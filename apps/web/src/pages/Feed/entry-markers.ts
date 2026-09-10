/**
 * Pure presentation rules for a received post's "why am I seeing this" markers
 * and for naming the host that serves a thread.
 *
 * Kept out of the components so the rules are testable on their own: they are
 * the answer to a question the reader actually asks of a card, and they got it
 * wrong once (#1066 — a reply that also mentioned you dropped the mention
 * notice entirely).
 */
import type { TimelineEntry } from '@aurboda/api-spec'

export interface EntryMarker {
  /** Stable key + the leading glyph. */
  icon: string
  label: string
}

/**
 * The markers a card shows, in order. They COMPOSE rather than exclude each
 * other: a reply says what it answers, and a post that additionally mentions you
 * says that too — the mention is the reason it reached you at all. A reply to
 * your OWN post already implies the mention, so that pair collapses to one.
 */
export const entryMarkers = (
  entry: Pick<TimelineEntry, 'in_reply_to_mine' | 'in_reply_to_uri' | 'mentions_me'>,
): EntryMarker[] => {
  const markers: EntryMarker[] = []
  if (entry.in_reply_to_uri != null) {
    markers.push({ icon: '↩', label: entry.in_reply_to_mine === true ? 'replied to you' : 'a reply' })
  }
  if (entry.mentions_me === true && entry.in_reply_to_mine !== true) {
    markers.push({ icon: '@', label: 'mentioned you' })
  }
  return markers
}

/** The host serving a post's thread, for the "couldn't read it" message. */
export const originHost = (objectUri: string): string => {
  try {
    return new URL(objectUri).host
  } catch {
    return 'the origin'
  }
}
