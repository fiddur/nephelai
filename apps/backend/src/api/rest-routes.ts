/**
 * Mounts the per-domain REST routers under the Express app. Each router lives
 * in `routes/` and is instantiated with the auth middleware (and any service
 * dependencies). The `activities` router additionally needs a Garmin
 * activity-detail fetcher that's plumbed in here.
 */
import type { Express } from 'express'
import type { Client } from 'pg'

import type { Auth } from '../auth.ts'
import type { GarminClient } from '../integrations/garmin/client.ts'
import type { AutoshareDeps } from '../services/autoshare.ts'
import type { CentralDb } from '../services/central-db.ts'
import type { DiscoverChallenges } from '../services/challenge-discovery.ts'
import type { DeductionEngineDeps } from '../services/deduction-engine.ts'
import type { ActivityNotifier, DeductionQueue } from '../services/deduction-queue.ts'
import type { ReactionActions } from '../services/feed-reactions.ts'
import type { FollowerActions } from '../services/followers.ts'
import type { FollowActions } from '../services/following.ts'
import type { InvitationAuth } from '../services/invitation.ts'
import type { OuraWebhookManager } from '../services/oura-webhook-manager.ts'
import type { SyncProvider } from '../services/queries/index.ts'
import type { TimelineHub } from '../services/timeline-hub.ts'
import type { RetroEnrichTrigger } from '../services/timeline-retro-enrich.ts'
import type { WebAuthnService } from '../services/webauthn.ts'
import type { AnyMiddleware } from '../typed-router.ts'

import { getFeedPostById, getLocations, getTimeSeries, markActivityDetailSynced } from '../db/index.ts'
import { processActivityDetail } from '../integrations/garmin/process.ts'
import { createActivitiesRouter } from '../routes/activities-router.ts'
import { createActivityTypesRouter } from '../routes/activity-types-router.ts'
import { createAdminRouter } from '../routes/admin-router.ts'
import { createAuditLogRouter } from '../routes/audit-log-router.ts'
import { createAutoshareRulesRouter } from '../routes/autoshare-rules-router.ts'
import { createChallengeDataRouter } from '../routes/challenge-data-router.ts'
import { createChallengesRouter } from '../routes/challenges-router.ts'
import { createChartDataRouter } from '../routes/chart-data-router.ts'
import { createCorrelationsRouter } from '../routes/correlations-router.ts'
import { createDashboardRouter } from '../routes/dashboard-router.ts'
import { createDeductionRulesRouter } from '../routes/deduction-rules-router.ts'
import { createFeedFollowersRouter } from '../routes/feed-followers-router.ts'
import { createFeedFollowingRouter } from '../routes/feed-following-router.ts'
import { createFeedImageRouter } from '../routes/feed-image-router.ts'
import { createFeedPublicRouter } from '../routes/feed-public-router.ts'
import { createFeedRouter, type FeedDeliver } from '../routes/feed-router.ts'
import { createFoodItemsRouter } from '../routes/food-items-router.ts'
import { createIconsRouter } from '../routes/icons-router.ts'
import { createImportsRouter } from '../routes/imports-router.ts'
import { createLocationsRouter } from '../routes/locations-router.ts'
import { createMealsRouter } from '../routes/meals-router.ts'
import { createMetricsRouter } from '../routes/metrics-router.ts'
import { createNotesRouter } from '../routes/notes-router.ts'
import { createNutrientRecommendationsRouter } from '../routes/nutrient-recommendations-router.ts'
import { createOEmbedRouter } from '../routes/oembed-router.ts'
import { createOgImageRouter } from '../routes/og-image-router.ts'
import { createProductivityRouter } from '../routes/productivity-router.ts'
import { createProfileRouter } from '../routes/profile-router.ts'
import { createPublicAvatarRouter } from '../routes/public-avatar-router.ts'
import { createPublicSharesRouter } from '../routes/public-shares-router.ts'
import { createRawRecordsRouter } from '../routes/raw-records-router.ts'
import { createReportsRouter } from '../routes/reports-router.ts'
import { createScreentimeCategoriesRouter } from '../routes/screentime-categories-router.ts'
import { createSensitivityFlagsRouter } from '../routes/sensitivity-flags-router.ts'
import { createSettingsRouter } from '../routes/settings-router.ts'
import { createShareHtmlRouter, createShareResolvers } from '../routes/share-html-router.ts'
import { createSharedDashboardsRouter } from '../routes/shared-dashboards-router.ts'
import { createTrainingLoadRouter } from '../routes/training-load-router.ts'
import { createTrendsRouter } from '../routes/trends-router.ts'
import { createWebAuthnRouter } from '../routes/webauthn-router.ts'
import { createWellKnownRouter, type WellKnownConfig } from '../routes/well-known-router.ts'
import { renderChartPng, renderRoutePng, renderScatterPng } from '../services/activitypub/feed-images.ts'
import { fetchOsmTile } from '../services/activitypub/osm-tiles.ts'
import { getArticleChartSeriesData, getArticleCorrelationScatter } from '../services/article-block-data.ts'
import { loadAvatarDataUri } from '../services/avatar-resolve.ts'
import { buildChartSvg } from '../services/charts/chart-svg.ts'
import { buildScatterSvg } from '../services/charts/scatter-svg.ts'
import { resolveFeedActivity } from '../services/feed.ts'
import { createOgImageRenderer } from '../services/og-image.ts'
import { createTemplateLoader } from '../services/web-template.ts'

interface RestRoutesDeps {
  httpd: Express
  authMiddleware: AnyMiddleware
  adminMiddleware: AnyMiddleware
  centralDb: CentralDb
  invitationAuth: InvitationAuth
  webHost: string
  webIndexPath: string | undefined
  apiBaseUrl: string
  /** Open challenges from followed peers (`GET /challenges/discover`). */
  discoverChallenges: DiscoverChallenges
  garmin: GarminClient
  syncProvider: SyncProvider
  activityNotifier: ActivityNotifier
  engineDeps: DeductionEngineDeps
  deductionQueue: DeductionQueue | null
  ouraWebhookManager: OuraWebhookManager
  auth: Auth
  webAuthn: WebAuthnService
  wellKnown: WellKnownConfig
  userDb: Client
  feedDeliver: FeedDeliver
  followActions: FollowActions
  followerActions: FollowerActions
  /** Outbound like ⭐ / boost 🔄 toggles for the home timeline. */
  reactionActions: ReactionActions
  timelineHub: TimelineHub
  retroEnrichTimeline: RetroEnrichTrigger
  /** Fire-and-forget: federate an `Update{Person}` after an avatar change. */
  onAvatarChanged: (user: string) => void
  /** Merge-group/window resolution behind the auto-share rule preview (#903). */
  autosharePreviewDeps: Pick<
    AutoshareDeps,
    'listCandidates' | 'getGroup' | 'resolveWindow' | 'distanceMeters'
  >
}

export const mountRestRouters = ({
  httpd,
  authMiddleware,
  adminMiddleware,
  centralDb,
  invitationAuth,
  webHost,
  webIndexPath,
  apiBaseUrl,
  discoverChallenges,
  garmin,
  syncProvider,
  activityNotifier,
  engineDeps,
  deductionQueue,
  autosharePreviewDeps,
  feedDeliver,
  followActions,
  followerActions,
  reactionActions,
  onAvatarChanged,
  retroEnrichTimeline,
  timelineHub,
  ouraWebhookManager,
  auth,
  webAuthn,
  wellKnown,
  userDb,
}: RestRoutesDeps): void => {
  httpd.use(createMetricsRouter(authMiddleware, syncProvider))
  httpd.use('/icons', createIconsRouter(authMiddleware))
  httpd.use('/notes', createNotesRouter(authMiddleware))
  httpd.use('/meals', createMealsRouter(authMiddleware))
  httpd.use('/food-items', createFoodItemsRouter(authMiddleware, centralDb))
  httpd.use('/sensitivity-flags', createSensitivityFlagsRouter(authMiddleware))
  httpd.use('/nutrient-recommendations', createNutrientRecommendationsRouter(authMiddleware))
  httpd.use('/admin/imports', createImportsRouter(authMiddleware, adminMiddleware, centralDb))
  httpd.use('/reports', createReportsRouter(authMiddleware))
  httpd.use(
    createActivitiesRouter(
      authMiddleware,
      syncProvider,
      activityNotifier,
      async (user, activityId, garminActivityId, activitySpan) => {
        const detail = await garmin.getActivityDetail(user, garminActivityId)
        const points = await processActivityDetail(user, detail, { activitySpan })
        await markActivityDetailSynced(user, activityId)
        return points
      },
    ),
  )
  httpd.use('/productivity', createProductivityRouter(authMiddleware, syncProvider))
  httpd.use('/activity-types', createActivityTypesRouter(authMiddleware))
  httpd.use(
    '/deduction-rules',
    createDeductionRulesRouter(authMiddleware, engineDeps, deductionQueue ?? undefined),
  )
  httpd.use('/autoshare-rules', createAutoshareRulesRouter(authMiddleware, autosharePreviewDeps))
  httpd.use('/locations', createLocationsRouter(authMiddleware))
  httpd.use(createSettingsRouter(authMiddleware))
  httpd.use(createAuditLogRouter(authMiddleware))
  httpd.use(createRawRecordsRouter(authMiddleware))
  httpd.use('/dashboard', createDashboardRouter(authMiddleware))
  httpd.use('/shared-dashboards', createSharedDashboardsRouter(authMiddleware, webHost))
  httpd.use('/profile', createProfileRouter(authMiddleware, webHost, onAvatarChanged))
  // Mount the following + followers routers before `/feed` so `/feed/following/*`
  // and `/feed/followers/*` (two path segments) resolve here and never touch the
  // feed router's `/:postId`.
  httpd.use('/feed/following', createFeedFollowingRouter(authMiddleware, followActions))
  httpd.use('/feed/followers', createFeedFollowersRouter(authMiddleware, followerActions))
  httpd.use(
    '/feed',
    createFeedRouter(
      authMiddleware,
      feedDeliver,
      timelineHub,
      apiBaseUrl,
      retroEnrichTimeline,
      webHost,
      reactionActions,
    ),
  )
  httpd.use('/challenges', createChallengesRouter(authMiddleware, webHost, apiBaseUrl, discoverChallenges))
  httpd.use(createChallengeDataRouter())
  // Public feed series must be mounted before the generic /public/:username/:slug
  // resolver so `series` is not matched as a share slug.
  httpd.use(createFeedPublicRouter())
  // Public feed-post images (chart / route map), rendered on demand for opted-in
  // public/unlisted posts. Mounted alongside the series router (same guard).
  httpd.use(
    createFeedImageRouter({
      // Merged-span window so the rendered chart/route cover what the user
      // shared, matching the Note's duration/metrics (#881).
      getActivity: resolveFeedActivity,
      // Shared with the markdown export's eligibility check (#974), so "would
      // this block's image render?" can never drift from the endpoint.
      getArticleChartSeries: getArticleChartSeriesData,
      getCorrelationScatter: getArticleCorrelationScatter,
      getPost: getFeedPostById,
      getRoute: async (user, start, end) =>
        (await getLocations(user, start, end)).locations.map((l) => l.coordinates),
      getSeries: getTimeSeries,
      renderChart: renderChartPng,
      renderChartSvg: buildChartSvg,
      // Draw the route over the OSM basemap; falls back to a bare shape if tiles
      // can't be fetched (e.g. offline).
      renderRoute: (coords) => renderRoutePng(coords, { fetchTile: fetchOsmTile }),
      renderScatter: renderScatterPng,
      renderScatterSvg: buildScatterSvg,
    }),
  )
  httpd.use(createPublicSharesRouter(webHost))
  // Mounted before the share-html router so `/u/.../opengraph-image.png` and
  // `/u/:username/avatar.png` win over the generic `/u/:username/:slug` HTML route.
  httpd.use(createPublicAvatarRouter())
  httpd.use(createOEmbedRouter({ webHost, ...createShareResolvers() }))
  httpd.use(
    createOgImageRouter({
      loadAvatarDataUri,
      renderImage: createOgImageRenderer(),
      webHost,
      ...createShareResolvers(),
    }),
  )
  httpd.use(
    createShareHtmlRouter({
      loadTemplate: createTemplateLoader(webIndexPath),
      webHost,
      ...createShareResolvers(),
    }),
  )
  httpd.use('/correlations', createCorrelationsRouter(authMiddleware, syncProvider))
  httpd.use('/training-load', createTrainingLoadRouter(authMiddleware))
  httpd.use('/trends', createTrendsRouter(authMiddleware))
  httpd.use('/chart-data', createChartDataRouter(authMiddleware))
  httpd.use('/screentime-categories', createScreentimeCategoriesRouter(authMiddleware))
  httpd.use(
    '/admin',
    createAdminRouter(
      authMiddleware,
      adminMiddleware,
      centralDb,
      invitationAuth,
      webHost,
      ouraWebhookManager,
    ),
  )
  httpd.use(
    '/webauthn',
    createWebAuthnRouter({ auth, authMiddleware, centralDb, invitationAuth, userDb, webAuthn }),
  )
  httpd.use(createWellKnownRouter(wellKnown))
}
