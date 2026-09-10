/**
 * Live fetch of a remote post's `replies` collection (#1060) — the "expand
 * replies" feature on a timeline card. Nothing is stored: the origin owns the
 * thread, we render a bounded snapshot of it on demand.
 *
 * Strictly best-effort and budgeted: at most {@link MAX_REPLIES} replies from at
 * most {@link MAX_FETCHES} SSRF-guarded requests (collection pages, reply
 * objects referenced by URI, and author actors — one lookup per unique author,
 * memoised). Anything malformed is skipped, never thrown; the response's
 * `partial` flag tells the client the budget ran out before the collection did.
 *
 * All reply HTML goes through `sanitizeRemoteHtml` before it leaves this module
 * — the payload is as untrusted as inbox content.
 */
import type { TimelineReply } from '@aurboda/api-spec'

import { safeFetchGet } from '../safe-fetch.ts'
import { sanitizeRemoteHtml } from './timeline-ingest.ts'

const MAX_REPLIES = 20
const MAX_FETCHES = 15
const AP_ACCEPT = 'application/activity+json, application/ld+json; q=0.9'

/**
 * Total wall-clock budget for one thread snapshot (root object + collection
 * pages + author lookups). Shared by the REST route and the MCP tool so the two
 * surfaces can't drift on how long a slow origin may hold a request.
 */
export const REPLIES_TIMEOUT_MS = 12_000

export interface RemoteRepliesDeps {
  /** Fetch + JSON-decode an ActivityPub URL (SSRF-guarded). */
  fetchJson: (url: string) => Promise<unknown>
}

export const realRemoteRepliesDeps: RemoteRepliesDeps = {
  fetchJson: async (url) => (await safeFetchGet(url, { headers: { Accept: AP_ACCEPT } })).data,
}

type JsonRecord = Record<string, unknown>

const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v != null && !Array.isArray(v)

/** An AS2 value that may be an id string or an embedded object with an `id`. */
const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : isRecord(v) && typeof v.id === 'string' ? v.id : null

/**
 * Keep a remote-supplied URL only when it is http(s). The web renders
 * `TimelineReply.url` as an `href`, and a hostile origin (reachable by any
 * stranger via mention-based ingestion) could otherwise hand us a
 * `javascript:` URL that executes in the app origin on click.
 */
const httpsOnly = (raw: string | null): string | null => {
  if (raw == null) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? raw : null
  } catch {
    return null
  }
}

/**
 * Keep a remote-supplied timestamp only when it actually parses — the schema
 * promises ISO 8601-or-null, and the web feeds it straight to date-fns, which
 * throws on an Invalid Date (blanking the page on a hostile `published`).
 */
const isoOrNull = (v: unknown): string | null =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null

/** The URL's host, or null when it doesn't parse (remote-controlled input). */
const hostOf = (raw: string): string | null => {
  try {
    return new URL(raw).host
  } catch {
    return null
  }
}

/**
 * A page (or collection) plus the host that actually SERVED it — the authority
 * every inline item on it is held to. A URI-referenced page/item gets its own
 * URI's host; an inline one inherits its parent's.
 */
interface PageCtx {
  page: JsonRecord
  host: string
}

/** Resolve an inline-or-URI page value into a page + its serving host. */
const resolvePage = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  v: unknown,
  inlineHost: string,
): Promise<PageCtx | null> => {
  if (isRecord(v)) return { host: inlineHost, page: v }
  if (typeof v === 'string') {
    const host = hostOf(v)
    if (host == null) return null
    const fetched = await budgetedFetch(deps, budget, v)
    return isRecord(fetched) ? { host, page: fetched } : null
  }
  return null
}

/** Budgeted fetch bookkeeping shared across one `fetchRemoteReplies` call. */
interface Budget {
  fetches: number
  exhausted: boolean
}

const budgetedFetch = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  url: string,
): Promise<unknown | null> => {
  if (budget.fetches >= MAX_FETCHES) {
    budget.exhausted = true
    return null
  }
  budget.fetches++
  try {
    return await deps.fetchJson(url)
  } catch {
    return null
  }
}

/** Resolve a value that is either an inline AS2 object or a URI to fetch. */
const resolveObject = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  v: unknown,
): Promise<JsonRecord | null> => {
  if (isRecord(v)) return v
  if (typeof v === 'string') {
    const fetched = await budgetedFetch(deps, budget, v)
    return isRecord(fetched) ? fetched : null
  }
  return null
}

interface ReplyAuthor {
  display_name: string | null
  handle: string | null
}

/** Resolve a reply author's presentation, memoised per call across replies. */
const resolveAuthor = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  actorUri: string,
  authors: Map<string, ReplyAuthor>,
): Promise<ReplyAuthor> => {
  const cached = authors.get(actorUri)
  if (cached != null) return cached
  const actor = await resolveObject(deps, budget, actorUri)
  const username =
    actor != null && typeof actor.preferredUsername === 'string' ? actor.preferredUsername : null
  const host = hostOf(actorUri)
  const author: ReplyAuthor = {
    display_name: actor != null && typeof actor.name === 'string' ? actor.name : null,
    handle: username == null || host == null ? null : `@${username}@${host}`,
  }
  authors.set(actorUri, author)
  return author
}

/**
 * Map one reply object to the DTO, resolving its author (memoised) within
 * budget. `authorityHost` is the host that actually served the object (the
 * page's host for inline items, the item URI's host for fetched ones): the
 * object's own `id` AND its `attributedTo` must live on it, or the reply is
 * dropped — otherwise a hostile origin could render arbitrary content under
 * any fediverse identity (a byline-forgery/phishing primitive; sanitisation
 * doesn't help against plain text under a forged handle).
 */
const toReply = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  obj: JsonRecord,
  authorityHost: string,
  authors: Map<string, ReplyAuthor>,
): Promise<TimelineReply | null> => {
  const content = typeof obj.content === 'string' ? obj.content : null
  if (content == null) return null
  const objId = idOf(obj.id)
  if (objId == null || hostOf(objId) !== authorityHost) return null
  const actorUri = idOf(obj.attributedTo)
  if (actorUri == null || hostOf(actorUri) !== authorityHost) return null
  const author = await resolveAuthor(deps, budget, actorUri, authors)
  return {
    actor_uri: actorUri,
    content: sanitizeRemoteHtml(content),
    display_name: author?.display_name ?? null,
    handle: author?.handle ?? null,
    // The origin-checked canonical id, so a merge can tell one of OUR OWN
    // replies (already listed by the origin) from one we still have to add.
    object_uri: objId,
    published_at: isoOrNull(obj.published),
    url: httpsOnly(typeof obj.url === 'string' ? obj.url : objId),
  }
}

/**
 * Fetch up to {@link MAX_REPLIES} replies to the post at `objectUri`, oldest
 * first as the origin orders them.
 *
 * - `partial` — a budget (reply count, fetch count) ended the walk before the
 *   collection did.
 * - `fetched` — the origin's thread was actually READ. False when the post
 *   itself never loaded (unparseable id, fetch threw, non-JSON, budget gone) or
 *   when it declared a `replies` collection we couldn't resolve. An empty list
 *   with `fetched: false` means "unknown", not "no replies" (#1065) — the two
 *   read very differently to a person.
 */
export const fetchRemoteReplies = async (
  objectUri: string,
  deps: RemoteRepliesDeps = realRemoteRepliesDeps,
): Promise<{ fetched: boolean; partial: boolean; replies: TimelineReply[] }> => {
  const budget: Budget = { exhausted: false, fetches: 0 }
  const authors = new Map<string, { display_name: string | null; handle: string | null }>()
  const replies: TimelineReply[] = []

  const postHost = hostOf(objectUri)
  if (postHost == null) return { fetched: false, partial: false, replies }
  const post = await budgetedFetch(deps, budget, objectUri)
  if (!isRecord(post)) return { fetched: false, partial: budget.exhausted, replies }

  // A post that declares no `replies` collection HAS been read — it simply has
  // no thread to walk. One that declares one we can't resolve has not.
  let ctx: PageCtx | null = null
  let fetched = true
  if (post.replies != null) {
    ctx = await resolveFirstPage(deps, budget, post, postHost)
    fetched = ctx != null
  }
  while (ctx != null && replies.length < MAX_REPLIES) {
    await collectPageReplies(deps, budget, ctx, authors, replies)
    if (replies.length >= MAX_REPLIES || ctx.page.next == null) break
    ctx = await resolvePage(deps, budget, ctx.page.next, ctx.host)
  }
  const partial = budget.exhausted || replies.length >= MAX_REPLIES
  return { fetched, partial, replies }
}

/**
 * The collection's first item-bearing page: `replies` is an inline Collection
 * or a URI, whose items may sit directly on it or behind a `first` page.
 */
const resolveFirstPage = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  post: JsonRecord,
  postHost: string,
): Promise<PageCtx | null> => {
  const collection = await resolvePage(deps, budget, post.replies, postHost)
  if (collection == null) return null
  const hasItems = collection.page.items != null || collection.page.orderedItems != null
  return hasItems || collection.page.first == null
    ? collection
    : await resolvePage(deps, budget, collection.page.first, collection.host)
}

/** Append this page's resolvable replies (inline or URI-referenced) up to the cap. */
const collectPageReplies = async (
  deps: RemoteRepliesDeps,
  budget: Budget,
  ctx: PageCtx,
  authors: Map<string, ReplyAuthor>,
  replies: TimelineReply[],
): Promise<void> => {
  const rawItems = ctx.page.orderedItems ?? ctx.page.items
  const items = Array.isArray(rawItems) ? rawItems : []
  for (const item of items) {
    if (replies.length >= MAX_REPLIES) return
    // An inline item is held to the page's serving host; a URI item to its own.
    const resolved = await resolvePage(deps, budget, item, ctx.host)
    if (resolved == null) continue
    const reply = await toReply(deps, budget, resolved.page, resolved.host, authors)
    if (reply != null) replies.push(reply)
  }
}
