/**
 * Express server entry point.
 *
 * Setup is split across helpers in `api/`:
 *   - middleware.ts  — audit log, auth, admin
 *   - auth-routes.ts — /version, /status, /signup, /login, /auth/token
 *   - oauth-routes.ts — Garmin / Strava / Oura connect+disconnect
 *   - sync-setup.ts  — `/sync` router wiring
 *   - webhooks-setup.ts — Strava + Oura push integrations
 *   - rest-routes.ts — per-domain REST router mounts
 *
 * This file orchestrates: clients, queues, central DB, auth, error handler,
 * server lifecycle.
 */
import { integrateFederation } from '@fedify/express'
import cors from 'cors'
import express, { json, type NextFunction, type Request, type Response } from 'express'
import { Client } from 'pg'

import type { FeedDeliver } from './routes/feed-router.ts'

import { registerAuthRoutes } from './api/auth-routes.ts'
import { gateFederation } from './api/federation-gate.ts'
import { createAdminMiddleware, createAuditLogMiddleware, createAuthMiddleware } from './api/middleware.ts'
import { registerOAuthRoutes } from './api/oauth-routes.ts'
import { mountRestRouters } from './api/rest-routes.ts'
import { mountSyncRouter } from './api/sync-setup.ts'
import { setupOuraWebhook, setupStravaWebhook } from './api/webhooks-setup.ts'
import { createAuth } from './auth.ts'
import {
  createChallengePost,
  deleteRuleActivities,
  emitTimelineNotify,
  getDeductionRulesByIds,
  getDetectedLocationById,
  getEnabledDeductionRules,
  getFeedTombstone,
  getNamedLocations,
  insertActivities,
  insertActivity,
  insertLocation,
  insertLocations,
  insertPlace,
  insertRawRecord,
  insertTimeSeries,
  listChallengesAwaitingResult,
  listReplyUncheckedEntries,
  listUnenrichedAurbodaEntries,
  getOAuthToken,
  listUserNames,
  loginToUserDb,
  markChallengeResultPublished,
  markEnrichTransientFailure,
  openTimelineChannel,
  resolveOrCreateActivityType,
  markTimelineEntryReplyChecked,
  setTimelineEntryReplyInfo,
  setTimelineEntryStructured,
  softDeleteSupersededLocations,
  updateDetectedLocation,
  upsertSyncState,
} from './db/index.ts'
import { httpError, isHttpError } from './http-error.ts'
import { garminClient } from './integrations/garmin/client.ts'
import { garminDataTypes } from './integrations/garmin/process.ts'
import { syncActivityDetails, syncGarminDataType } from './integrations/garmin/sync.ts'
import { gravlClient } from './integrations/gravl/client.ts'
import { enrichGravlWorkout } from './integrations/gravl/sync.ts'
import { ouraClient } from './integrations/oura/client.ts'
import { createOwnTracksRouter } from './integrations/owntracks/router.ts'
import { stravaClient } from './integrations/strava/client.ts'
import { createMcpRouter } from './mcp.ts'
import { createActorHtmlRouter } from './routes/actor-html-router.ts'
import { createFeedTombstoneRouter } from './routes/feed-tombstone-router.ts'
import { createOAuthRouter } from './routes/oauth-router.ts'
import {
  deliverFeedArticlePost,
  deliverFeedArticleUpdate,
  deliverFeedChallengePost,
  deliverFeedChallengeUpdate,
  deliverFeedDelete,
  deliverFeedPost,
  deliverFeedReplyPost,
  deliverFeedReplyUpdate,
  deliverFeedUpdate,
  toDeliverableArticle,
  toDeliverableChallenge,
  toDeliverableReply,
} from './services/activitypub/deliver.ts'
import { createFeedFederation, deliverActorUpdate } from './services/activitypub/federation.ts'
import { createTimelineBackfiller } from './services/activitypub/timeline-backfill.ts'
import { createAurbodaEnrichAttempt } from './services/activitypub/timeline-enrich.ts'
import { auditError, auditInfo } from './services/audit-log.ts'
import { createAutoshareDeps } from './services/autoshare-deps.ts'
import { type AutoshareQueue, createAutoshareQueue } from './services/autoshare-queue.ts'
import { evaluateAutoshareWindow } from './services/autoshare.ts'
import { triggerCalorieComputation } from './services/calorie-computation.ts'
import { createCalorieQueue, type CalorieQueue } from './services/calorie-queue.ts'
import { getCentralDb, initializeCentralDb } from './services/central-db.ts'
import { createChallengeDiscovery, defaultChallengeDiscoveryDeps } from './services/challenge-discovery.ts'
import { createChallengeResultsQueue } from './services/challenge-results-queue.ts'
import { publishFinishedChallengeResults } from './services/challenge-results.ts'
import { getChallengeStandings } from './services/challenge-standings.ts'
import { createDefaultEngineDeps } from './services/deduction-deps.ts'
import { buildFullWindow, evaluateAllRules } from './services/deduction-engine.ts'
import {
  type ActivityNotifier,
  createDeductionQueue,
  type DeductionQueue,
} from './services/deduction-queue.ts'
import { createDetectionTrigger, type DetectionTrigger } from './services/detection-trigger.ts'
import { runDetectionForUser } from './services/detection-worker.ts'
import { createReactionActions } from './services/feed-reactions.ts'
import { expandFeedActivityWindow, resolveFeedActivity } from './services/feed.ts'
import {
  approveFollower,
  type FollowerActions,
  rejectFollower,
  serializeFollower,
} from './services/followers.ts'
import { type FollowActions, followActor, unfollowActor } from './services/following.ts'
import { createGeocodeQueue } from './services/geocode-queue.ts'
import { createInvitationAuth } from './services/invitation.ts'
import { getPlaceVisits } from './services/locations.ts'
import { createPgBoss } from './services/pg-boss.ts'
import { installProcessGuards } from './services/process-guards.ts'
import { safeFetchGet } from './services/safe-fetch.ts'
import { initSentry, Sentry } from './services/sentry.ts'
import { createSourceEnrichQueue, type SourceEnrichQueue } from './services/source-enrich-queue.ts'
import { createStravaQueue, type StravaQueue } from './services/strava-queue.ts'
import { createSyncProvider } from './services/sync-provider.ts'
import { createSyncScheduler } from './services/sync-scheduler.ts'
import { createTimelineHub } from './services/timeline-hub.ts'
import {
  backfillReplyLinks,
  type RetroEnrichTrigger,
  retroEnrichTimelineEntries,
} from './services/timeline-retro-enrich.ts'
import { createWebAuthnService } from './services/webauthn.ts'

/** Grace period for in-flight requests before sockets are forced closed. */
const SHUTDOWN_DRAIN_MS = 3000

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: string
    }
  }
}

// eslint-disable-next-line complexity -- server setup orchestration
const main = async () => {
  const unauthorized = httpError(401, 'Unauthorized')
  const forbidden = httpError(403, 'Forbidden')

  const sessionSecret = process.env.SESSION_SECRET ?? ''
  const auth = createAuth(sessionSecret)
  const invitationAuth = createInvitationAuth(sessionSecret)

  // Callbacks to run after httpd.listen() — for tasks that need the server to be reachable
  const postListenCallbacks: Array<() => Promise<void>> = []

  // Initialize central database (server settings, admins)
  await initializeCentralDb()
  const centralDb = getCentralDb()

  // Initialize Sentry as early as possible after centralDb is available.
  // DSN is read from server_settings (configured via Admin Settings).
  await initSentry(centralDb)

  const webHost = process.env.WEB_HOST ?? 'http://localhost:5173'
  const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000'
  console.info(`🌐 WEB_HOST=${webHost} API_BASE_URL=${apiBaseUrl}`)

  // Path to the built SPA index.html, so /u/* share pages can serve
  // crawler-visible <head> meta. In the Docker image nginx serves this same
  // file. Unset in local dev (vite serves /u/* directly).
  const webIndexPath = process.env.WEB_INDEX_PATH

  // WebAuthn / passkey configuration. The Relying Party ID must match the
  // origin the user's browser sees (i.e. the web host) — not the API host,
  // which can be on a different subdomain.
  const deriveHost = (url: string, label: string): string => {
    try {
      return new URL(url).hostname
    } catch {
      console.warn(
        `⚠️ Could not parse ${label}=${url} for WebAuthn RP ID; falling back to "localhost". ` +
          `Set WEBAUTHN_RP_ID explicitly to silence this.`,
      )
      return 'localhost'
    }
  }
  const rpID = process.env.WEBAUTHN_RP_ID ?? deriveHost(webHost, 'WEB_HOST')
  const rpName = process.env.WEBAUTHN_RP_NAME ?? 'Aurboda'
  const expectedOrigins = (process.env.WEBAUTHN_ORIGINS ?? webHost)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const webAuthn = createWebAuthnService({ expectedOrigins, rpID, rpName }, centralDb)
  console.info(`🔐 WebAuthn rpID=${rpID} origins=${expectedOrigins.join(',')}`)

  const androidPackageName = process.env.ANDROID_APP_PACKAGE ?? 'net.aurboda'
  const androidFingerprints = (process.env.ANDROID_APP_FINGERPRINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const wellKnown = {
    androidFingerprints,
    androidPackageName,
    apiBaseUrl,
    version: process.env.BUILD_SHA ?? 'dev',
  }

  // Migrate legacy OURA_CLIENT/OURA_SECRET env vars into server_settings if DB empty
  const envOuraClientId = process.env.OURA_CLIENT
  const envOuraClientSecret = process.env.OURA_SECRET
  if (envOuraClientId || envOuraClientSecret) {
    const [existingId, existingSecret] = await Promise.all([
      centralDb.getServerSetting('oura_client_id'),
      centralDb.getServerSetting('oura_client_secret'),
    ])
    if (!existingId && envOuraClientId) {
      await centralDb.setServerSetting('oura_client_id', envOuraClientId)
      console.info('Migrated OURA_CLIENT env → server_settings.oura_client_id')
    }
    if (!existingSecret && envOuraClientSecret) {
      await centralDb.setServerSetting('oura_client_secret', envOuraClientSecret)
      console.info('Migrated OURA_SECRET env → server_settings.oura_client_secret')
    }
    console.info('DEPRECATION: OURA_CLIENT/OURA_SECRET envs are deprecated. Use Admin Settings.')
  }

  const getOuraCredentials = async () => {
    const [clientId, clientSecret] = await Promise.all([
      centralDb.getServerSetting('oura_client_id'),
      centralDb.getServerSetting('oura_client_secret'),
    ])
    if (!clientId || !clientSecret) {
      throw new Error('Oura not configured — set credentials in Admin Settings')
    }
    return { clientId, clientSecret }
  }

  const oura = ouraClient(getOuraCredentials, apiBaseUrl, {
    onUserAuthenticated: (ouraUserId, username) => centralDb.upsertOuraUserMapping(ouraUserId, username),
  })

  // Create Garmin client (no server-side credentials needed - uses per-user session tokens)
  const garmin = garminClient()

  // Create Strava client with dynamic credentials (reads from DB on each request)
  const getStravaCredentials = async () => {
    const clientId = await centralDb.getServerSetting('strava_client_id')
    const clientSecret = await centralDb.getServerSetting('strava_client_secret')
    if (!clientId || !clientSecret) {
      throw new Error('Strava not configured — set credentials in Admin Settings')
    }
    return { clientId, clientSecret }
  }

  const strava = stravaClient(getStravaCredentials, apiBaseUrl, {
    onUserAuthenticated: (stravaAthleteId, username) =>
      centralDb.upsertStravaAthleteMapping(stravaAthleteId, username),
  })

  // Gravl: OAuth app is optional (admin setting); users can also paste a
  // personal token, so the client is always created and resolves per user.
  const getGravlCredentials = async () => {
    const clientId = await centralDb.getServerSetting('gravl_client_id')
    const clientSecret = await centralDb.getServerSetting('gravl_client_secret')
    return clientId && clientSecret ? { clientId, clientSecret } : null
  }
  const gravl = gravlClient(getGravlCredentials, apiBaseUrl)

  // Deduction queue is assigned once pg-boss is up (below). The notifier closes
  // over the variable, so it starts enqueuing as soon as the queue exists.
  let deductionQueue: DeductionQueue | null = null
  let autoshareQueue: AutoshareQueue | null = null
  const activityNotifier: ActivityNotifier = (user, activityType, start, end, sourceRuleId) => {
    deductionQueue?.enqueueEvaluation({
      activity_type: activityType,
      source_rule_id: sourceRuleId,
      user,
      window_end: end.toISOString(),
      window_start: start.toISOString(),
    })
    // Auto-share rules (#903) evaluate the same mutation windows, after a
    // stabilisation delay (the queue's startAfter). Fire-and-forget.
    void autoshareQueue?.enqueueEvaluation(user, start, end)
  }

  // Create sync provider for auto-syncing data before queries. onActivitySynced
  // lets background scrobble syncs trigger deduction rules (e.g. auto-tagging),
  // like the REST /sync routes — here fired only when a sync ingests new data.
  const syncProvider = createSyncProvider({
    garmin,
    getLastFmApiKey: () => centralDb.getLastFmApiKey(),
    gravl,
    oura,
    onActivitySynced: activityNotifier,
  })

  // Initialize shared pg-boss instance and job queues (before MCP mount)
  const boss = await createPgBoss()

  const engineDeps = createDefaultEngineDeps(activityNotifier)

  if (boss) {
    try {
      deductionQueue = await createDeductionQueue(boss, {
        buildFullWindow: (user) => buildFullWindow(user, engineDeps),
        deleteRuleActivities,
        engineDeps,
        evaluateAllRules,
        getDeductionRules: getDeductionRulesByIds,
        getEnabledRules: getEnabledDeductionRules,
      })
    } catch (error) {
      console.error('Failed to initialize deduction queue:', error)
    }
  }
  if (!deductionQueue) {
    console.warn('⚠️ Deduction auto-evaluation disabled - rules will only run on manual trigger')
  }

  // Initialize calorie computation queue (uses shared boss).
  // Without this, HR ingestion falls back to fire-and-forget which still
  // returns the response fast but loses the cross-instance batching.
  let calorieQueue: CalorieQueue | null = null
  if (boss) {
    try {
      calorieQueue = await createCalorieQueue(boss, { triggerCalorieComputation })
    } catch (error) {
      console.error('Failed to initialize calorie queue:', error)
    }
  }
  if (!calorieQueue) {
    console.warn('⚠️ Calorie queue disabled - HR ingestion will fire-and-forget computation')
  }

  // Initialize Strava queue (uses shared boss + strava client)
  let stravaQueue: StravaQueue | null = null
  if (boss) {
    try {
      stravaQueue = await createStravaQueue(boss, {
        getAccessToken: (user) => strava.getAccessToken(user),
        getActivity: (token, id) => strava.getActivity(token, id),
        getActivityStreams: (token, id) => strava.getActivityStreams(token, id),
        listActivities: (token, params) => strava.listActivities(token, params),
        processDeps: {
          auditInfo,
          insertActivity,
          insertLocations,
          insertRawRecord,
          insertTimeSeries,
          resolveOrCreateActivityType,
          softDeleteSupersededLocations,
        },
        updateSyncState: async (user, dataType, updates) => {
          await upsertSyncState(user, {
            data_type: dataType,
            provider: 'strava',
            status: (updates.status as 'idle' | 'syncing' | 'error' | 'rate_limited') ?? 'idle',
            error_message: updates.error_message as string | undefined,
            last_sync_time: updates.last_sync_time as Date | undefined,
          })
        },
      })
    } catch (error) {
      console.error('Failed to initialize Strava queue:', error)
    }
  }

  const httpd = express()

  const userDb = new Client({ database: 'postgres' })
  await userDb.connect()

  // CORS must come first for preflight requests
  httpd.use(cors({ origin: true }))

  // Mount OAuth endpoints BEFORE body-parser (uses its own parsers)
  httpd.use(createOAuthRouter({ centralDb, loginToUserDb, webHost }))

  // Live home-timeline updates: one in-process hub fans Postgres NOTIFY pings out
  // to a user's open SSE streams. Injected into the feed router (SSE endpoint) and
  // the federation ingest (which pings it when a new post is received).
  const timelineHub = createTimelineHub({ emit: emitTimelineNotify, openChannel: openTimelineChannel })
  const onNewTimelineEntry = (user: string) => {
    void timelineHub.notify(user).catch((err) => console.error(`⚠️ timeline notify failed for ${user}:`, err))
  }

  // ActivityPub federation object (one instance, shared by the actor mount, the
  // MCP feed tools, and the REST feed router). `feedDeliver` fans a shared post
  // out to followers, fire-and-forget, so it's identical whether a post is
  // created via MCP or REST.
  // On a follow being accepted, backfill the followee's recent public posts into
  // the follower's timeline (fire-and-forget, time-boxed). `backfill` is defined
  // just below and only invoked later (on an inbound Accept), so the forward
  // reference is safe.
  const feedFederation = createFeedFederation(
    webHost,
    apiBaseUrl,
    onNewTimelineEntry,
    (user, actorUri) => backfill(user, actorUri),
    wellKnown.version,
    async () => (await centralDb.getSignupMode()) === 'open',
  )
  const backfill = createTimelineBackfiller(feedFederation, webHost)
  const feedDeps = { apiBaseUrl, federation: feedFederation, origin: webHost }

  // Lazy retro-enrichment (#996): entries ingested before structured enrichment
  // shipped (or whose ingest-time enrichment failed transiently) get one more
  // attempt when the timeline is read. The `attempt` variant throws on transient
  // failures so those entries stay unstamped and retry later. One pass per user
  // at a time: a batch can outlive the web's 30s poll interval, and overlapping
  // passes would re-fetch the same candidates (#1014).
  const retroEnricher = createAurbodaEnrichAttempt(webHost)
  const retroInFlight = new Set<string>()
  const retroEnrichTimeline: RetroEnrichTrigger = (user) => {
    if (retroInFlight.has(user)) return
    retroInFlight.add(user)
    const structuredPass = retroEnrichTimelineEntries(user, {
      enrich: retroEnricher,
      listUnenriched: listUnenrichedAurbodaEntries,
      recordTransientFailure: markEnrichTransientFailure,
      save: setTimelineEntryStructured,
    })
    // Reply/Mention backfill for entries ingested before #1060 tracked them —
    // re-fetches a few objects per read so legacy replies stop rendering as
    // top-level cards.
    const replyPass = backfillReplyLinks(user, `${webHost.replace(/\/+$/, '')}/users/${user}`, {
      fetchObject: async (objectUri) =>
        (
          await safeFetchGet(objectUri, {
            headers: { Accept: 'application/activity+json, application/ld+json; q=0.9' },
          }).catch(() => null)
        )?.data ?? null,
      listUnchecked: listReplyUncheckedEntries,
      markChecked: markTimelineEntryReplyChecked,
      saveReplyInfo: setTimelineEntryReplyInfo,
    })
    void Promise.allSettled([structuredPass, replyPass])
      .then((results) => {
        for (const r of results) {
          if (r.status === 'rejected') {
            console.warn(`⚠️ timeline retro pass failed for ${user}:`, r.reason)
          }
        }
      })
      .finally(() => retroInFlight.delete(user))
  }
  const onDeliverError = (op: string, user: string, postId: string) => (err: unknown) =>
    console.error(`⚠️ feed ${op} delivery failed for ${user}/${postId}:`, err)
  const feedDeliver: FeedDeliver = {
    // Expand the already-resolved activity to its merged span so the delivered
    // Note reports what the user shared, not just the anchor sub-activity (#881).
    created: (user, post, activity) => {
      void (async () => {
        const resolved = await expandFeedActivityWindow(user, activity)
        await deliverFeedPost(feedDeps, user, post, resolved)
      })().catch(onDeliverError('create', user, post.id))
    },
    // Articles and activities share the Note object id, so a deleted post of
    // either kind tombstones there — one path.
    deleted: (user, post) => {
      void deliverFeedDelete(feedDeps, user, post).catch(onDeliverError('delete', user, post.id))
    },
    // Resolve the (merged-span) activity inside the fire-and-forget boundary so a
    // lookup failure never bubbles into the (already-committed) edit's response.
    updated: (user, post) => {
      void (async () => {
        if (!post.activity_id) return
        const activity = await resolveFeedActivity(user, post.activity_id)
        if (activity) await deliverFeedUpdate(feedDeps, user, post, activity)
      })().catch(onDeliverError('update', user, post.id))
    },
    // Articles fan out as a Create{Note}/Update{Note} built purely from stored
    // content (no activity to resolve). Best-effort, same as the activity path.
    createdArticle: (user, post) => {
      const article = toDeliverableArticle(post)
      if (article) {
        void deliverFeedArticlePost(feedDeps, user, article).catch(onDeliverError('create', user, post.id))
      }
    },
    updatedArticle: (user, post) => {
      const article = toDeliverableArticle(post)
      if (article) {
        void deliverFeedArticleUpdate(feedDeps, user, article).catch(onDeliverError('update', user, post.id))
      }
    },
    // Challenge invitations federate like articles: a self-contained Note (#994).
    createdChallenge: (user, post) => {
      const challenge = toDeliverableChallenge(post)
      if (challenge) {
        void deliverFeedChallengePost(feedDeps, user, challenge).catch(
          onDeliverError('create', user, post.id),
        )
      }
    },
    updatedChallenge: (user, post) => {
      const challenge = toDeliverableChallenge(post)
      if (challenge) {
        void deliverFeedChallengeUpdate(feedDeps, user, challenge).catch(
          onDeliverError('update', user, post.id),
        )
      }
    },
    // A reply federates like a challenge share — a self-contained Note — but
    // additionally to the inbox of the author it answers, who need not follow us.
    createdReply: (user, post) => {
      const reply = toDeliverableReply(post)
      if (reply) {
        void deliverFeedReplyPost(feedDeps, user, reply).catch(onDeliverError('create', user, post.id))
      }
    },
    updatedReply: (user, post) => {
      const reply = toDeliverableReply(post)
      if (reply) {
        void deliverFeedReplyUpdate(feedDeps, user, reply).catch(onDeliverError('update', user, post.id))
      }
    },
  }
  // Auto-share rules (#903): evaluate settled activities against enabled rules
  // after a stabilisation delay, publishing matches through the SAME
  // feedDeliver.created fan-out a manual share fires. The deps double as the
  // preview deps for the REST router and MCP tools.
  const autoshareDeps = createAutoshareDeps(feedDeliver.created)
  if (boss) {
    try {
      autoshareQueue = await createAutoshareQueue(boss, {
        evaluateWindow: (user, start, end) => evaluateAutoshareWindow(user, start, end, autoshareDeps),
      })
    } catch (error) {
      console.error('Failed to initialize auto-share queue:', error)
    }
  }
  if (!autoshareQueue) {
    console.warn('⚠️ Auto-share evaluation disabled (no job queue)')
  }
  // Source enrichment (#1080): a Health Connect session from Garmin or Gravl
  // triggers that provider's own sync for it, so the row Health Connect just
  // created gets its sets / detail within minutes instead of at the next poll.
  let sourceEnrichQueue: SourceEnrichQueue | null = null
  if (boss) {
    try {
      sourceEnrichQueue = await createSourceEnrichQueue(boss, {
        enrichGravl: (user, workoutId) => enrichGravlWorkout(user, gravl, workoutId),
        isGarminConnected: async (user) => {
          const token = await getOAuthToken(user, 'garmin')
          return token !== null && token.access_token !== ''
        },
        isGravlConnected: async (user) => (await gravl.connectionKind(user)) !== null,
        onEnriched: (user) => activityNotifier(user, '*', new Date(Date.now() - 86_400_000), new Date()),
        syncGarmin: async (user, dataType) => {
          await syncGarminDataType(user, garmin, dataType)
          if (dataType === 'activities') await syncActivityDetails(user, garmin)
        },
      })
    } catch (error) {
      console.error('Failed to initialize source enrichment queue:', error)
    }
  }
  if (!sourceEnrichQueue) {
    console.warn(
      '⚠️ Source enrichment disabled (no job queue) - Health Connect arrivals wait for the next poll',
    )
  }

  // Background polling (#1042): every 5 minutes, sync whatever each user's
  // `sync_intervals` says is due, through the same sync provider queries use.
  if (boss) {
    try {
      await createSyncScheduler(boss, {
        garminDataTypes,
        listUsers: () => listUserNames(userDb),
        sync: syncProvider,
      })
    } catch (error) {
      console.error('Failed to initialize sync scheduler:', error)
    }
  }

  // Challenge completion: a scheduled sweep over every user's hosted challenges
  // that closed (grace period ago) posts the final standings — winners tagged —
  // to the host's feed through the SAME challenge fan-out a manual share uses.
  if (boss) {
    try {
      await createChallengeResultsQueue(boss, {
        sweep: () =>
          publishFinishedChallengeResults({
            claim: markChallengeResultPublished,
            createPost: createChallengePost,
            deliver: feedDeliver.createdChallenge,
            listAwaiting: listChallengesAwaitingResult,
            listUsers: () => listUserNames(userDb),
            standings: (user, challenge) => getChallengeStandings(user, challenge, { refresh: true }),
            webHost,
          }),
      })
    } catch (error) {
      console.error('Failed to initialize challenge result sweep:', error)
    }
  } else {
    console.warn('⚠️ Challenge winner announcements disabled (no job queue)')
  }

  // The network-requiring follow operations, bound to the same federation +
  // origin, shared by the REST following router and the MCP follow tools.
  const followActions: FollowActions = {
    follow: (user, handle) => followActor(feedDeps, user, handle),
    unfollow: (user, id) => unfollowActor(feedDeps, user, id),
  }
  // Outbound likes ⭐ / boosts 🔄 on the home timeline, on the same federation +
  // origin, shared by the REST feed router and the MCP reaction tools.
  const reactionActions = createReactionActions(feedDeps, feedDeliver)
  // The follower-management operations (approve/reject a follow request), sharing
  // the same federation + origin. Approve returns the serialised follower.
  const followerActions: FollowerActions = {
    approve: async (user, id) => {
      const record = await approveFollower(feedDeps, user, id)
      return record ? serializeFollower(record) : null
    },
    reject: (user, id) => rejectFollower(feedDeps, user, id),
  }

  // Open challenges from followed peers, shared by REST and MCP. One instance
  // so the per-instance well-known memo is shared too.
  const discoverChallenges = createChallengeDiscovery(defaultChallengeDiscoveryDeps(webHost))

  // Mount MCP server BEFORE body-parser (MCP SDK needs raw body)
  // Stateless mode — no session tracking needed (tools only, no subscriptions)
  httpd.use(
    '/mcp',
    createMcpRouter(auth, {
      apiBaseUrl,
      autosharePreviewDeps: autoshareDeps,
      centralDb,
      deductionQueue: deductionQueue ?? undefined,
      discoverChallenges,
      engineDeps,
      feedDeliver,
      followActions,
      followerActions,
      garmin,
      gravl,
      onActivityMutated: activityNotifier,
      oura,
      reactionActions,
      retroEnrichTimeline,
      stravaQueue: stravaQueue ?? undefined,
      sync: syncProvider,
      webHost,
    }),
  )

  // ActivityPub federation (actor + WebFinger). Mounted BEFORE the JSON body
  // parser so Fedify owns the raw body of signed inbox POSTs. `gateFederation`
  // restricts it to federation-owned paths: `integrateFederation` otherwise
  // wraps EVERY non-GET body with `Readable.toWeb(req)` and next()s without
  // consuming it, hanging `express.json()` on any large non-federation POST
  // (e.g. a Health Connect batch > ~64 KB). `trust proxy` lets Fedify
  // reconstruct the external https URL from nginx's X-Forwarded-* headers.
  // Scope it to `loopback`: nginx proxies to the backend over loopback
  // (proxy_pass http://127.0.0.1:3000), so Express trusts X-Forwarded-* only when
  // the immediate peer is loopback — a direct remote client isn't, so it can't
  // spoof them.
  httpd.set('trust proxy', 'loopback')
  httpd.use(gateFederation(integrateFederation(feedFederation, () => undefined)))

  // `410 Gone` Tombstone for dereferenced deleted objects. Mounted right after
  // the federation integration: when the object dispatcher returns null for a
  // since-deleted post, `@fedify/express` calls next(), and this catches it.
  httpd.use(createFeedTombstoneRouter({ getTombstone: getFeedTombstone, origin: webHost }))

  // Browser-facing actor URLs (#1047): Fedify answers 406 to `Accept: text/html`
  // via the same next() fall-through, and this redirects humans to /u/:username.
  httpd.use(createActorHtmlRouter({ origin: webHost }))

  httpd.use(json({ limit: '10mb' }))

  // Audit-log middleware: records non-GET requests with response status / body
  httpd.use(createAuditLogMiddleware(auth))

  const authMiddleware = createAuthMiddleware(auth, unauthorized)
  const adminMiddleware = createAdminMiddleware(centralDb, unauthorized, forbidden)

  // Auth-related routes (version, status, signup, login, /auth/token)
  registerAuthRoutes({
    httpd,
    auth,
    authMiddleware,
    centralDb,
    invitationAuth,
    userDb,
    unauthorized,
  })

  // /sync router (cross-provider sync orchestration)
  mountSyncRouter({
    httpd,
    authMiddleware,
    centralDb,
    oura,
    garmin,
    gravl,
    stravaQueue,
    calorieQueue,
    sourceEnrichQueue,
    activityNotifier,
  })

  // Per-provider OAuth/connect endpoints
  registerOAuthRoutes({
    httpd,
    authMiddleware,
    centralDb,
    garmin,
    gravl,
    oura,
    strava,
  })

  // Strava webhook push integration
  if (stravaQueue) {
    const ensureStravaWebhook = setupStravaWebhook({
      httpd,
      apiBaseUrl,
      sessionSecret,
      centralDb,
      stravaQueue,
      getStravaCredentials,
    })
    postListenCallbacks.push(ensureStravaWebhook)
  }

  // Oura webhook push integration (admin-configurable via Web UI)
  const ouraWebhookManager = await setupOuraWebhook({
    httpd,
    apiBaseUrl,
    centralDb,
    oura,
    getOuraCredentials,
  })

  // Initialize geocode queue (uses shared boss)
  let geocodeQueue: Awaited<ReturnType<typeof createGeocodeQueue>> | null = null
  if (boss) {
    try {
      geocodeQueue = await createGeocodeQueue(boss, { updateDetectedLocation })
    } catch (error) {
      console.error('Failed to initialize geocode queue:', error)
    }
  }
  if (!geocodeQueue) {
    console.warn('⚠️ Geocoding disabled - detected locations will not be reverse geocoded')
  }

  // Create detection trigger with geocode queue. The proactive
  // location_visit materialization piggy-backs on this same debounced
  // post-GPS-ingestion path (see #654).
  const detectionTrigger: DetectionTrigger = createDetectionTrigger({
    geocodeQueue,
    getDetectedLocationById,
    getNamedLocations,
    getPlaceVisits,
    insertActivities,
    runDetectionForUser,
  })

  httpd.use(
    '/ownTracks',
    createOwnTracksRouter({
      insertLocation,
      insertPlace,
      loginToUserDb,
      onLocationInserted: detectionTrigger.triggerDetectionForUser,
    }),
  )

  // Per-domain REST routers
  mountRestRouters({
    activityNotifier,
    autosharePreviewDeps: autoshareDeps,
    adminMiddleware,
    apiBaseUrl,
    auth,
    authMiddleware,
    centralDb,
    deductionQueue,
    discoverChallenges,
    engineDeps,
    feedDeliver,
    followActions,
    followerActions,
    garmin,
    httpd,
    invitationAuth,
    // Tell followers' servers the profile changed — they cache the avatar and
    // re-download only on an Update{Person} or a changed icon URL.
    onAvatarChanged: (user) => {
      deliverActorUpdate(feedDeps, user).catch((error) =>
        console.warn(`⚠️ actor Update delivery failed for ${user}:`, error),
      )
    },
    ouraWebhookManager,
    reactionActions,
    retroEnrichTimeline,
    syncProvider,
    timelineHub,
    userDb,
    webAuthn,
    webHost,
    webIndexPath,
    wellKnown,
  })

  // Sentry must be registered AFTER all controllers and BEFORE any other
  // error middleware. No-op if Sentry was not initialized.
  Sentry.setupExpressErrorHandler(httpd)

  // Centralized error handler
  httpd.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const status = isHttpError(err) ? err.status : 500
    if (status >= 500) console.error(err)

    if (req.user) {
      auditError(req.user, 'system', `${req.method} ${req.path}: ${err.message}`, {
        status,
        ...(status >= 500 && { stack: err.stack }),
      })
    }

    res.status(status).json({ success: false, error: err.message })
  })

  // Server startup
  const port = Number(process.env.PORT ?? 80)
  const server = httpd.listen(port, () => {
    console.info(`> Running on localhost:${port}`)
    for (const cb of postListenCallbacks) {
      cb().catch((error) => {
        console.error('⚠️ Post-listen task failed:', error)
        Sentry.captureException(error)
      })
    }
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.info('Shutting down...')
    detectionTrigger.clearPendingDetections()
    if (ouraWebhookManager) {
      ouraWebhookManager.shutdown()
    }
    if (boss) {
      await boss.stop()
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
      // `server.close` waits for every connection to end. Drop idle keep-alive
      // sockets straight away, then give in-flight requests a moment to finish
      // before forcing the rest: `/timeline/stream` is an indefinite
      // text/event-stream, so it never ends on its own and one open timeline tab
      // would keep the callback above pending forever. Forcing everything at
      // once instead would ECONNRESET a sync POST mid-response.
      //
      // This mostly helps local SIGINT and direct `node` runs. In the container
      // `entrypoint.sh`'s trap kills the backend and exits PID 1 immediately, so
      // Docker tears the process down before a graceful drain can finish either
      // way.
      server.closeIdleConnections()
      setTimeout(() => server.closeAllConnections(), SHUTDOWN_DRAIN_MS).unref()
    })
    console.info('Server closed')
    process.exit(0)
  }

  // Wrapped rather than passed directly: `shutdown` is async, so a rejecting
  // `boss.stop()` or `server.close()` would skip its `process.exit(0)` and leave
  // the process alive until Docker's SIGKILL timeout.
  //
  // Guarded against re-entry, which the drain above makes reachable: a second
  // Ctrl-C during those 3 seconds would call `server.close()` on an
  // already-closing server, get `ERR_SERVER_NOT_RUNNING`, and abort the drain
  // with a failure exit code.
  let shuttingDown = false
  const onSignal = () => {
    if (shuttingDown) return
    shuttingDown = true
    void shutdown().catch((error) => {
      console.error('💥 Graceful shutdown failed:', error)
      process.exit(1)
    })
  }

  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
}

// Failures outside a request — see `services/process-guards.ts` for why the
// rejection and exception paths deliberately differ.
const { reportAndExit } = installProcessGuards({
  capture: (error, hint) => Sentry.captureException(error, hint),
  exit: (code) => process.exit(code),
  flush: (timeoutMs) => Sentry.flush(timeoutMs),
  log: (label, error) => console.error(label, error),
})

// Anchored explicitly rather than relying on the guards above: `main()` rejecting
// is caught here, so it never surfaces as an unhandled rejection.
//
// Note the Sentry capture only lands for failures *after* `initSentry` — which
// runs behind `initializeCentralDb`, because the DSN lives in that database. The
// classic crash-loop (Postgres unreachable, migration failure, bad credentials)
// therefore reports to the container log only. Alerting on those would need a
// DSN bootstrapped from an env var before the DB is touched.
main().catch((error) => reportAndExit('💥 Startup failed:', error))
