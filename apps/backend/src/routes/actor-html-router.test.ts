import express from 'express'
import supertest from 'supertest'
import { describe, expect, test } from 'vitest'

import { createActorHtmlRouter, prefersHtml } from './actor-html-router.ts'

/** Mounts the router with a fallback 404 so `next()` fall-through is observable. */
const buildApp = (origin = 'https://aurboda.net', users = ['fiddur']) => {
  const app = express()
  app.use(createActorHtmlRouter({ origin, userExists: async (username) => users.includes(username) }))
  app.use((_req, res) => res.status(404).json({ fellThrough: true }))
  return app
}

describe('prefersHtml', () => {
  test('true only when the request names an HTML type', () => {
    expect(prefersHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(true)
    expect(prefersHtml('text/html')).toBe(true)
    expect(prefersHtml('application/xhtml+xml')).toBe(true)
  })

  test('false for wildcards and a missing header (machine clients, #1051)', () => {
    // Fedify answers these with a 406; claiming them would hand a non-negotiating
    // client HTML it can't parse.
    expect(prefersHtml('*/*')).toBe(false)
    expect(prefersHtml('text/*')).toBe(false)
    expect(prefersHtml('application/*')).toBe(false)
    expect(prefersHtml(undefined)).toBe(false)
    expect(prefersHtml('')).toBe(false)
  })

  test('false when an ActivityPub type outranks HTML', () => {
    expect(prefersHtml('application/activity+json')).toBe(false)
    expect(prefersHtml('application/activity+json, text/html;q=0.1')).toBe(false)
    expect(prefersHtml('application/ld+json;profile="https://www.w3.org/ns/activitystreams"')).toBe(false)
    // Equal weight goes to the browser — that is what a real navigation sends.
    expect(prefersHtml('application/activity+json;q=0.5, text/html;q=0.5')).toBe(true)
    expect(prefersHtml('application/activity+json;q=0.5, text/html')).toBe(true)
  })

  test('an explicitly refused HTML type (q=0) is not a preference', () => {
    expect(prefersHtml('text/html;q=0')).toBe(false)
  })
})

describe('GET /users/:username (browser HTML fallback)', () => {
  test('redirects a browser to the public profile page, varying on Accept', async () => {
    const res = await supertest(buildApp())
      .get('/users/fiddur')
      .set('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://aurboda.net/u/fiddur')
    expect(res.headers.vary).toBe('Accept')
  })

  test('falls through for an ActivityPub Accept header (no redirect to HTML)', async () => {
    const res = await supertest(buildApp()).get('/users/fiddur').set('Accept', 'application/activity+json')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ fellThrough: true })
  })

  test('falls through for a wildcard Accept — Fedify answers those, not us (#1051)', async () => {
    const res = await supertest(buildApp()).get('/users/fiddur').set('Accept', '*/*')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ fellThrough: true })
  })

  test('falls through for an unknown user, so a nonexistent actor never soft-404s as HTML', async () => {
    const res = await supertest(buildApp()).get('/users/nosuchuser').set('Accept', 'text/html')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ fellThrough: true })
  })

  test('falls through for a malformed username', async () => {
    const res = await supertest(buildApp()).get('/users/Invalid..Name').set('Accept', 'text/html')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ fellThrough: true })
  })

  test('does not claim actor sub-resources like the outbox', async () => {
    const res = await supertest(buildApp()).get('/users/fiddur/outbox').set('Accept', 'text/html')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ fellThrough: true })
  })
})
