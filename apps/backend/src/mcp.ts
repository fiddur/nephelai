/**
 * Stateless MCP server router.
 *
 * Each request creates a fresh McpServer + transport pair. No session tracking
 * is needed since the server only exposes tools (no resources, subscriptions,
 * or server-initiated notifications).
 *
 * Tool registrations are split into focused modules under mcp/.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { type Request, type Response, Router } from 'express'

import type { Auth } from './auth.ts'
import type { GarminClient } from './integrations/garmin/client.ts'
import type { GravlClient } from './integrations/gravl/client.ts'
import type { ouraClient } from './integrations/oura/client.ts'
import type { AutosharePreviewDeps } from './mcp/autoshare-rule-tools.ts'
import type { FeedDeliver } from './routes/feed-router.ts'
import type { CentralDb } from './services/central-db.ts'
import type { DiscoverChallenges } from './services/challenge-discovery.ts'
import type { DeductionEngineDeps } from './services/deduction-engine.ts'
import type { ActivityNotifier, DeductionQueue } from './services/deduction-queue.ts'
import type { ReactionActions } from './services/feed-reactions.ts'
import type { FollowerActions } from './services/followers.ts'
import type { FollowActions } from './services/following.ts'
import type { SyncProvider } from './services/queries/index.ts'
import type { StravaQueue } from './services/strava-queue.ts'
import type { RetroEnrichTrigger } from './services/timeline-retro-enrich.ts'

import { registerActivityTools } from './mcp/activity-tools.ts'
import { registerActivityTypeTools } from './mcp/activity-type-tools.ts'
import { registerAutoshareRuleTools } from './mcp/autoshare-rule-tools.ts'
import { registerChallengeTools } from './mcp/challenge-tools.ts'
import { registerChartTools } from './mcp/chart-tools.ts'
import { registerCorrelationTools } from './mcp/correlation-tools.ts'
import { registerDebugTools } from './mcp/debug-tools.ts'
import { registerDeductionRuleTools } from './mcp/deduction-rule-tools.ts'
import { registerFeedTools } from './mcp/feed-tools.ts'
import { registerFoodItemTools } from './mcp/food-item-tools.ts'
import { registerImportTools } from './mcp/import-tools.ts'
import { registerLocationTools } from './mcp/location-tools.ts'
import { registerMealTools } from './mcp/meal-tools.ts'
import { registerMetricTools } from './mcp/metric-tools.ts'
import { registerNoteTools } from './mcp/note-tools.ts'
import { registerNutrientRecommendationTools } from './mcp/nutrient-recommendation-tools.ts'
import { registerQueryTools } from './mcp/query-tools.ts'
import { registerReportTools } from './mcp/report-tools.ts'
import { registerScreentimeCategoryTools } from './mcp/screentime-category-tools.ts'
import { registerSensitivityTools } from './mcp/sensitivity-tools.ts'
import { registerSettingsTools } from './mcp/settings-tools.ts'
import { registerSharedDashboardTools } from './mcp/shared-dashboard-tools.ts'
import { registerSyncTools } from './mcp/sync-tools.ts'
// tag-tools removed: tags are now activities
import { registerTrainingLoadTools } from './mcp/training-load-tools.ts'
import { registerTrendTools } from './mcp/trend-tools.ts'
import { createDefaultEngineDeps } from './services/deduction-deps.ts'
import { isOAuthAccessToken, validateAccessToken } from './services/oauth.ts'

type OuraClientType = ReturnType<typeof ouraClient>

interface McpDeps {
  apiBaseUrl?: string
  autosharePreviewDeps?: AutosharePreviewDeps
  centralDb?: CentralDb
  deductionQueue?: DeductionQueue
  /** Open challenges from followed peers (`discover_challenges`). */
  discoverChallenges?: DiscoverChallenges
  engineDeps?: DeductionEngineDeps
  feedDeliver?: FeedDeliver
  followActions?: FollowActions
  followerActions?: FollowerActions
  garmin?: GarminClient
  gravl?: GravlClient
  onActivityMutated?: ActivityNotifier
  oura?: OuraClientType
  reactionActions?: ReactionActions
  retroEnrichTimeline?: RetroEnrichTrigger
  stravaQueue?: StravaQueue
  sync?: SyncProvider
  webHost?: string
}

const createMcpServer = (user: string, deps: McpDeps = {}): McpServer => {
  const server = new McpServer({
    name: 'aurboda',
    version: '1.0.0',
  })

  const engineDeps = deps.engineDeps ?? createDefaultEngineDeps()

  registerQueryTools(server, user, deps.sync)
  registerMetricTools(server, user)
  registerActivityTools(server, user, deps.onActivityMutated)
  registerActivityTypeTools(server, user)
  registerDeductionRuleTools(server, user, engineDeps, deps.deductionQueue)
  if (deps.autosharePreviewDeps) registerAutoshareRuleTools(server, user, deps.autosharePreviewDeps)
  registerSyncTools(
    server,
    user,
    deps.oura,
    deps.garmin,
    deps.stravaQueue,
    deps.onActivityMutated,
    deps.gravl,
  )
  registerSettingsTools(server, user)
  registerLocationTools(server, user)
  registerCorrelationTools(server, user, deps.sync)
  registerTrainingLoadTools(server, user)
  registerTrendTools(server, user)
  registerChartTools(server, user)
  registerNoteTools(server, user)
  registerMealTools(server, user)
  registerNutrientRecommendationTools(server, user)
  if (deps.centralDb) {
    registerFoodItemTools(server, user, deps.centralDb)
    registerSensitivityTools(server, user, deps.centralDb)
    registerImportTools(server, user, deps.centralDb)
  }
  registerReportTools(server, user)
  registerSharedDashboardTools(server, user)
  registerFeedTools(server, user, {
    apiBaseUrl: deps.apiBaseUrl,
    deliver: deps.feedDeliver,
    followActions: deps.followActions,
    followerActions: deps.followerActions,
    reactionActions: deps.reactionActions,
    retroEnrichTimeline: deps.retroEnrichTimeline,
    webHost: deps.webHost,
  })
  registerChallengeTools(server, user, {
    apiBaseUrl: deps.apiBaseUrl,
    discoverChallenges: deps.discoverChallenges,
    webHost: deps.webHost,
  })
  registerScreentimeCategoryTools(server, user)
  registerDebugTools(server, user)

  return server
}

/**
 * Create a stateless MCP router.
 *
 * Each POST request creates a fresh McpServer and transport. No session
 * persistence or tracking is needed — the server only exposes tools with
 * no server-initiated notifications.
 */
export function createMcpRouter(auth: Auth, deps: McpDeps = {}): Router {
  const router = Router()

  const getAuthenticatedUser = async (req: Request): Promise<string | null> => {
    const authHeader = req.headers.authorization
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      return null
    }
    const token = authHeader.slice('Bearer '.length)

    // Try OAuth access token first (prefixed with aur_at_)
    if (isOAuthAccessToken(token) && deps.centralDb) {
      return validateAccessToken({ centralDb: deps.centralDb }, token)
    }

    // Fall back to existing AES-256-GCM token
    try {
      return auth.getUsernameFromToken(token)
    } catch {
      return null
    }
  }

  // POST /mcp - Handle JSON-RPC requests (stateless: fresh server per request)
  router.post('/', async (req: Request, res: Response) => {
    const user = await getAuthenticatedUser(req)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const server = createMcpServer(user, deps)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })

    await server.connect(transport)
    await transport.handleRequest(req, res)
    await server.close()
  })

  // GET /mcp - Not used in stateless mode (no SSE notifications)
  router.get('/', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'SSE not supported in stateless mode' })
  })

  // DELETE /mcp - Not used in stateless mode (no sessions)
  router.delete('/', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'No sessions in stateless mode' })
  })

  return router
}
