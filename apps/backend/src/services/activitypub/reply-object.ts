/**
 * The AS2 `content` for a reply post — a Mastodon-style comment on another
 * post: the replied-to author as a leading mention link, then the author's own
 * markdown rendered through the same outbound sanitiser as article prose
 * (`renderProse` — #910's boundary).
 *
 * Mastodon builds a reply exactly this way: the `Mention` tag is what notifies
 * and links the author, while the visible `@handle` anchor at the head of the
 * content is what a human reads. Both are derived from the SAME stored target
 * (resolved server-side from the timeline entry being replied to), so the
 * rendered mention can never point somewhere the tag doesn't.
 *
 * Pure and shared: `deliver.ts` federates this string, and the thread-snapshot
 * merge shows the reader their own reply with byte-identical content.
 */
import { escapeXml } from '../charts/chart-svg.ts'
import { renderProse } from './article-object.ts'

/** The stored reply fields the content render needs. */
export interface ReplyContentSource {
  message: string | null
  in_reply_to_actor_uri: string | null
  in_reply_to_handle: string | null
}

/**
 * `@user@host` for an actor URI (`https://host/users/alice` → `@alice@host`),
 * or null when the URI has no username-looking last segment. The fallback when
 * a timeline entry never carried a handle snapshot — a mention still has to
 * name someone.
 */
export const actorUriToHandle = (actorUri: string): string | null => {
  let url: URL
  try {
    url = new URL(actorUri)
  } catch {
    return null
  }
  const username = url.pathname.split('/').filter(Boolean).pop()
  if (username == null || username === '') return null
  try {
    return `@${decodeURIComponent(username)}@${url.host}`
  } catch {
    return null
  }
}

/**
 * The `@user@host` a reply's mention shows: the snapshot taken at reply time,
 * else derived from the actor URI, else the raw actor URI (never nothing — an
 * unnamed mention link is worse than a long one).
 */
export const replyMentionName = (post: ReplyContentSource): string =>
  post.in_reply_to_handle ??
  (post.in_reply_to_actor_uri == null
    ? ''
    : (actorUriToHandle(post.in_reply_to_actor_uri) ?? post.in_reply_to_actor_uri))

/**
 * The actor URI only when it is http(s). This string becomes an `href` in HTML
 * that both federates and is rendered into the web's `dangerouslySetInnerHTML`
 * thread view, so it gets the same scheme allowlist every other remote-supplied
 * URL in the feed does (`httpsOnly` in `remote-replies.ts`, the sanitiser's
 * `allowedSchemes`) — escaping alone would still hand a click a `javascript:`
 * URL running in the app origin. A stored `actor_uri` is always an http(s) URL
 * Fedify resolved, so this is a belt on top of braces.
 */
const httpActorUri = (actorUri: string): string | null => {
  try {
    const url = new URL(actorUri)
    return url.protocol === 'https:' || url.protocol === 'http:' ? actorUri : null
  } catch {
    return null
  }
}

/**
 * The Note `content` HTML for a reply: the mention as its own leading
 * paragraph (`h-card` / `u-url mention`, matching the `Mention` tag the Note
 * carries), then the author's markdown. A reply whose target has no linkable
 * actor URI renders as bare prose rather than a dangling or unsafe link.
 */
export const renderReplyContent = (post: ReplyContentSource): string => {
  const parts: string[] = []
  const href = post.in_reply_to_actor_uri == null ? null : httpActorUri(post.in_reply_to_actor_uri)
  if (href != null) {
    parts.push(
      `<p><span class="h-card"><a href="${escapeXml(href)}" class="u-url mention">` +
        `${escapeXml(replyMentionName(post))}</a></span></p>`,
    )
  }
  if (post.message) parts.push(renderProse(post.message))
  return parts.join('\n')
}
