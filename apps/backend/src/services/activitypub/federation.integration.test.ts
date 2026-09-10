/**
 * Integration tests for the Fedify actor + WebFinger surface, exercised through
 * `federation.fetch` against a real per-user database (no Express/nginx needed).
 */
import { integrateFederation } from '@fedify/express'
import { Create, Follow, Note, Person, Update } from '@fedify/fedify/vocab'
import express from 'express'
import supertest from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { insertActivity } from '../../db/activities/index.ts'
import { getFeedFollowerByActor, upsertFeedFollower } from '../../db/feed-follower.ts'
import {
  getFeedFollowingByActor,
  markFeedFollowingAccepted,
  upsertFeedFollowing,
} from '../../db/feed-following.ts'
import {
  createArticlePost,
  createFeedPost,
  createReplyPost,
  deleteFeedPost,
  type FeedPostInput,
  getFeedTombstone,
  listPublicFeedPostsPage,
} from '../../db/feed.ts'
import { getProfileAvatarVersion, upsertProfileAvatar } from '../../db/profile-avatar.ts'
import { upsertUserSettings } from '../../db/settings.ts'
import { listTimelineEntries, upsertTimelineEntry } from '../../db/timeline.ts'
import { createFeedTombstoneRouter } from '../../routes/feed-tombstone-router.ts'
import { cleanTestDb, getTestUser, startTestDb, stopTestDb } from '../../test/db-test-helper.ts'
import { actorDocument, inboxContext } from '../../test/inbox-context.ts'
import { buildFeedUpdate } from './deliver.ts'
import {
  buildActorPerson,
  createFeedFederation,
  handleInboundCreate,
  handleInboundFollow,
  handleInboundUpdate,
} from './federation.ts'
import { dateToTemporalInstant } from './temporal-interop.ts'

const CONTAINER_TIMEOUT = 120_000
const ORIGIN = 'https://aurboda.example'

const insertExercise = (user: string): Promise<string> =>
  insertActivity(user, {
    activity_type: 'exercise',
    end_time: new Date('2026-07-01T07:11:00Z'),
    source: 'garmin',
    start_time: new Date('2026-07-01T06:30:00Z'),
    title: 'Morning run',
  })

const sharePost = (user: string, activityId: string, overrides: Partial<FeedPostInput> = {}) =>
  createFeedPost(user, {
    activity_id: activityId,
    include_chart: false,
    include_map: false,
    included_metrics: ['duration'],
    series_metrics: [],
    visibility: 'public',
    ...overrides,
  })

const notFound = () => new Response('nope', { status: 404 })
const fed = createFeedFederation(ORIGIN, `${ORIGIN}/api`)

const fetchAs2 = (path: string) =>
  fed.fetch(new Request(`${ORIGIN}${path}`, { headers: { Accept: 'application/activity+json' } }), {
    contextData: undefined,
    onNotFound: notFound,
    onNotAcceptable: notFound,
  })

describe('Feed federation actor + WebFinger', () => {
  beforeAll(async () => {
    await startTestDb()
  }, CONTAINER_TIMEOUT)

  afterAll(async () => {
    await stopTestDb()
  })

  beforeEach(async () => {
    await cleanTestDb()
  })

  test('serves an actor document with a published RSA public key', async () => {
    const user = getTestUser()
    const res = await fetchAs2(`/users/${user}`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, unknown>

    expect(doc.type).toBe('Person')
    expect(doc.id).toBe(`${ORIGIN}/users/${user}`)
    expect(doc.preferredUsername).toBe(user)
    expect(doc.inbox).toBe(`${ORIGIN}/users/${user}/inbox`)
    expect(doc.outbox).toBe(`${ORIGIN}/users/${user}/outbox`)
    expect(doc.followers).toBe(`${ORIGIN}/users/${user}/followers`)
    expect(doc.following).toBe(`${ORIGIN}/users/${user}/following`)
    expect(doc.publicKey).toBeDefined()
    // The published key is a PEM-encoded RSA public key.
    const publicKey = doc.publicKey as { owner?: string; publicKeyPem?: string }
    expect(publicKey.owner).toBe(`${ORIGIN}/users/${user}`)
    expect(publicKey.publicKeyPem).toContain('BEGIN PUBLIC KEY')
    // Default account is open — not a locked (manual-approval) account.
    expect(doc.manuallyApprovesFollowers).toBe(false)
    // Human-facing profile link, so clients send browsers to the SPA page
    // instead of the 406-answering actor document (#1047).
    expect(doc.url).toBe(`${ORIGIN}/u/${user}`)
  })

  test('versions the actor icon URL by the avatar upload time', async () => {
    const user = getTestUser()
    // No uploaded avatar: the deterministic identicon needs no version param.
    const before = await fetchAs2(`/users/${user}`)
    const beforeDoc = (await before.json()) as { icon: { url: string } }
    expect(beforeDoc.icon.url).toBe(`${ORIGIN}/u/${user}/avatar.png`)

    await upsertProfileAvatar(user, 'image/webp', Buffer.from('img'))
    const version = await getProfileAvatarVersion(user)
    const after = await fetchAs2(`/users/${user}`)
    const afterDoc = (await after.json()) as { icon: { url: string } }
    // Remote servers re-download an avatar only when its URL changes, so the
    // upload MUST change the URL (and each re-upload changes it again).
    expect(afterDoc.icon.url).toBe(`${ORIGIN}/u/${user}/avatar.png?v=${version?.getTime()}`)
  })

  test('buildActorPerson (the Update{Person} payload) matches the served actor document', async () => {
    const user = getTestUser()
    await upsertProfileAvatar(user, 'image/webp', Buffer.from('img'))
    const ctx = fed.createContext(new URL(ORIGIN), undefined)
    const person = await buildActorPerson(ctx, user, ORIGIN)
    expect(person?.id?.href).toBe(`${ORIGIN}/users/${user}`)
    const served = await fetchAs2(`/users/${user}`)
    const servedDoc = (await served.json()) as Record<string, unknown>
    const builtDoc = (await person!.toJsonLd({ format: 'compact' })) as Record<string, unknown>
    // The profile-change Update embeds exactly what the actor URL serves.
    expect(builtDoc).toEqual(servedDoc)
  })

  test('serves the NodeInfo JRD at /.well-known/nodeinfo (#1047)', async () => {
    const res = await fed.fetch(new Request(`${ORIGIN}/.well-known/nodeinfo`), {
      contextData: undefined,
      onNotAcceptable: notFound,
      onNotFound: notFound,
    })
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { links: { href: string; rel: string }[] }
    const link = doc.links.find((l) => l.rel === 'http://nodeinfo.diaspora.software/ns/schema/2.1')
    expect(link?.href).toBe(`${ORIGIN}/nodeinfo/2.1`)
  })

  test('serves NodeInfo 2.1 identifying the software (#1047)', async () => {
    const res = await fed.fetch(new Request(`${ORIGIN}/nodeinfo/2.1`), {
      contextData: undefined,
      onNotAcceptable: notFound,
      onNotFound: notFound,
    })
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, unknown>
    expect(doc.version).toBe('2.1')
    expect(doc.software).toMatchObject({ name: 'aurboda', version: 'dev' })
    expect(doc.protocols).toEqual(['activitypub'])
  })

  test('advertises manuallyApprovesFollowers when the user requires manual approval', async () => {
    const user = getTestUser()
    await upsertUserSettings(user, { manually_approve_followers: true })
    const res = await fetchAs2(`/users/${user}`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, unknown>
    expect(doc.manuallyApprovesFollowers).toBe(true)
  })

  test('builds https URLs from the canonical origin even when the request arrives over http', async () => {
    // Simulates a request reaching the backend over loopback http behind a
    // TLS-terminating proxy; the pinned origin must still yield https URLs
    // (Mastodon rejects http actors).
    const user = getTestUser()
    const res = await fed.fetch(
      new Request(`http://aurboda.example/users/${user}`, {
        headers: { Accept: 'application/activity+json' },
      }),
      { contextData: undefined, onNotAcceptable: notFound, onNotFound: notFound },
    )
    expect(res.status).toBe(200)
    const doc = (await res.json()) as Record<string, unknown>
    expect(doc.id).toBe(`https://aurboda.example/users/${user}`)
    expect(doc.inbox).toBe(`https://aurboda.example/users/${user}/inbox`)
  })

  test('resolves the actor via WebFinger by acct handle', async () => {
    const user = getTestUser()
    const res = await fed.fetch(
      new Request(`${ORIGIN}/.well-known/webfinger?resource=acct:${user}@aurboda.example`),
      { contextData: undefined, onNotFound: notFound, onNotAcceptable: notFound },
    )
    expect(res.status).toBe(200)
    const jrd = (await res.json()) as { subject: string; links: { rel: string; href?: string }[] }
    expect(jrd.subject).toBe(`acct:${user}@aurboda.example`)
    const self = jrd.links.find((l) => l.rel === 'self')
    expect(self?.href).toBe(`${ORIGIN}/users/${user}`)
  })

  test('404s the actor for an invalid username (never touches the database)', async () => {
    const res = await fetchAs2('/users/Invalid..Name')
    expect(res.status).toBe(404)
  })

  test('serves the followers collection from feed_follower (accepted only)', async () => {
    const user = getTestUser()
    await upsertFeedFollower(user, {
      accepted: true,
      actor_uri: 'https://mastodon.example/users/alice',
      inbox_uri: 'https://mastodon.example/users/alice/inbox',
      shared_inbox_uri: 'https://mastodon.example/inbox',
    })
    // A pending (unapproved) follower is excluded from the public collection + count.
    await upsertFeedFollower(user, {
      accepted: false,
      actor_uri: 'https://mastodon.example/users/pending',
      inbox_uri: 'https://mastodon.example/users/pending/inbox',
    })
    const res = await fetchAs2(`/users/${user}/followers`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { totalItems?: number; orderedItems?: string[] }
    expect(doc.totalItems).toBe(1)
    expect(doc.orderedItems).toContain('https://mastodon.example/users/alice')
    expect(doc.orderedItems).not.toContain('https://mastodon.example/users/pending')
  })

  test('serves the following collection with only accepted follows', async () => {
    const user = getTestUser()
    // One accepted, one still pending.
    await upsertFeedFollowing(user, {
      actor_uri: 'https://mastodon.example/users/carol',
      inbox_uri: 'https://mastodon.example/users/carol/inbox',
    })
    await markFeedFollowingAccepted(user, 'https://mastodon.example/users/carol')
    await upsertFeedFollowing(user, {
      actor_uri: 'https://remote.example/users/dave',
      inbox_uri: 'https://remote.example/users/dave/inbox',
    })

    const res = await fetchAs2(`/users/${user}/following`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { totalItems?: number; orderedItems?: string[] }
    // Only the accepted follow is published.
    expect(doc.totalItems).toBe(1)
    expect(doc.orderedItems).toContain('https://mastodon.example/users/carol')
    expect(doc.orderedItems).not.toContain('https://remote.example/users/dave')
  })

  test('serves a paginated outbox: root has totalItems + first page link, page has the Create', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId)

    // Root collection: totalItems + a `first` page link (items live on the page).
    const root = (await (await fetchAs2(`/users/${user}/outbox`)).json()) as {
      totalItems?: number
      first?: string
      orderedItems?: unknown[]
    }
    expect(root.totalItems).toBe(1)
    expect(root.first).toBe(`${ORIGIN}/users/${user}/outbox?cursor=0`)
    expect(root.orderedItems).toBeUndefined()

    // First page: the Create for the shared post.
    const page = (await (await fetchAs2(`/users/${user}/outbox?cursor=0`)).json()) as {
      orderedItems?: unknown[]
    }
    const items = page.orderedItems ?? []
    expect(items).toHaveLength(1)
    const create = items[0] as { type: string; object: string | { id: string; type: string } }
    expect(create.type).toBe('Create')
    const object = typeof create.object === 'string' ? { id: create.object, type: 'Note' } : create.object
    expect(object.id).toBe(`${ORIGIN}/users/${user}/feed/${post.id}`)
  })

  test('serves an individual public post object as a Note at its canonical id', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId)

    const res = await fetchAs2(`/users/${user}/feed/${post.id}`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as {
      type: string | string[]
      id: string
      attributedTo?: string
      published?: string
    }
    // Dual-typed Note-first: Mastodon renders the Note, QuantPub peers read the extension.
    expect(doc.type).toEqual(['Note', 'quant:Exercise'])
    expect(doc.id).toBe(`${ORIGIN}/users/${user}/feed/${post.id}`)
    expect(doc.attributedTo).toBe(`${ORIGIN}/users/${user}`)
    // `published` is the post's share time (created_at), not the fetch time, so
    // remote servers order it correctly.
    expect(doc.published).toBeDefined()
    expect(new Date(doc.published ?? '').getTime()).toBe(post.created_at.getTime())
  })

  test('a served post object carries the QuantPub extension (#896)', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId, {
      included_metrics: ['duration'],
      series_metrics: ['heart_rate'],
    })

    const doc = (await (await fetchAs2(`/users/${user}/feed/${post.id}`)).json()) as {
      '@context': unknown[]
      startTime?: string
      endTime?: string
      'quant:activityType'?: string
      'quant:metrics'?: { key: string; value: number; unit?: string }[]
      'quant:series'?: { metric: string; href: string; mediaType: string }[]
      'quant:structuredUrl'?: string
    }
    // The AS2 window is native (FEP reuses startTime/endTime), quant: terms ride the splice.
    expect(new Date(doc.startTime ?? '').toISOString()).toBe('2026-07-01T06:30:00.000Z')
    expect(new Date(doc.endTime ?? '').toISOString()).toBe('2026-07-01T07:11:00.000Z')
    expect(doc['quant:activityType']).toBe('exercise')
    expect(doc['quant:metrics']).toEqual([{ key: 'duration', unit: 'seconds', value: 2460 }])
    expect(doc['quant:structuredUrl']).toBe(`${ORIGIN}/api/public/${user}/feed/${post.id}`)
    const series = doc['quant:series'] ?? []
    expect(series).toHaveLength(1)
    expect(series[0].metric).toBe('heart_rate')
    expect(series[0].href).toContain(`${ORIGIN}/api/public/${user}/series?`)
    // The inline @context defines the quant prefix and the @json literal terms.
    expect(doc['@context']).toContainEqual({
      quant: 'https://w3id.org/quantpub#',
      'quant:metrics': { '@type': '@json' },
      'quant:series': { '@type': '@json' },
    })
  })

  test('a followers-only delivery Note carries the token on quant:structuredUrl but no series', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId, {
      included_metrics: ['duration'],
      series_metrics: ['heart_rate'],
      visibility: 'followers',
    })

    // A followers-only object never resolves publicly — build the delivered
    // Update directly (same Note builder as the delivered Create).
    const ctx = await fed.createContext(new URL(ORIGIN))
    const update = await buildFeedUpdate(
      ctx,
      user,
      post,
      {
        activity_type: 'exercise',
        end_time: new Date('2026-07-01T07:11:00Z'),
        start_time: new Date('2026-07-01T06:30:00Z'),
        title: 'Morning run',
      },
      `${ORIGIN}/api`,
    )
    const doc = (await update.toJsonLd({ format: 'compact' })) as {
      object?: { 'quant:structuredUrl'?: string; 'quant:series'?: unknown }
    }
    expect(doc.object?.['quant:structuredUrl']).toBe(
      `${ORIGIN}/api/public/${user}/feed/${post.id}?token=${post.image_token}`,
    )
    // The public /series endpoint would 404 a followers-only post, so no links.
    expect(doc.object?.['quant:series']).toBeUndefined()
  })

  test('federates an article as a Create{Note} in the outbox and serves its object (#937)', async () => {
    const user = getTestUser()
    const post = await createArticlePost(user, {
      article: {
        blocks: [
          { markdown: 'My **analysis**.', type: 'prose' },
          {
            caption: 'HR',
            end: '2026-07-02T00:00:00Z',
            metric: 'heart_rate',
            start: '2026-07-01T00:00:00Z',
            type: 'chart',
          },
        ],
        title: 'Weekly review',
      },
      visibility: 'public',
    })
    // An article federates as a Note at the standard post object id (Mastodon
    // discards Article content, so a Note is what renders the prose).
    const noteId = `${ORIGIN}/users/${user}/feed/${post.id}`

    const page = (await (await fetchAs2(`/users/${user}/outbox?cursor=0`)).json()) as {
      orderedItems?: unknown[]
    }
    const items = page.orderedItems ?? []
    expect(items).toHaveLength(1)
    const create = items[0] as { type: string; object: string | { id: string; type: string } }
    expect(create.type).toBe('Create')
    const object = typeof create.object === 'string' ? { id: create.object, type: '' } : create.object
    expect(object.id).toBe(noteId)

    // The object dispatcher serves the article as a Note: title in `name`, the
    // prose (rendered markdown) in `content` so Mastodon shows it.
    const res = await fetchAs2(`/users/${user}/feed/${post.id}`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { type: string; id: string; name?: string; content?: string }
    expect(doc.type).toBe('Note')
    expect(doc.id).toBe(noteId)
    expect(doc.name).toBe('Weekly review')
    // Title leads the content (Mastodon ignores a Note's name); prose follows.
    expect(doc.content).toContain('<strong>Weekly review</strong>')
    expect(doc.content).toContain('<strong>analysis</strong>')
  })

  test('federates a reply as a Create{Note inReplyTo} and serves its object', async () => {
    const user = getTestUser()
    const target = 'https://mastodon.example/users/alice/statuses/9'
    const targetActor = 'https://mastodon.example/users/alice'
    const post = await createReplyPost(user, {
      in_reply_to_actor_uri: targetActor,
      in_reply_to_handle: '@alice@mastodon.example',
      in_reply_to_uri: target,
      message: 'Nice **run**!',
      visibility: 'unlisted',
    })
    const noteId = `${ORIGIN}/users/${user}/feed/${post.id}`

    const page = (await (await fetchAs2(`/users/${user}/outbox?cursor=0`)).json()) as {
      orderedItems?: unknown[]
    }
    const create = (page.orderedItems ?? [])[0] as {
      type: string
      object: string | { id: string; inReplyTo?: string }
    }
    expect(create.type).toBe('Create')
    const object = typeof create.object === 'string' ? { id: create.object } : create.object
    expect(object.id).toBe(noteId)

    const res = await fetchAs2(`/users/${user}/feed/${post.id}`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as {
      type: string
      id: string
      content?: string
      inReplyTo?: string
      cc?: string | string[]
      tag?: unknown
    }
    expect(doc.type).toBe('Note')
    expect(doc.id).toBe(noteId)
    expect(doc.inReplyTo).toBe(target)
    expect(doc.content).toContain('class="u-url mention"')
    expect(doc.content).toContain('<strong>run</strong>')
    // The replied-to author is addressed AND tagged, so their server accepts and
    // links the reply even though they don't follow us.
    expect(JSON.stringify(doc.cc)).toContain(targetActor)
    const tags = Array.isArray(doc.tag) ? doc.tag : [doc.tag]
    expect(JSON.stringify(tags)).toContain('"Mention"')
    expect(JSON.stringify(tags)).toContain('@alice@mastodon.example')
  })

  test('the profile listing hides replies while the outbox still lists them', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const share = await sharePost(user, activityId)
    const reply = await createReplyPost(user, {
      in_reply_to_actor_uri: 'https://mastodon.example/users/alice',
      in_reply_to_handle: '@alice@mastodon.example',
      in_reply_to_uri: 'https://mastodon.example/users/alice/statuses/9',
      message: 'hi',
      visibility: 'public',
    })

    const page = (await (await fetchAs2(`/users/${user}/outbox?cursor=0`)).json()) as {
      orderedItems?: unknown[]
    }
    expect(page.orderedItems ?? []).toHaveLength(2)
    // The public-profile listing (feed-public-router) uses the same query with
    // `includeReplies: false`.
    const profile = await listPublicFeedPostsPage(user, 20, 0, { includeReplies: false })
    expect(profile.map((p) => p.id)).toEqual([share.id])
    expect(profile.map((p) => p.id)).not.toContain(reply.id)
  })

  test('serves the merged-span duration for a shared merged activity (#881)', async () => {
    const user = getTestUser()
    // Anchor 08:00–08:40 (40m) overlaps a second 08:20–09:00 → merged span is 1h.
    const anchorId = await insertActivity(user, {
      activity_type: 'exercise',
      end_time: new Date('2026-07-01T08:40:00Z'),
      source: 'garmin',
      start_time: new Date('2026-07-01T08:00:00Z'),
      title: 'Merged run',
    })
    await insertActivity(user, {
      activity_type: 'exercise',
      end_time: new Date('2026-07-01T09:00:00Z'),
      source: 'strava',
      start_time: new Date('2026-07-01T08:20:00Z'),
      title: 'Second half',
    })
    const post = await sharePost(user, anchorId) // included_metrics: ['duration']

    const doc = (await (await fetchAs2(`/users/${user}/feed/${post.id}`)).json()) as { content: string }
    // The served Note reports the merged span the user saw, not the 40m anchor slice.
    expect(doc.content).toContain('Duration 1h')
    expect(doc.content).not.toContain('40m')
  })

  test('excludes followers-only posts from the outbox and 404s their object', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId, { visibility: 'followers' })

    const outbox = (await (await fetchAs2(`/users/${user}/outbox`)).json()) as { totalItems?: number }
    expect(outbox.totalItems).toBe(0)
    const page = (await (await fetchAs2(`/users/${user}/outbox?cursor=0`)).json()) as {
      orderedItems?: unknown[]
    }
    expect(page.orderedItems ?? []).toHaveLength(0)

    const object = await fetchAs2(`/users/${user}/feed/${post.id}`)
    expect(object.status).toBe(404)
  })

  test('paginates the outbox past the page size', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    for (let i = 0; i < 21; i++) await sharePost(user, activityId)

    const page1 = (await (await fetchAs2(`/users/${user}/outbox?cursor=0`)).json()) as {
      orderedItems?: unknown[]
      next?: string
    }
    expect((page1.orderedItems ?? []).length).toBe(20)
    expect(page1.next).toBe(`${ORIGIN}/users/${user}/outbox?cursor=20`)

    const page2 = (await (await fetchAs2(`/users/${user}/outbox?cursor=20`)).json()) as {
      orderedItems?: unknown[]
      next?: string
    }
    expect((page2.orderedItems ?? []).length).toBe(1)
    expect(page2.next).toBeUndefined()
  })

  test('404s an outbox page with an out-of-range cursor (no DB error)', async () => {
    const user = getTestUser()
    const res = await fetchAs2(`/users/${user}/outbox?cursor=99999999999999999999`)
    expect(res.status).toBe(404)
  })

  test('404s a post object for a non-UUID id without touching the database', async () => {
    const user = getTestUser()
    const res = await fetchAs2(`/users/${user}/feed/not-a-uuid`)
    expect(res.status).toBe(404)
  })

  // The 410-Tombstone slice lives in an Express router mounted after the Fedify
  // integration; exercise the two together so the "dispatcher returns null →
  // @fedify/express next() → tombstone router" fall-through is covered.
  const buildFederatedApp = () => {
    const app = express()
    app.set('trust proxy', 'loopback')
    app.use(integrateFederation(fed, () => undefined))
    app.use(createFeedTombstoneRouter({ getTombstone: getFeedTombstone, origin: ORIGIN }))
    return app
  }

  const getObject = (app: express.Express, path: string) =>
    supertest(app).get(path).set('Accept', 'application/activity+json')

  test('serves a 410 Tombstone after a public post is deleted (Fedify falls through)', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId)
    const app = buildFederatedApp()

    // Live: the object dispatcher serves the Note (200).
    const live = await getObject(app, `/users/${user}/feed/${post.id}`)
    expect(live.status).toBe(200)

    // Unshare, then the same id returns 410 Gone with a Tombstone at the same id.
    await deleteFeedPost(user, post.id)
    const gone = await getObject(app, `/users/${user}/feed/${post.id}`)
    expect(gone.status).toBe(410)
    expect(gone.type).toBe('application/activity+json')
    expect(gone.body.type).toBe('Tombstone')
    expect(gone.body.id).toBe(`${ORIGIN}/users/${user}/feed/${post.id}`)
  })

  test('serves a 410 Tombstone after a public article is deleted (#937)', async () => {
    const user = getTestUser()
    const post = await createArticlePost(user, {
      article: { blocks: [{ markdown: 'Gone soon.', type: 'prose' }], title: 'Ephemeral' },
      visibility: 'public',
    })
    const app = buildFederatedApp()
    // An article's Note is served at the standard post object id.
    const notePath = `/users/${user}/feed/${post.id}`

    // Live: the object dispatcher serves the article as a Note (200).
    const live = await getObject(app, notePath)
    expect(live.status).toBe(200)
    expect(live.body.type).toBe('Note')

    // Unshare, then the same id returns 410 Gone with a Tombstone.
    await deleteFeedPost(user, post.id)
    const gone = await getObject(app, notePath)
    expect(gone.status).toBe(410)
    expect(gone.body.type).toBe('Tombstone')
    expect(gone.body.id).toBe(`${ORIGIN}/users/${user}/feed/${post.id}`)
  })

  test('a deleted followers-only object stays 404 (no public tombstone)', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId, { visibility: 'followers' })
    const app = buildFederatedApp()

    await deleteFeedPost(user, post.id)
    expect(await getFeedTombstone(user, post.id)).toBeNull()
    const res = await getObject(app, `/users/${user}/feed/${post.id}`)
    expect(res.status).toBe(404)
  })

  /**
   * Inbound paths that write a BYLINE from a sending actor (#1103, #1057). Each
   * activity carries an inlined `Person` claiming to be someone else under
   * Alice's real id — nothing may be read off it; the snapshot must come from
   * whatever her id actually serves (`inboxContext`'s stub loader).
   */
  describe('inbound actor presentation is never read off the activity', () => {
    const ALICE = 'https://mastodon.example/users/alice'
    /** Alice's id, wearing somebody else's name and username. */
    const forgedAlice = () =>
      new Person({
        id: new URL(ALICE),
        inbox: new URL(`${ALICE}/inbox`),
        name: 'Site Admin',
        preferredUsername: 'admin',
      })
    const aliceServes = (name = 'Alice') => ({ [ALICE]: actorDocument(ALICE, 'alice', name) })

    const followUs = (user: string) =>
      new Follow({
        actor: forgedAlice(),
        id: new URL(`${ALICE}#follows/1`),
        object: new URL(`${ORIGIN}/users/${user}`),
      })

    /** A stranger's reply to one of the owner's posts (the #1060 involvement branch). */
    const replyToOwnPost = (target: string) =>
      new Create({
        actor: forgedAlice(),
        id: new URL(`${ALICE}/statuses/5/activity`),
        object: new Note({
          attribution: new URL(ALICE),
          content: '<p>Nice run!</p>',
          id: new URL(`${ALICE}/statuses/5`),
          published: dateToTemporalInstant(new Date('2026-07-02T09:00:00Z')),
          replyTarget: new URL(target),
        }),
      })

    /** The reader's own post, as a reply target. */
    const ownPostUri = async (user: string) =>
      `${ORIGIN}/users/${user}/feed/${(await sharePost(user, await insertExercise(user))).id}`

    test('a Follow is recorded with the byline Alice’s own server serves', async () => {
      const user = getTestUser()
      // Manual approval, so the follow is recorded WITHOUT sending an Accept —
      // this test never touches the network.
      await upsertUserSettings(user, { manually_approve_followers: true })
      await handleInboundFollow(inboxContext(fed, ORIGIN, user, aliceServes()), followUs(user))

      const row = await getFeedFollowerByActor(user, ALICE)
      expect(row).toMatchObject({
        accepted: false,
        actor_uri: ALICE,
        display_name: 'Alice',
        handle: '@alice@mastodon.example',
      })
    })

    test('a Follow whose actor id serves nothing is still recorded, with no byline', async () => {
      const user = getTestUser()
      await upsertUserSettings(user, { manually_approve_followers: true })
      await handleInboundFollow(inboxContext(fed, ORIGIN, user), followUs(user))

      // The follow relationship is real and must not be lost — only the display
      // fields are unknown. The inbox is delivery addressing, not presentation.
      const row = await getFeedFollowerByActor(user, ALICE)
      expect(row).toMatchObject({
        actor_uri: ALICE,
        display_name: null,
        handle: null,
        inbox_uri: `${ALICE}/inbox`,
      })
    })

    test('a stranger’s reply is bylined from the served actor document', async () => {
      const user = getTestUser()
      const target = await ownPostUri(user)
      await handleInboundCreate(
        inboxContext(fed, ORIGIN, user, aliceServes()),
        replyToOwnPost(target),
        ORIGIN,
      )

      const entries = await listTimelineEntries(user, 10)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ display_name: 'Alice', handle: '@alice@mastodon.example' })
    })

    test('a stranger’s reply whose actor id serves nothing is dropped', async () => {
      const user = getTestUser()
      const target = await ownPostUri(user)
      // An anonymous stranger card is worse than no card: the branch exists to
      // show WHO replied.
      await handleInboundCreate(inboxContext(fed, ORIGIN, user), replyToOwnPost(target), ORIGIN)
      expect(await listTimelineEntries(user, 10)).toHaveLength(0)
    })

    /** Every cached copy of Alice: as followee, follower, post author and booster. */
    const cacheAlice = async (user: string) => {
      await upsertFeedFollowing(user, {
        actor_uri: ALICE,
        display_name: 'Alice',
        handle: '@alice@mastodon.example',
        inbox_uri: `${ALICE}/inbox`,
      })
      await markFeedFollowingAccepted(user, ALICE)
      await upsertFeedFollower(user, {
        accepted: true,
        actor_uri: ALICE,
        display_name: 'Alice',
        handle: '@alice@mastodon.example',
        inbox_uri: `${ALICE}/inbox`,
      })
      await upsertTimelineEntry(user, {
        actor_uri: ALICE,
        content: '<p>Alice’s post</p>',
        display_name: 'Alice',
        handle: '@alice@mastodon.example',
        object_uri: `${ALICE}/statuses/1`,
        published_at: new Date('2026-07-01T10:00:00Z'),
      })
      await upsertTimelineEntry(user, {
        actor_uri: 'https://third.example/users/carol',
        boost_of_uri: 'https://third.example/notes/1',
        boosted_by_actor_uri: ALICE,
        boosted_by_display_name: 'Alice',
        boosted_by_handle: '@alice@mastodon.example',
        content: '<p>Carol’s post</p>',
        object_uri: `${ALICE}/statuses/2/activity`,
        published_at: new Date('2026-07-01T11:00:00Z'),
      })
    }

    /** An `Update{Person}` from `actor`, embedding a claim we must never believe. */
    const actorUpdate = (actor: string, embeddedId: string) =>
      new Update({
        actor: new URL(actor),
        id: new URL(`${actor}#updates/1`),
        object: new Person({
          id: new URL(embeddedId),
          name: 'Impostor',
          preferredUsername: 'impostor',
        }),
      })

    test('an Update{Person} refreshes every cached copy of that actor (#1057)', async () => {
      const user = getTestUser()
      await cacheAlice(user)

      await handleInboundUpdate(
        inboxContext(fed, ORIGIN, user, aliceServes('Alice Renamed')),
        actorUpdate(ALICE, ALICE),
        ORIGIN,
      )

      expect((await getFeedFollowingByActor(user, ALICE))?.display_name).toBe('Alice Renamed')
      expect((await getFeedFollowerByActor(user, ALICE))?.display_name).toBe('Alice Renamed')
      const entries = await listTimelineEntries(user, 10)
      expect(entries.find((e) => e.actor_uri === ALICE)?.display_name).toBe('Alice Renamed')
      // The "🔄 X boosted" line is a cached copy of the same actor.
      expect(entries.find((e) => e.boosted_by_actor_uri === ALICE)?.boosted_by_display_name).toBe(
        'Alice Renamed',
      )
    })

    test('an Update{Person} describing a DIFFERENT actor than the signer is ignored', async () => {
      const user = getTestUser()
      await cacheAlice(user)

      // Mallory signs an Update of Alice's profile: the same-actor rule drops it
      // (and it is no Note either, so nothing is ingested).
      await handleInboundUpdate(
        inboxContext(fed, ORIGIN, user, aliceServes('Alice Renamed')),
        actorUpdate('https://evil.example/users/mallory', ALICE),
        ORIGIN,
      )

      expect((await getFeedFollowingByActor(user, ALICE))?.display_name).toBe('Alice')
    })
  })

  test('buildFeedUpdate wraps the post Note in an Update at the canonical object id', async () => {
    const user = getTestUser()
    const activityId = await insertExercise(user)
    const post = await sharePost(user, activityId)

    const ctx = await fed.createContext(new URL(ORIGIN))
    const update = await buildFeedUpdate(
      ctx,
      user,
      post,
      {
        activity_type: 'exercise',
        end_time: new Date('2026-07-01T07:11:00Z'),
        start_time: new Date('2026-07-01T06:30:00Z'),
        title: 'Morning run',
      },
      `${ORIGIN}/api`,
    )

    const noteId = `${ORIGIN}/users/${user}/feed/${post.id}`
    expect(update.id?.href).toBe(`${noteId}#update-${post.updated_at.getTime()}`)
    const object = await update.getObject()
    expect(object).toBeInstanceOf(Note)
    expect(object?.id?.href).toBe(noteId)
  })
})
