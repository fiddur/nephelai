import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createAuth } from './auth.ts'
import * as db from './db/index.ts'
import { createMcpRouter } from './mcp.ts'
import * as mutations from './services/mutations.ts'
import * as queries from './services/queries/index.ts'

// Mock the services
vi.mock('./services/queries/index', () => ({
  getDailySummary: vi.fn(),
  getPeriodSummary: vi.fn(),
  queryActivities: vi.fn(),
  queryLocations: vi.fn(),
  queryMetrics: vi.fn(),
  queryProductivity: vi.fn(),
  queryTags: vi.fn(),
}))

vi.mock('./services/mutations', () => ({
  addActivity: vi.fn(),
  addCustomMetric: vi.fn(),
  addMetric: vi.fn(),
  addTag: vi.fn(),
  deleteActivity: vi.fn(),
  deleteCustomMetric: vi.fn(),
  getCustomMetrics: vi.fn().mockResolvedValue([]),
  restoreActivity: vi.fn(),
  updateActivity: vi.fn(),
}))

// Mock db for sync status and stored detected locations
vi.mock('./db', () => ({
  activityTypeExists: vi.fn().mockResolvedValue(true),
  deleteActivityTypeDefinition: vi.fn().mockResolvedValue(false),
  deleteDeductionRule: vi.fn().mockResolvedValue(false),
  deleteGarminActivityWithWrongType: vi.fn().mockResolvedValue(null),
  deleteRuleActivities: vi.fn().mockResolvedValue(0),
  deleteStaleRuleActivities: vi.fn().mockResolvedValue(0),
  getActivityTypeDefinition: vi.fn().mockResolvedValue(null),
  getActivityTypeDefinitions: vi.fn().mockResolvedValue([]),
  getActivityTypeNames: vi.fn().mockResolvedValue(['sleep', 'exercise', 'meditation', 'nap', 'rest']),
  getAllActivityTypeNames: vi.fn().mockResolvedValue(['sleep', 'exercise', 'meditation', 'nap', 'rest']),
  getAllSyncStates: vi.fn(),
  getDeductionRule: vi.fn().mockResolvedValue(null),
  getDeductionRules: vi.fn().mockResolvedValue([]),
  getEnabledDeductionRules: vi.fn().mockResolvedValue([]),
  getDetectedLocations: vi.fn(),
  getOAuthToken: vi.fn().mockResolvedValue(null),
  getProgrammaticTags: vi.fn().mockResolvedValue([]),
  getSyncState: vi.fn().mockResolvedValue(null),
  resetSyncState: vi.fn().mockResolvedValue(undefined),
  getUniqueTags: vi.fn().mockResolvedValue([]),
  getUserSettings: vi.fn().mockResolvedValue(null),
  insertActivity: vi.fn().mockResolvedValue(undefined),
  insertActivityTypeDefinition: vi.fn(),
  insertLocations: vi.fn().mockResolvedValue(undefined),
  insertDeductionRule: vi.fn().mockResolvedValue({
    conditions: [],
    enabled: true,
    id: 'mock-id',
    name: 'mock',
    output_activity_type: 'test',
    priority: 0,
  }),
  insertDeductionRuleRun: vi.fn().mockResolvedValue(undefined),
  insertRawRecord: vi.fn().mockResolvedValue(undefined),
  insertTimeSeries: vi.fn().mockResolvedValue(undefined),
  softDeleteSupersededLocations: vi.fn().mockResolvedValue(0),
  updateActivityTypeDefinition: vi.fn(),
  updateDeductionRule: vi.fn().mockResolvedValue(null),
  upsertSyncState: vi.fn().mockResolvedValue(undefined),
  upsertUserSettings: vi.fn(),
  adoptLegacyActivity: vi.fn(),
  findActivityByExternalId: vi.fn(),
  deleteActivity: vi.fn().mockResolvedValue(false),
  materializeSuperseded: vi.fn().mockResolvedValue(undefined),
}))

// Mock the sync modules
vi.mock('./services/deduction-deps', () => ({
  createDefaultEngineDeps: vi.fn().mockReturnValue({
    deleteStaleRuleActivities: vi.fn().mockResolvedValue(0),
    enrichActivities: vi.fn().mockResolvedValue([]),
    getActivities: vi.fn().mockResolvedValue([]),
    getActivitiesWithData: vi.fn().mockResolvedValue([]),
    getActivitiesWithDataFilters: vi.fn().mockResolvedValue([]),
    getEarliestActivityTime: vi.fn().mockResolvedValue(null),
    getLocationVisits: vi.fn().mockResolvedValue([]),
    getScreentime: vi.fn().mockResolvedValue([]),
    insertActivity: vi.fn().mockResolvedValue(undefined),
    insertRuleRun: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('./oura-sync', () => ({
  syncAllOuraData: vi.fn(),
}))

vi.mock('./rescuetime-sync', () => ({
  syncRescueTimeData: vi.fn(),
}))

const auth = createAuth('very very secretvery very secret') // 32 bytes for AES-256

function createTestApp() {
  const app = express()
  // MCP router must be mounted BEFORE body-parser — stateless mode (no sessions)
  app.use('/mcp', createMcpRouter(auth))
  return app
}

// Helper to make MCP requests with proper headers
function mcpPost(app: express.Express) {
  return request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
}

function mcpDelete(app: express.Express) {
  return request(app).delete('/mcp').set('Accept', 'application/json, text/event-stream')
}

// Parse SSE response to extract JSON-RPC result
function parseSSEResponse(text: string): unknown {
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6))
    }
  }
  throw new Error('No data line found in SSE response')
}

describe('MCP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore default mock implementations cleared by resetAllMocks
    vi.mocked(mutations.getCustomMetrics).mockResolvedValue([])
    vi.mocked(db.getUserSettings).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('Authentication - POST /mcp', () => {
    test('returns 401 without authorization header', async () => {
      const app = createTestApp()
      const response = await mcpPost(app).send({ id: 1, jsonrpc: '2.0', method: 'initialize' })

      expect(response.status).toBe(401)
      expect(response.body.error).toBe('Unauthorized')
    })

    test('returns 401 with invalid token', async () => {
      const app = createTestApp()
      const response = await mcpPost(app)
        .set('Authorization', 'Bearer invalid-token')
        .send({ id: 1, jsonrpc: '2.0', method: 'initialize' })

      expect(response.status).toBe(401)
      expect(response.body.error).toBe('Unauthorized')
    })

    test('accepts valid bearer token in stateless mode', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
            protocolVersion: '2024-11-05',
          },
        })

      expect(response.status).toBe(200)
      // Stateless mode: no session ID in response
      expect(response.headers['mcp-session-id']).toBeUndefined()
    })
  })

  describe('Stateless mode - GET /mcp (SSE not supported)', () => {
    test('returns 405 for GET requests', async () => {
      const app = createTestApp()
      const response = await request(app).get('/mcp').set('Accept', 'text/event-stream')

      expect(response.status).toBe(405)
      expect(response.body.error).toBe('SSE not supported in stateless mode')
    })
  })

  describe('Stateless mode - DELETE /mcp (no sessions)', () => {
    test('returns 405 for DELETE requests', async () => {
      const app = createTestApp()
      const response = await mcpDelete(app)

      expect(response.status).toBe(405)
      expect(response.body.error).toBe('No sessions in stateless mode')
    })
  })

  describe('Tool: query_period_summary', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      // Parse SSE response
      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let toolResult: any = null
      try {
        toolResult = JSON.parse(parsed.result.content[0].text)
      } catch {
        // Error responses may contain plain text instead of JSON
      }
      return {
        ...response,
        parsed,
        toolResult,
      }
    }

    test('returns aggregated stats for valid metrics', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      // Mock service response
      vi.mocked(queries.getPeriodSummary).mockResolvedValue({
        end: '2024-01-31T23:59:59.000Z',
        metrics: [
          {
            avg: 45.5,
            change_from_previous_period_percent: 10,
            completeness_percent: 90,
            count: 30,
            max: 65,
            metric: 'hrv_rmssd',
            min: 25,
            stddev: 10,
            trend_per_day: 5,
            unit: 'ms',
          },
        ],
        period_days: 31,
        start: '2024-01-01T00:00:00.000Z',
      })

      const response = await callTool(app, token, 'query_period_summary', {
        end: '2024-01-31T23:59:59Z',
        metrics: ['hrv_rmssd'],
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      const result = response.toolResult
      expect(result.metrics).toHaveLength(1)
      expect(result.metrics[0].metric).toBe('hrv_rmssd')
      expect(result.metrics[0].avg).toBe(45.5)
      expect(result.metrics[0].min).toBe(25)
      expect(result.metrics[0].max).toBe(65)
      expect(result.metrics[0].stddev).toBe(10)
      expect(result.metrics[0].unit).toBe('ms')
      expect(result.metrics[0].trend_per_day).toBe(5)

      // Verify service was called with correct arguments
      expect(queries.getPeriodSummary).toHaveBeenCalledWith(
        'testuser',
        ['hrv_rmssd'],
        expect.any(Date),
        expect.any(Date),
      )
    })

    test('returns error for invalid date format', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      const response = await callTool(app, token, 'query_period_summary', {
        end: 'not-a-date',
        metrics: ['hrv_rmssd'],
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      // Schema validation catches invalid dates before our handler runs
      expect(response.parsed.result.content[0].text).toMatch(/Invalid (date|ISO datetime)/i)
    })

    test('calculates change from previous period', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.getPeriodSummary).mockResolvedValue({
        end: '2024-01-31T23:59:59.000Z',
        metrics: [
          {
            avg: 50,
            change_from_previous_period_percent: 25,
            completeness_percent: 100,
            count: 30,
            max: 60,
            metric: 'hrv_rmssd',
            min: 40,
            stddev: 5,
            trend_per_day: null,
            unit: 'ms',
          },
        ],
        period_days: 31,
        start: '2024-01-01T00:00:00.000Z',
      })

      const response = await callTool(app, token, 'query_period_summary', {
        end: '2024-01-31T23:59:59Z',
        metrics: ['hrv_rmssd'],
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.metrics[0].change_from_previous_period_percent).toBe(25)
    })

    test('identifies outliers beyond 2 stddev', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.getPeriodSummary).mockResolvedValue({
        end: '2024-01-31T23:59:59.000Z',
        metrics: [
          {
            avg: 50,
            change_from_previous_period_percent: null,
            completeness_percent: 100,
            count: 30,
            max: 85,
            metric: 'hrv_rmssd',
            min: 20,
            outliers: [{ type: 'high', value: 85 }],
            stddev: 10,
            trend_per_day: null,
            unit: 'ms',
          },
        ],
        period_days: 31,
        start: '2024-01-01T00:00:00.000Z',
      })

      const response = await callTool(app, token, 'query_period_summary', {
        end: '2024-01-31T23:59:59Z',
        metrics: ['hrv_rmssd'],
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.metrics[0].outliers).toBeDefined()
      expect(response.toolResult.metrics[0].outliers).toContainEqual({ type: 'high', value: 85 })
    })

    test('handles metrics with no data', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.getPeriodSummary).mockResolvedValue({
        end: '2024-01-31T23:59:59.000Z',
        metrics: [
          {
            avg: 0,
            change_from_previous_period_percent: null,
            completeness_percent: 0,
            count: 0,
            max: 0,
            metric: 'hrv_rmssd',
            min: 0,
            stddev: 0,
            trend_per_day: null,
            unit: 'ms',
          },
        ],
        period_days: 31,
        start: '2024-01-01T00:00:00.000Z',
      })

      const response = await callTool(app, token, 'query_period_summary', {
        end: '2024-01-31T23:59:59Z',
        metrics: ['hrv_rmssd'],
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.metrics).toHaveLength(1)
      expect(response.toolResult.metrics[0].count).toBe(0)
      expect(response.toolResult.metrics[0].completeness_percent).toBe(0)
    })

    test('calculates completeness percentage correctly', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')
      vi.mocked(queries.getPeriodSummary).mockResolvedValue({
        end: '2024-01-31T23:59:59.000Z',
        metrics: [
          {
            avg: 50,
            change_from_previous_period_percent: null,
            completeness_percent: 48,
            count: 15,
            max: 60,
            metric: 'hrv_rmssd',
            min: 40,
            stddev: 5,
            trend_per_day: null,
            unit: 'ms',
          },
        ],
        period_days: 31,
        start: '2024-01-01T00:00:00.000Z',
      })

      const response = await callTool(app, token, 'query_period_summary', {
        end: '2024-01-31T23:59:59Z',
        metrics: ['hrv_rmssd'],
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.metrics[0].completeness_percent).toBe(48)
    })
  })

  describe('Tool: query_tags', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    test('returns tags for valid time range', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryTags).mockResolvedValue([
        {
          comments: [],
          start_time: '2024-01-15T14:30:00Z',
          tag: 'coffee',
        },
        {
          comments: [],
          end_time: '2024-01-15T16:00:00Z',
          start_time: '2024-01-15T15:00:00Z',
          tag: 'meeting',
        },
      ])

      const response = await callTool(app, token, 'query_tags', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(2)
      expect(response.toolResult.data[0].tag).toBe('coffee')
      expect(response.toolResult.data[1].tag).toBe('meeting')
      expect(queries.queryTags).toHaveBeenCalledWith(
        'testuser',
        expect.any(Date),
        expect.any(Date),
        undefined,
      )
    })

    test('returns empty array when no tags exist', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryTags).mockResolvedValue([])

      const response = await callTool(app, token, 'query_tags', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(0)
    })
  })

  describe('Tool: query_activities', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    test('returns activities for valid time range', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryActivities).mockResolvedValue([
        {
          activity_type: 'sleep',
          comments: [],
          duration: 480,
          end_time: '2024-01-15T07:00:00Z',
          source: 'health_connect',
          start_time: '2024-01-14T23:00:00Z',
          title: 'Sleep',
        },
        {
          activity_type: 'exercise',
          comments: [],
          duration: 45,
          end_time: '2024-01-15T09:45:00Z',
          hr_zone_secs: { 0: 60, 1: 300, 2: 900, 3: 1200, 4: 240, 5: 0 },
          source: 'health_connect',
          start_time: '2024-01-15T09:00:00Z',
          title: 'Morning Run',
        },
      ])

      const response = await callTool(app, token, 'query_activities', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(2)
      expect(response.toolResult.data[0].activity_type).toBe('sleep')
      expect(response.toolResult.data[1].activity_type).toBe('exercise')
      expect(response.toolResult.data[1].hr_zone_secs).toBeDefined()
    })

    test('filters by activity types when provided', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryActivities).mockResolvedValue([
        {
          activity_type: 'exercise',
          comments: [],
          duration: 45,
          end_time: '2024-01-15T09:45:00Z',
          source: 'health_connect',
          start_time: '2024-01-15T09:00:00Z',
          title: 'Morning Run',
        },
      ])

      const response = await callTool(app, token, 'query_activities', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        types: ['exercise'],
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(queries.queryActivities).toHaveBeenCalledWith(
        'testuser',
        ['exercise'],
        expect.any(Date),
        expect.any(Date),
        undefined,
        undefined,
      )
    })
  })

  describe('Tool: query_productivity', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    test('returns productivity data for valid time range', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryProductivity).mockResolvedValue({
        data: [
          {
            activity: 'Visual Studio Code',
            category: 'Software Development',
            comments: [],
            duration_sec: 7200,
            end_time: '2024-01-15T17:00:00Z',
            productivity: 2,
            start_time: '2024-01-15T09:00:00Z',
          },
          {
            activity: 'Twitter',
            category: 'Social Networking',
            comments: [],
            duration_sec: 1800,
            end_time: '2024-01-15T18:00:00Z',
            productivity: -2,
            start_time: '2024-01-15T17:30:00Z',
          },
        ],
      })

      const response = await callTool(app, token, 'query_productivity', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(2)
      expect(response.toolResult.data[0].activity).toBe('Visual Studio Code')
      expect(response.toolResult.data[0].productivity).toBe(2)
      expect(queries.queryProductivity).toHaveBeenCalledWith(
        'testuser',
        expect.any(Date),
        expect.any(Date),
        undefined,
      )
    })
  })

  describe('Tool: query_locations', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    test('returns location visits for valid time range', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryLocations).mockResolvedValue([
        {
          duration: 480,
          end_time: '2024-01-15T17:00:00Z',
          lat: 59.3293,
          lon: 18.0686,
          name: 'Office',
          source: 'named',
          start_time: '2024-01-15T09:00:00Z',
        },
        {
          duration: 120,
          end_time: '2024-01-15T20:00:00Z',
          lat: 59.3351,
          lon: 18.0542,
          name: 'Gym',
          source: 'named',
          start_time: '2024-01-15T18:00:00Z',
        },
      ])

      const response = await callTool(app, token, 'query_locations', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(2)
      expect(response.toolResult.data[0].name).toBe('Office')
      expect(response.toolResult.data[0].source).toBe('named')
      expect(response.toolResult.data[1].name).toBe('Gym')
      expect(queries.queryLocations).toHaveBeenCalledWith('testuser', expect.any(Date), expect.any(Date))
    })

    test('returns empty array when no visits exist', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(queries.queryLocations).mockResolvedValue([])

      const response = await callTool(app, token, 'query_locations', {
        end: '2024-01-31T23:59:59Z',
        start: '2024-01-01T00:00:00Z',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(0)
    })
  })

  describe('Tool: get_stored_detected_locations', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    test('returns stored detected locations with addresses', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(db.getDetectedLocations).mockResolvedValue([
        {
          address: '123 Main St, Stockholm',
          created_at: new Date('2024-01-01T00:00:00Z'),
          first_visit: new Date('2024-01-01T09:00:00Z'),
          geocode_status: 'success',
          id: '123e4567-e89b-12d3-a456-426614174000',
          last_visit: new Date('2024-01-15T17:00:00Z'),
          lat: 59.3293,
          lon: 18.0686,
          radius: 200,
          total_minutes: 4800,
          updated_at: new Date('2024-01-15T17:00:00Z'),
          visit_count: 10,
        },
        {
          address: null,
          created_at: new Date('2024-01-02T00:00:00Z'),
          first_visit: new Date('2024-01-02T10:00:00Z'),
          geocode_status: 'pending',
          id: '123e4567-e89b-12d3-a456-426614174001',
          last_visit: new Date('2024-01-16T18:00:00Z'),
          lat: 59.3351,
          lon: 18.0542,
          radius: 150,
          total_minutes: 600,
          updated_at: new Date('2024-01-16T18:00:00Z'),
          visit_count: 3,
        },
      ])

      const response = await callTool(app, token, 'get_stored_detected_locations', {})

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(2)
      expect(response.toolResult.data[0].address).toBe('123 Main St, Stockholm')
      expect(response.toolResult.data[0].geocode_status).toBe('success')
      expect(response.toolResult.data[1].geocode_status).toBe('pending')
      expect(db.getDetectedLocations).toHaveBeenCalledWith('testuser')
    })

    test('returns empty array when no stored locations exist', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(db.getDetectedLocations).mockResolvedValue([])

      const response = await callTool(app, token, 'get_stored_detected_locations', {})

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.data).toHaveLength(0)
    })
  })

  describe('Tool: add_activity', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    test('creates exercise activity using the specific activity_type', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.addActivity).mockResolvedValue({
        activity_type: 'weightlifting',
        end_time: '2024-03-15T11:45:00.000Z',
        id: 'test-uuid',
        start_time: '2024-03-15T10:30:00.000Z',
        success: true,
        title: 'Upper body',
      })

      const response = await callTool(app, token, 'add_activity', {
        activity_type: 'weightlifting',
        data: { reps: 12 },
        end_time: '2024-03-15T11:45:00Z',
        start_time: '2024-03-15T10:30:00Z',
        title: 'Upper body',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(response.toolResult.id).toBe('test-uuid')
      expect(mutations.addActivity).toHaveBeenCalledWith(
        'testuser',
        {
          activity_type: 'weightlifting',
          data: { reps: 12 },
          end_time: expect.any(Date),
          notes: undefined,
          start_time: expect.any(Date),
          title: 'Upper body',
        },
        undefined,
      )
    })

    test('creates activity without data', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.addActivity).mockResolvedValue({
        activity_type: 'meditation',
        end_time: '2024-03-15T07:30:00.000Z',
        id: 'test-uuid-2',
        start_time: '2024-03-15T07:00:00.000Z',
        success: true,
        title: 'Morning meditation',
      })

      const response = await callTool(app, token, 'add_activity', {
        activity_type: 'meditation',
        end_time: '2024-03-15T07:30:00Z',
        start_time: '2024-03-15T07:00:00Z',
        title: 'Morning meditation',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(mutations.addActivity).toHaveBeenCalledWith(
        'testuser',
        {
          activity_type: 'meditation',
          data: undefined,
          end_time: expect.any(Date),
          notes: undefined,
          start_time: expect.any(Date),
          title: 'Morning meditation',
        },
        undefined,
      )
    })

    test('returns error when end_time is before start_time', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.addActivity).mockResolvedValue({
        error: 'end_time must not be before start_time',
        success: false,
      })

      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            arguments: {
              activity_type: 'exercise',
              end_time: '2024-03-15T09:00:00Z',
              start_time: '2024-03-15T10:30:00Z',
              tz: 'UTC',
            },
            name: 'add_activity',
          },
        })

      expect(response.status).toBe(200)
      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      expect(parsed.result.content[0].text).toContain('end_time must not be before start_time')
    })
  })

  describe('Tool: update_activity', () => {
    async function callTool(
      app: express.Express,
      token: string,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: toolName },
        })

      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      return {
        ...response,
        parsed,
        toolResult: JSON.parse(parsed.result.content[0].text),
      }
    }

    const testActivityId = '00000000-0000-4000-a000-000000000001'

    test('updates activity_type and data fields', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.updateActivity).mockResolvedValue({
        activity_type: 'weightlifting',
        end_time: '2024-03-15T11:00:00.000Z',
        id: testActivityId,
        start_time: '2024-03-15T10:00:00.000Z',
        success: true,
        title: 'Workout',
      })

      const response = await callTool(app, token, 'update_activity', {
        activity_type: 'weightlifting',
        data: { weight: 80 },
        id: testActivityId,
        title: 'Workout',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(mutations.updateActivity).toHaveBeenCalledWith(
        'testuser',
        testActivityId,
        {
          activity_type: 'weightlifting',
          data: { weight: 80 },
          end_time: undefined,
          notes: undefined,
          start_time: undefined,
          title: 'Workout',
        },
        undefined,
      )
    })

    test('updates activity notes only', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.updateActivity).mockResolvedValue({
        activity_type: 'exercise',
        end_time: '2024-03-15T11:00:00.000Z',
        id: testActivityId,
        start_time: '2024-03-15T10:00:00.000Z',
        success: true,
      })

      const response = await callTool(app, token, 'update_activity', {
        id: testActivityId,
        notes: 'Great session',
        tz: 'UTC',
      })

      expect(response.status).toBe(200)
      expect(response.toolResult.success).toBe(true)
      expect(mutations.updateActivity).toHaveBeenCalledWith(
        'testuser',
        testActivityId,
        {
          activity_type: undefined,
          data: undefined,
          end_time: undefined,
          notes: 'Great session',
          start_time: undefined,
          title: undefined,
        },
        undefined,
      )
    })

    test('passes time updates as Date objects', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.updateActivity).mockResolvedValue({
        activity_type: 'exercise',
        end_time: '2024-03-15T12:00:00.000Z',
        id: testActivityId,
        start_time: '2024-03-15T09:00:00.000Z',
        success: true,
      })

      await callTool(app, token, 'update_activity', {
        end_time: '2024-03-15T12:00:00Z',
        id: testActivityId,
        start_time: '2024-03-15T09:00:00Z',
        tz: 'UTC',
      })

      expect(mutations.updateActivity).toHaveBeenCalledWith(
        'testuser',
        testActivityId,
        {
          data: undefined,
          end_time: expect.any(Date),
          notes: undefined,
          start_time: expect.any(Date),
          title: undefined,
        },
        undefined,
      )
    })

    test('returns error from service on failure', async () => {
      const app = createTestApp()
      const token = auth.createToken('testuser')

      vi.mocked(mutations.updateActivity).mockResolvedValue({
        error: 'Activity not found',
        id: testActivityId,
        success: false,
      })

      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            arguments: {
              id: testActivityId,
              title: 'New title',
              tz: 'UTC',
            },
            name: 'update_activity',
          },
        })

      expect(response.status).toBe(200)
      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      expect(parsed.result.content[0].text).toContain('Activity not found')
    })
  })

  describe('Tool: reset_sync_state', () => {
    async function callResetSyncState(app: express.Express, token: string, args: Record<string, unknown>) {
      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: args, name: 'reset_sync_state' },
        })
      const parsed = parseSSEResponse(response.text) as { result: { content: { text: string }[] } }
      const toolResult = JSON.parse(parsed.result.content[0].text) as Record<string, unknown>
      return { response, toolResult }
    }

    test('resets all data types when data_type is omitted', async () => {
      const resetSpy = vi.mocked(db.resetSyncState).mockResolvedValue(undefined)
      const app = createTestApp()
      const token = auth.createToken('testuser')

      const { response, toolResult } = await callResetSyncState(app, token, { provider: 'strava' })

      expect(response.status).toBe(200)
      expect(toolResult).toEqual({
        data_type: 'all',
        provider: 'strava',
        reset: true,
        success: true,
      })
      expect(resetSpy).toHaveBeenCalledWith('testuser', 'strava', undefined)
    })

    test('resets specific data_type when provided', async () => {
      const resetSpy = vi.mocked(db.resetSyncState).mockResolvedValue(undefined)
      const app = createTestApp()
      const token = auth.createToken('testuser')

      const { response, toolResult } = await callResetSyncState(app, token, {
        data_type: 'activities',
        provider: 'strava',
      })

      expect(response.status).toBe(200)
      expect(toolResult.data_type).toBe('activities')
      expect(resetSpy).toHaveBeenCalledWith('testuser', 'strava', 'activities')
    })

    test('rejects invalid provider', async () => {
      const resetSpy = vi.mocked(db.resetSyncState)
      const app = createTestApp()
      const token = auth.createToken('testuser')

      const response = await mcpPost(app)
        .set('Authorization', `Bearer ${token}`)
        .send({
          id: 1,
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { arguments: { provider: 'nonexistent' }, name: 'reset_sync_state' },
        })

      expect(response.status).toBe(200)
      expect(resetSpy).not.toHaveBeenCalled()
    })
  })
})
