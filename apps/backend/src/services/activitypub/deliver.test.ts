import type { ArticleContent } from '@aurboda/api-spec'

import { Delete, Mention, Note, Person, Tombstone } from '@fedify/fedify/vocab'
import { describe, expect, test, vi } from 'vitest'

import {
  buildArticleNote,
  buildArticleNoteCreate,
  buildChallengeNote,
  buildChallengeNoteCreate,
  buildFeedDelete,
  buildReplyNote,
  buildReplyNoteCreate,
  challengeMentions,
  type DeliverableArticle,
  type DeliverableChallenge,
  type DeliverablePost,
  type DeliverableReply,
  deliverFeedChallengePost,
  deliverFeedDelete,
  deliverFeedReplyPost,
  type FeedDeliveryDeps,
  imageAttachments,
  recipients,
  toDeliverableReply,
} from './deliver.ts'
import { createFeedFederation } from './federation.ts'

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const followers = new URL('https://aurboda.net/users/fiddur/followers')

const hrefs = (urls: URL[]) => urls.map((u) => u.href)

describe('recipients', () => {
  test('public → Public in to, followers in cc', () => {
    const { to, cc } = recipients('public', followers)
    expect(hrefs(to)).toEqual([PUBLIC])
    expect(hrefs(cc)).toEqual([followers.href])
  })

  test('unlisted → followers in to, Public in cc', () => {
    const { to, cc } = recipients('unlisted', followers)
    expect(hrefs(to)).toEqual([followers.href])
    expect(hrefs(cc)).toEqual([PUBLIC])
  })

  test('followers → followers only, never Public', () => {
    const { to, cc } = recipients('followers', followers)
    expect(hrefs(to)).toEqual([followers.href])
    expect(cc).toEqual([])
  })
})

describe('buildFeedDelete', () => {
  const ORIGIN = 'https://aurboda.example'
  const deliverablePost = (visibility: DeliverablePost['visibility']): DeliverablePost => ({
    created_at: new Date('2026-07-01T00:00:00Z'),
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    image_token: 'secret-token',
    include_chart: false,
    include_map: false,
    included_metrics: [],
    series_metrics: [],
    updated_at: new Date('2026-07-01T00:00:00Z'),
    visibility,
  })

  // No DB: builds a Fedify context off the federation's registered dispatchers
  // (URL builders only), so the Delete/Tombstone shape is unit-testable.
  const contextFor = () => createFeedFederation(ORIGIN, `${ORIGIN}/api`).createContext(new URL(ORIGIN))

  test('wraps a Tombstone at the post object id, addressed by visibility', async () => {
    const ctx = await contextFor()
    const post = deliverablePost('public')
    const del = buildFeedDelete(ctx, 'fiddur', post)

    const noteId = `${ORIGIN}/users/fiddur/feed/${post.id}`
    expect(del.actorId?.href).toBe(`${ORIGIN}/users/fiddur`)
    expect(del.id?.href).toBe(`${noteId}#delete`)

    const object = await del.getObject()
    expect(object).toBeInstanceOf(Tombstone)
    expect(object?.id?.href).toBe(noteId)

    expect(hrefs([...del.toIds])).toContain(PUBLIC)
    expect(hrefs([...del.ccIds])).toContain(`${ORIGIN}/users/fiddur/followers`)
  })

  test('addresses a followers-only delete to followers, never Public', async () => {
    const ctx = await contextFor()
    const del = buildFeedDelete(ctx, 'fiddur', deliverablePost('followers'))
    expect(hrefs([...del.toIds])).toEqual([`${ORIGIN}/users/fiddur/followers`])
    expect([...del.ccIds]).toEqual([])
  })
})

describe('imageAttachments', () => {
  const apiBaseUrl = 'https://aurboda.example/api'
  const POST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const base = `https://aurboda.example/api/public/fiddur/feed/${POST_ID}`
  const post = (overrides: Partial<DeliverablePost>): DeliverablePost => ({
    created_at: new Date('2026-07-01T00:00:00Z'),
    id: POST_ID,
    image_token: 'secret-token',
    include_chart: false,
    include_map: false,
    included_metrics: [],
    series_metrics: [],
    updated_at: new Date('2026-07-01T00:00:00Z'),
    visibility: 'public',
    ...overrides,
  })

  test('attaches only the opted-in images, at the public endpoints (no token for public)', () => {
    const chartOnly = imageAttachments(apiBaseUrl, 'fiddur', post({ include_chart: true }))
    expect(chartOnly.map((a) => a.url?.href)).toEqual([`${base}/chart.png`])

    const both = imageAttachments(apiBaseUrl, 'fiddur', post({ include_chart: true, include_map: true }))
    expect(both.map((a) => a.url?.href)).toEqual([`${base}/chart.png`, `${base}/route.png`])
  })

  test('attaches unlisted images without a token', () => {
    const atts = imageAttachments(apiBaseUrl, 'fiddur', post({ include_chart: true, visibility: 'unlisted' }))
    expect(atts.map((a) => a.url?.href)).toEqual([`${base}/chart.png`])
  })

  test('attaches followers-only images carrying the capability token (#893)', () => {
    const atts = imageAttachments(
      apiBaseUrl,
      'fiddur',
      post({ include_chart: true, include_map: true, visibility: 'followers' }),
    )
    expect(atts.map((a) => a.url?.href)).toEqual([
      `${base}/chart.png?token=secret-token`,
      `${base}/route.png?token=secret-token`,
    ])
  })

  test('attaches nothing when neither flag is set', () => {
    expect(imageAttachments(apiBaseUrl, 'fiddur', post({}))).toEqual([])
  })
})

describe('article delivery', () => {
  const ORIGIN = 'https://aurboda.example'
  const POST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const articleContent: ArticleContent = {
    blocks: [
      { markdown: 'I slept **better** after cutting caffeine.', type: 'prose' },
      {
        caption: 'HR',
        end: '2026-07-02T00:00:00Z',
        metric: 'heart_rate',
        start: '2026-07-01T00:00:00Z',
        type: 'chart',
      },
    ],
    title: 'Caffeine & sleep',
  }
  const deliverableArticle = (visibility: DeliverableArticle['visibility']): DeliverableArticle => ({
    article: articleContent,
    created_at: new Date('2026-07-03T00:00:00Z'),
    id: POST_ID,
    image_token: 'secret-token',
    updated_at: new Date('2026-07-04T09:00:00Z'),
    visibility,
  })

  const contextFor = () => createFeedFederation(ORIGIN, `${ORIGIN}/api`).createContext(new URL(ORIGIN))
  // An article's Note shares the standard Note object id (a post is an article OR
  // an activity, never both), so a deleted article tombstones there like any post.
  const noteId = `${ORIGIN}/users/fiddur/feed/${POST_ID}`
  // Attachments are embedded Image objects, iterated (not URL refs in attachmentIds).
  const countAttachments = async (object: Note): Promise<number> => {
    let n = 0
    for await (const _ of object.getAttachments()) n++
    return n
  }

  test('buildArticleNote is a Note with title, prose HTML, one attachment per chart block', async () => {
    const ctx = await contextFor()
    const object = buildArticleNote(ctx, 'fiddur', deliverableArticle('public'), `${ORIGIN}/api`)
    // A Note (not an AS2 Article) — Mastodon discards Article content, so a Note is
    // what renders the prose + images inline.
    expect(object).toBeInstanceOf(Note)
    expect(object.id?.href).toBe(noteId)
    expect(object.name?.toString()).toBe('Caffeine & sleep')
    expect(object.content?.toString()).toContain('<strong>better</strong>')
    // One attachment for the single chart block; its URL/token logic is asserted
    // in article-object.test.ts.
    expect(await countAttachments(object)).toBe(1)
  })

  test('a followers-only article addresses followers, never Public', async () => {
    const ctx = await contextFor()
    const object = buildArticleNote(ctx, 'fiddur', deliverableArticle('followers'), `${ORIGIN}/api`)
    expect(hrefs([...object.toIds])).toEqual([`${ORIGIN}/users/fiddur/followers`])
    expect(hrefs([...object.ccIds])).toEqual([])
  })

  test('buildArticleNoteCreate wraps the Note in a Create at the #create fragment', async () => {
    const ctx = await contextFor()
    const create = buildArticleNoteCreate(ctx, 'fiddur', deliverableArticle('public'), `${ORIGIN}/api`)
    expect(create.id?.href).toBe(`${noteId}#create`)
    expect(create.actorId?.href).toBe(`${ORIGIN}/users/fiddur`)
    const object = await create.getObject()
    expect(object).toBeInstanceOf(Note)
    expect(object?.id?.href).toBe(noteId)
  })
})

describe('buildChallengeNote / buildChallengeNoteCreate', () => {
  const ORIGIN = 'https://aurboda.example'
  const contextFor = () => createFeedFederation(ORIGIN, `${ORIGIN}/api`).createContext(new URL(ORIGIN))

  const deliverableChallenge = (
    visibility: DeliverableChallenge['visibility'],
    message: string | null = 'Join me — **daily**!',
  ): DeliverableChallenge => ({
    challenge: { name: 'August 10k', url: `${ORIGIN}/u/fiddur/august-10k` },
    created_at: new Date('2026-08-01T00:00:00Z'),
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    message,
    updated_at: new Date('2026-08-01T00:00:00Z'),
    visibility,
  })

  test('is a Note at the canonical post id with name + note + link content', async () => {
    const ctx = await contextFor()
    const post = deliverableChallenge('public')
    const note = buildChallengeNote(ctx, 'fiddur', post)

    const noteId = `${ORIGIN}/users/fiddur/feed/${post.id}`
    expect(note).toBeInstanceOf(Note)
    expect(note.id?.href).toBe(noteId)
    expect(note.name).toBe('August 10k')
    expect(note.content?.toString()).toContain('<p><strong>August 10k</strong></p>')
    expect(note.content?.toString()).toContain('<strong>daily</strong>')
    expect(note.content?.toString()).toContain(`${ORIGIN}/u/fiddur/august-10k`)
    expect(hrefs([...note.toIds])).toContain(PUBLIC)
  })

  test('the Create wraps the Note with a distinct #create id, addressed by visibility', async () => {
    const ctx = await contextFor()
    const post = deliverableChallenge('followers', null)
    const create = buildChallengeNoteCreate(ctx, 'fiddur', post)
    expect(create.id?.href).toBe(`${ORIGIN}/users/fiddur/feed/${post.id}#create`)
    expect(hrefs([...create.toIds])).toEqual([`${ORIGIN}/users/fiddur/followers`])
    expect([...create.ccIds]).toEqual([])
    const object = await create.getObject()
    expect(object).toBeInstanceOf(Note)
  })

  test('an invitation carries no Mention tags', async () => {
    const ctx = await contextFor()
    const note = buildChallengeNote(ctx, 'fiddur', deliverableChallenge('public'))
    expect(note.tagIds).toEqual([])
    const tags = []
    for await (const tag of note.getTags()) tags.push(tag)
    expect(tags).toEqual([])
  })

  test('a completion post tags every winner with a Mention and addresses them in cc', async () => {
    const ctx = await contextFor()
    const post: DeliverableChallenge = {
      ...deliverableChallenge('public', null),
      challenge: {
        name: 'August 10k',
        result: {
          member_count: 3,
          podium: [
            {
              display_name: 'alice',
              identity_base_url: 'https://other.example/u/alice',
              rank: 1,
              total: 300,
            },
            { display_name: 'bob', identity_base_url: `${ORIGIN}/u/bob`, rank: 1, total: 300 },
            { display_name: 'carol', identity_base_url: `${ORIGIN}/u/carol`, rank: 3, total: 10 },
          ],
          unit: 'steps',
        },
        url: `${ORIGIN}/u/fiddur/august-10k`,
      },
    }
    expect(challengeMentions(post.challenge)).toEqual([
      { actorUri: new URL('https://other.example/users/alice'), handle: '@alice@other.example' },
      { actorUri: new URL(`${ORIGIN}/users/bob`), handle: '@bob@aurboda.example' },
    ])

    const note = buildChallengeNote(ctx, 'fiddur', post)
    const mentions: { href: string | undefined; name: string | undefined }[] = []
    for await (const tag of note.getTags()) {
      expect(tag).toBeInstanceOf(Mention)
      if (tag instanceof Mention) mentions.push({ href: tag.href?.href, name: tag.name?.toString() })
    }
    expect(mentions).toEqual([
      { href: 'https://other.example/users/alice', name: '@alice@other.example' },
      { href: `${ORIGIN}/users/bob`, name: '@bob@aurboda.example' },
    ])
    // Public: to Public, cc followers + both winners (the runner-up is not addressed).
    expect(hrefs([...note.toIds])).toEqual([PUBLIC])
    expect(hrefs([...note.ccIds])).toEqual([
      `${ORIGIN}/users/fiddur/followers`,
      'https://other.example/users/alice',
      `${ORIGIN}/users/bob`,
    ])
    expect(note.content?.toString()).toContain('has finished! 🏁')
    expect(note.content?.toString()).toContain('class="u-url mention"')

    const create = buildChallengeNoteCreate(ctx, 'fiddur', post)
    expect(hrefs([...create.ccIds])).toContain('https://other.example/users/alice')
  })
})

describe('completion-post fan-out to tagged winners (#1074, #1079)', () => {
  const ORIGIN = 'https://aurboda.example'
  const WINNER_ACTOR = 'https://peer.example/users/rival'
  const completion = (): DeliverableChallenge => ({
    challenge: {
      name: 'August 10k',
      result: {
        member_count: 2,
        podium: [
          { display_name: 'rival', identity_base_url: 'https://peer.example/u/rival', rank: 1, total: 42 },
          { display_name: 'fiddur', identity_base_url: `${ORIGIN}/u/fiddur`, rank: 2, total: 10 },
        ],
        unit: 'km',
      },
      url: `${ORIGIN}/u/fiddur/august-10k`,
    },
    created_at: new Date('2026-08-01T00:00:00Z'),
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    message: null,
    updated_at: new Date('2026-08-01T00:00:00Z'),
    visibility: 'public',
  })

  const fakeDeps = async (overrides: { lookupObject?: unknown; sendActivity?: unknown } = {}) => {
    const ctx = await createFeedFederation(ORIGIN, `${ORIGIN}/api`).createContext(new URL(ORIGIN))
    const sendActivity = vi.fn().mockResolvedValue(undefined)
    const lookupObject = vi.fn().mockResolvedValue(new Person({ id: new URL(WINNER_ACTOR) }))
    Object.assign(ctx, { lookupObject, sendActivity, ...overrides })
    const deps: FeedDeliveryDeps = {
      apiBaseUrl: `${ORIGIN}/api`,
      federation: { createContext: async () => ctx } as unknown as FeedDeliveryDeps['federation'],
      origin: ORIGIN,
    }
    return { deps, lookupObject, sendActivity }
  }

  const sentTo = (sendActivity: ReturnType<typeof vi.fn>) =>
    sendActivity.mock.calls.map(([, recipient]) =>
      typeof recipient === 'string' ? recipient : recipient.id?.href,
    )

  test('the Delete of a completion post reaches followers and each tagged winner', async () => {
    const { deps, sendActivity } = await fakeDeps()
    const post = completion()
    await deliverFeedDelete(deps, 'fiddur', {
      challenge: post.challenge,
      created_at: post.created_at,
      id: post.id,
      image_token: 'tok',
      include_chart: false,
      include_map: false,
      included_metrics: [],
      series_metrics: [],
      updated_at: post.updated_at,
      visibility: 'public',
    })
    expect(sentTo(sendActivity).sort()).toEqual(['followers', WINNER_ACTOR])
    for (const [, , activity] of sendActivity.mock.calls) expect(activity).toBeInstanceOf(Delete)
  })

  test('a plain post’s Delete goes to followers only', async () => {
    const { deps, sendActivity, lookupObject } = await fakeDeps()
    await deliverFeedDelete(deps, 'fiddur', {
      created_at: new Date(),
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      image_token: 'tok',
      include_chart: false,
      include_map: false,
      included_metrics: [],
      series_metrics: [],
      updated_at: new Date(),
      visibility: 'public',
    })
    expect(sentTo(sendActivity)).toEqual(['followers'])
    expect(lookupObject).not.toHaveBeenCalled()
  })

  test('a dead follower inbox no longer cancels the winner delivery, and still surfaces', async () => {
    const sendActivity = vi.fn(async (_sender: unknown, recipient: unknown) => {
      if (recipient === 'followers') throw new Error('connect ECONNREFUSED')
    })
    const { deps } = await fakeDeps({ sendActivity })
    await expect(deliverFeedChallengePost(deps, 'fiddur', completion())).rejects.toThrow('ECONNREFUSED')
    expect(sentTo(sendActivity).sort()).toEqual(['followers', WINNER_ACTOR])
  })

  test('an unresolvable winner is skipped with a warning instead of silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, sendActivity } = await fakeDeps({ lookupObject: vi.fn().mockResolvedValue(null) })
    await deliverFeedChallengePost(deps, 'fiddur', completion())
    expect(sentTo(sendActivity)).toEqual(['followers'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('actor not resolvable'))
    warn.mockRestore()
  })
})

describe('buildReplyNote / buildReplyNoteCreate', () => {
  const ORIGIN = 'https://aurboda.example'
  const TARGET = 'https://mastodon.example/users/alice/statuses/9'
  const TARGET_ACTOR = 'https://mastodon.example/users/alice'
  const contextFor = () => createFeedFederation(ORIGIN, `${ORIGIN}/api`).createContext(new URL(ORIGIN))

  const deliverableReply = (
    visibility: DeliverableReply['visibility'] = 'unlisted',
    over: Partial<DeliverableReply> = {},
  ): DeliverableReply => ({
    created_at: new Date('2026-09-01T00:00:00Z'),
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    in_reply_to_actor_uri: TARGET_ACTOR,
    in_reply_to_handle: '@alice@mastodon.example',
    in_reply_to_uri: TARGET,
    message: 'Nice **run**!',
    updated_at: new Date('2026-09-01T00:00:00Z'),
    visibility,
    ...over,
  })

  test('is a Note at the canonical post id, inReplyTo the target, mention + prose content', async () => {
    const ctx = await contextFor()
    const post = deliverableReply()
    const note = buildReplyNote(ctx, 'fiddur', post)

    const noteId = `${ORIGIN}/users/fiddur/feed/${post.id}`
    expect(note).toBeInstanceOf(Note)
    expect(note.id?.href).toBe(noteId)
    expect(note.url?.href).toBe(noteId)
    expect(hrefs([...note.replyTargetIds])).toEqual([TARGET])
    const content = note.content?.toString() ?? ''
    expect(content).toContain(`<a href="${TARGET_ACTOR}" class="u-url mention">@alice@mastodon.example</a>`)
    expect(content).toContain('<strong>run</strong>')
    // Unlisted: followers in `to`, Public in `cc` — plus the mentioned author.
    expect(hrefs([...note.toIds])).toEqual([`${ORIGIN}/users/fiddur/followers`])
    expect(hrefs([...note.ccIds])).toContain(TARGET_ACTOR)
  })

  test('tags the replied-to author with a Mention naming their handle', async () => {
    const ctx = await contextFor()
    const note = buildReplyNote(ctx, 'fiddur', deliverableReply())
    const tags = []
    for await (const tag of note.getTags()) tags.push(tag)
    expect(tags).toHaveLength(1)
    const mention = tags[0]
    expect(mention).toBeInstanceOf(Mention)
    expect(mention instanceof Mention ? mention.href?.href : null).toBe(TARGET_ACTOR)
    expect(mention instanceof Mention ? mention.name?.toString() : null).toBe('@alice@mastodon.example')
  })

  test('falls back to a handle derived from the actor URI when none was snapshotted', async () => {
    const ctx = await contextFor()
    const note = buildReplyNote(ctx, 'fiddur', deliverableReply('unlisted', { in_reply_to_handle: null }))
    expect(note.content?.toString()).toContain('@alice@mastodon.example')
  })

  test('the Create wraps the Note with a distinct #create id and cc’s the author', async () => {
    const ctx = await contextFor()
    const post = deliverableReply('public')
    const create = buildReplyNoteCreate(ctx, 'fiddur', post)
    expect(create.id?.href).toBe(`${ORIGIN}/users/fiddur/feed/${post.id}#create`)
    expect(hrefs([...create.toIds])).toContain(PUBLIC)
    expect(hrefs([...create.ccIds])).toContain(TARGET_ACTOR)
    const object = await create.getObject()
    expect(object).toBeInstanceOf(Note)
  })

  test('a followers-only reply never addresses Public, but still reaches the author', async () => {
    const ctx = await contextFor()
    const note = buildReplyNote(ctx, 'fiddur', deliverableReply('followers'))
    expect(hrefs([...note.toIds])).not.toContain(PUBLIC)
    expect(hrefs([...note.ccIds])).toEqual([TARGET_ACTOR])
  })

  test('toDeliverableReply narrows only a reply post with a resolved target', () => {
    const base = {
      activity_id: null,
      article: null,
      autoshare_rule_id: null,
      challenge: null,
      created_at: new Date(),
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      image_token: 'tok',
      include_chart: false,
      include_map: false,
      included_metrics: [],
      in_reply_to_actor_uri: TARGET_ACTOR,
      in_reply_to_handle: '@alice@mastodon.example',
      in_reply_to_uri: TARGET,
      message: 'hi',
      series_metrics: [],
      updated_at: new Date(),
      visibility: 'unlisted' as const,
    }
    expect(toDeliverableReply({ ...base, kind: 'reply' })?.in_reply_to_uri).toBe(TARGET)
    expect(toDeliverableReply({ ...base, kind: 'activity' })).toBeNull()
    expect(toDeliverableReply({ ...base, in_reply_to_uri: null, kind: 'reply' })).toBeNull()
  })
})

describe('reply fan-out to the answered author (#1079 shape)', () => {
  const ORIGIN = 'https://aurboda.example'
  const TARGET_ACTOR = 'https://mastodon.example/users/alice'
  const reply = (): DeliverableReply => ({
    created_at: new Date('2026-09-01T00:00:00Z'),
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    in_reply_to_actor_uri: TARGET_ACTOR,
    in_reply_to_handle: '@alice@mastodon.example',
    in_reply_to_uri: 'https://mastodon.example/users/alice/statuses/9',
    message: 'hi',
    updated_at: new Date('2026-09-01T00:00:00Z'),
    visibility: 'unlisted',
  })

  const fakeDeps = async (overrides: { lookupObject?: unknown; sendActivity?: unknown } = {}) => {
    const ctx = await createFeedFederation(ORIGIN, `${ORIGIN}/api`).createContext(new URL(ORIGIN))
    const sendActivity = vi.fn().mockResolvedValue(undefined)
    const lookupObject = vi.fn().mockResolvedValue(new Person({ id: new URL(TARGET_ACTOR) }))
    Object.assign(ctx, { lookupObject, sendActivity, ...overrides })
    const deps: FeedDeliveryDeps = {
      apiBaseUrl: `${ORIGIN}/api`,
      federation: { createContext: async () => ctx } as unknown as FeedDeliveryDeps['federation'],
      origin: ORIGIN,
    }
    return { deps, lookupObject, sendActivity }
  }

  const sentTo = (sendActivity: ReturnType<typeof vi.fn>) =>
    sendActivity.mock.calls.map(([, recipient]) =>
      typeof recipient === 'string' ? recipient : recipient.id?.href,
    )

  test('the Create reaches followers AND the author’s own inbox', async () => {
    const { deps, sendActivity } = await fakeDeps()
    await deliverFeedReplyPost(deps, 'fiddur', reply())
    expect(sentTo(sendActivity).sort()).toEqual(['followers', TARGET_ACTOR])
  })

  test('a dead follower inbox no longer cancels the author delivery, and still surfaces', async () => {
    const sendActivity = vi.fn(async (_sender: unknown, recipient: unknown) => {
      if (recipient === 'followers') throw new Error('connect ECONNREFUSED')
    })
    const { deps } = await fakeDeps({ sendActivity })
    await expect(deliverFeedReplyPost(deps, 'fiddur', reply())).rejects.toThrow('ECONNREFUSED')
    expect(sentTo(sendActivity).sort()).toEqual(['followers', TARGET_ACTOR])
  })

  test('the Delete of a reply is retracted from the author too', async () => {
    const { deps, sendActivity } = await fakeDeps()
    const post = reply()
    await deliverFeedDelete(deps, 'fiddur', {
      created_at: post.created_at,
      id: post.id,
      image_token: 'tok',
      in_reply_to_actor_uri: post.in_reply_to_actor_uri,
      in_reply_to_handle: post.in_reply_to_handle,
      include_chart: false,
      include_map: false,
      included_metrics: [],
      series_metrics: [],
      updated_at: post.updated_at,
      visibility: 'unlisted',
    })
    expect(sentTo(sendActivity).sort()).toEqual(['followers', TARGET_ACTOR])
    for (const [, , activity] of sendActivity.mock.calls) expect(activity).toBeInstanceOf(Delete)
  })
})
