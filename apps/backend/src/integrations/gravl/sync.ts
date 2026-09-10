/**
 * Gravl sync orchestration (#1042).
 *
 * One sync-state row, `provider = 'gravl'`, `data_type = 'workouts'`. Each run
 * lists workouts in a window, drops the `External` round-trips and empty
 * workouts (retracting any row an earlier run imported for them), fetches
 * every real workout's detail (the list has no sets) and hands it to the
 * processor.
 *
 * Windows: 90 days on the first run or a full resync; otherwise from two days
 * before the last successful sync, because Gravl workouts get edited after the
 * fact (a forgotten set, a corrected weight). Re-processing is idempotent.
 *
 * Rate limits: 100 requests per 15 minutes per app + user. One run costs
 * ~1 list page plus one detail fetch per workout, so it fits comfortably;
 * on a 429 the state records `retry_after` and `last_sync_time` is NOT
 * advanced, so the next run re-covers the same window.
 */

import type { GravlSyncResult } from '@aurboda/api-spec'

import { addMinutes, addSeconds, isFuture, subDays } from 'date-fns'

import type { SyncState } from '../../db/types.ts'
import type { GravlClient } from './client.ts'
import type { GravlProcessOutcome } from './process.ts'
import type { GravlWorkoutDetail } from './types.ts'

import { getAllSyncStates, getSyncState, upsertSyncState } from '../../db/index.ts'
import { auditError, auditInfo } from '../../services/audit-log.ts'
import { isGravlAuthFailure, isGravlRateLimit } from './client.ts'
import { isStrengthWorkout, processGravlWorkout, retractGravlNonWorkout } from './process.ts'

export const GRAVL_PROVIDER = 'gravl'
export const GRAVL_DATA_TYPE = 'workouts'

/** Days fetched on the first sync / a full resync. */
export const DEFAULT_SYNC_HISTORY_DAYS = 90
/** Days re-fetched before the last sync to pick up edited workouts. */
const OVERLAP_DAYS = 2

/** Hold when Gravl sends no Retry-After (minutes). */
const RATE_LIMIT_FALLBACK_MINUTES = 5

export interface GravlSyncDeps {
  auditError: typeof auditError
  auditInfo: typeof auditInfo
  getSyncState: typeof getSyncState
  now: () => Date
  processWorkout: (user: string, detail: GravlWorkoutDetail) => Promise<GravlProcessOutcome>
  /** Undo an earlier import of a workout the sync now rejects; true when a row was soft-deleted. */
  retractWorkout: (user: string, workoutId: string) => Promise<boolean>
  upsertSyncState: typeof upsertSyncState
}

const defaultDeps = (): GravlSyncDeps => ({
  auditError,
  auditInfo,
  getSyncState,
  now: () => new Date(),
  processWorkout: (user, detail) => processGravlWorkout(user, detail),
  retractWorkout: (user, workoutId) => retractGravlNonWorkout(user, workoutId),
  upsertSyncState,
})

export const isRateLimited = (state: SyncState | null): boolean =>
  !!state?.retry_after && state.status === 'rate_limited' && isFuture(state.retry_after)

export const calculateRetryAfter = (now: Date, retryAfterSeconds?: number): Date =>
  retryAfterSeconds !== undefined && retryAfterSeconds > 0
    ? addSeconds(now, retryAfterSeconds)
    : addMinutes(now, RATE_LIMIT_FALLBACK_MINUTES)

const emptyCounts = () => ({
  activities_created: 0,
  activities_enriched: 0,
  activities_retracted: 0,
  workouts_processed: 0,
})

type SyncCounts = ReturnType<typeof emptyCounts>

const countOutcome = (counts: SyncCounts, outcome: GravlProcessOutcome): void => {
  if (outcome === 'skipped') return
  if (outcome === 'retracted') {
    counts.activities_retracted++
    return
  }
  counts.workouts_processed++
  if (outcome === 'enriched') counts.activities_enriched++
  else if (outcome === 'created') counts.activities_created++
}

/**
 * Page through the window, fetching detail for every real workout and
 * retracting stale imports of the rest. Throws on API failure.
 */
const processWindow = async (
  user: string,
  client: GravlClient,
  token: string,
  window: { start: Date; end: Date },
  deps: Pick<GravlSyncDeps, 'processWorkout' | 'retractWorkout'>,
  counts: SyncCounts,
): Promise<void> => {
  let page = 1
  let hasNext = true
  while (hasNext) {
    const listed = await client.listWorkouts(token, { endDate: window.end, page, startDate: window.start })
    for (const summary of listed.items) {
      if (!isStrengthWorkout(summary)) {
        if (await deps.retractWorkout(user, summary.id)) counts.activities_retracted++
        continue
      }
      const detail = await client.getWorkout(token, summary.id)
      countOutcome(counts, await deps.processWorkout(user, detail))
    }
    hasNext = listed.hasNextPage && listed.items.length > 0
    page++
  }
}

/**
 * Sync Gravl workouts for a user. Resolves credentials through the client
 * (OAuth grant first, personal token second) and returns a typed result the
 * REST route and MCP tool pass straight through.
 */
export const syncGravlWorkouts = async (
  user: string,
  client: GravlClient,
  options: { fullResync?: boolean; startDate?: Date } = {},
  deps: GravlSyncDeps = defaultDeps(),
): Promise<GravlSyncResult> => {
  const state = await deps.getSyncState(user, GRAVL_PROVIDER, GRAVL_DATA_TYPE)
  if (isRateLimited(state)) {
    return { ...emptyCounts(), retry_after: state!.retry_after!.toISOString(), status: 'skipped' }
  }

  const now = deps.now()
  const start =
    options.fullResync || !state?.last_sync_time
      ? (options.startDate ?? subDays(now, DEFAULT_SYNC_HISTORY_DAYS))
      : subDays(state.last_sync_time, OVERLAP_DAYS)

  await deps.upsertSyncState(user, {
    data_type: GRAVL_DATA_TYPE,
    provider: GRAVL_PROVIDER,
    status: 'syncing',
    sync_start_date: start,
  })

  const counts = emptyCounts()
  try {
    const token = await client.getAccessToken(user)
    await processWindow(user, client, token, { end: now, start }, deps, counts)

    await deps.upsertSyncState(user, {
      data_type: GRAVL_DATA_TYPE,
      error_message: undefined,
      last_sync_time: now,
      provider: GRAVL_PROVIDER,
      retry_after: undefined,
      status: 'idle',
    })
    deps.auditInfo(user, 'sync', 'Gravl sync complete', counts)
    return { ...counts, status: 'success' }
  } catch (error) {
    if (isGravlRateLimit(error)) {
      const retryAfter = calculateRetryAfter(now, error.retryAfterSeconds)
      await deps.upsertSyncState(user, {
        data_type: GRAVL_DATA_TYPE,
        error_message: 'Rate limited by Gravl API',
        provider: GRAVL_PROVIDER,
        retry_after: retryAfter,
        status: 'rate_limited',
      })
      return { ...counts, retry_after: retryAfter.toISOString(), status: 'rate_limited' }
    }

    const message = error instanceof Error ? error.message : String(error)
    await deps.upsertSyncState(user, {
      data_type: GRAVL_DATA_TYPE,
      error_message: isGravlAuthFailure(error) ? `Gravl rejected the token: ${message}` : message,
      provider: GRAVL_PROVIDER,
      status: 'error',
    })
    deps.auditError(user, 'sync', 'Gravl sync failed', { error: message })
    return { ...counts, error: message, status: 'error' }
  }
}

/**
 * Fetch and store one workout by id — the enrichment path taken when Health
 * Connect delivers a Gravl session (#1080). Throws on API failure so the
 * queue can retry; returns 'skipped' for external round-trips and while a
 * rate-limit hold is in force (the next poll re-covers the workout).
 */
export const enrichGravlWorkout = async (
  user: string,
  client: GravlClient,
  workoutId: string,
  deps: Pick<GravlSyncDeps, 'auditInfo' | 'getSyncState' | 'processWorkout'> = defaultDeps(),
): Promise<GravlProcessOutcome> => {
  const state = await deps.getSyncState(user, GRAVL_PROVIDER, GRAVL_DATA_TYPE)
  if (isRateLimited(state)) {
    deps.auditInfo(user, 'sync', 'Gravl enrichment skipped - rate limited', { workout_id: workoutId })
    return 'skipped'
  }
  const token = await client.getAccessToken(user)
  const detail = await client.getWorkout(token, workoutId)
  return deps.processWorkout(user, detail)
}

export const getGravlSyncStates = async (user: string) => {
  const states = await getAllSyncStates(user, GRAVL_PROVIDER)
  return states.map((s) => ({
    error_message: s.error_message ?? null,
    last_sync_time: s.last_sync_time?.toISOString() ?? null,
    provider: GRAVL_PROVIDER,
    retry_after: s.retry_after?.toISOString() ?? null,
    // Same folding as the shared transform in api/sync-setup.ts, so the web's
    // sync bar flags a hold the way it flags any other provider's error.
    status: s.status === 'rate_limited' ? ('error' as const) : (s.status ?? 'idle'),
  }))
}

export const resetGravlSyncState = async (user: string): Promise<void> => {
  await upsertSyncState(user, {
    data_type: GRAVL_DATA_TYPE,
    error_message: undefined,
    provider: GRAVL_PROVIDER,
    retry_after: undefined,
    status: 'idle',
  })
}
