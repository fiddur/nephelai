/**
 * Browser-facing fallback for ActivityPub actor URLs (#1047).
 *
 * Handles: GET /users/:username with an HTML-preferring Accept header.
 *
 * Fedify's actor dispatcher content-negotiates: an ActivityPub client gets the
 * actor document, but a browser (`Accept: text/html`) makes `@fedify/express`
 * fall through (`next()`) and then answer `406 Not acceptable` — unless a later
 * Express route claims the request. This router — mounted right AFTER
 * `integrateFederation`, like the feed tombstone router — is that route: it
 * redirects a human clicking an actor link (e.g. from a Mastodon profile that
 * didn't use the actor's `url` property) to the public profile page the SPA
 * serves at `/u/:username`.
 *
 * Only a request that EXPLICITLY prefers HTML is claimed, and only for a user
 * that exists. Everything else falls through untouched — a non-negotiating
 * machine client (a wildcard `Accept`, or none at all) keeps getting Fedify's
 * `406`, and an unknown actor its plain `404`, rather than a 200 HTML page
 * (#1051).
 */
import { Router } from 'express'

import { isValidUsername } from '../api/auth-routes.ts'
import { buildProfileUrl } from '../services/share-urls.ts'

export interface ActorHtmlDeps {
  /** Canonical web origin, e.g. `https://aurboda.net` — the profile URL base. */
  origin: string
  /** Whether the account exists on this instance (unknown users must not redirect). */
  userExists: (username: string) => Promise<boolean>
}

/** The ActivityPub media types this router must never take a request away from. */
const AP_TYPES = ['application/activity+json', 'application/ld+json']
/** The media types a browser navigation names. */
const HTML_TYPES = ['text/html', 'application/xhtml+xml']

/** One `Accept` entry: its media type (lowercased) and quality weight. */
const parseAcceptEntry = (raw: string): { type: string; q: number } => {
  const [type, ...params] = raw.split(';').map((part) => part.trim())
  const qParam = params.find((param) => param.toLowerCase().startsWith('q='))
  const q = qParam == null ? 1 : Number(qParam.slice(2))
  return { q: Number.isFinite(q) ? q : 0, type: type.toLowerCase() }
}

/**
 * Whether the request EXPLICITLY asks for HTML: it names `text/html` or
 * `application/xhtml+xml` with a non-zero q, and no ActivityPub media type
 * outranks it. Wildcards never count — a full wildcard, `text` or `application`
 * wildcards, and a missing header are all machine clients as far as an actor URL
 * is concerned, and belong to the federation layer's own negotiation (#1051).
 */
export const prefersHtml = (acceptHeader: string | undefined): boolean => {
  if (acceptHeader == null || acceptHeader.trim() === '') return false
  const entries = acceptHeader.split(',').map(parseAcceptEntry)
  const best = (types: string[]): number =>
    entries.filter((entry) => types.includes(entry.type)).reduce((max, entry) => Math.max(max, entry.q), 0)
  const html = best(HTML_TYPES)
  return html > 0 && html >= best(AP_TYPES)
}

export const createActorHtmlRouter = (deps: ActorHtmlDeps): Router => {
  const router = Router()

  router.get('/users/:username', (req, res, next) => {
    const { username } = req.params
    if (!isValidUsername(username) || !prefersHtml(req.headers.accept)) return next()
    void deps
      .userExists(username)
      .then((exists) => {
        if (!exists) return next()
        // The answer depends on the Accept header, so a shared cache must not
        // serve this redirect to an ActivityPub client asking for the same URL.
        res.setHeader('Vary', 'Accept')
        res.redirect(302, buildProfileUrl(deps.origin, username))
      })
      .catch(next)
  })

  return router
}
