/**
 * Sync provider factory for auto-syncing external data sources.
 *
 * This module creates SyncProvider instances that can be passed to query
 * functions to enable automatic data refresh before queries.
 */

import type { GravlSyncResult } from '@aurboda/api-spec'

import { isBefore, subDays, subMinutes } from 'date-fns'

import type { SyncIntervals, SyncState } from '../db/types.ts'
import type { GarminClient } from '../integrations/garmin/client.ts'
import type { GravlClient } from '../integrations/gravl/client.ts'
import type { ouraClient } from '../integrations/oura/client.ts'
import type { ActivityNotifier } from './deduction-queue.ts'
import type { SyncProvider } from './queries/index.ts'

import { getSyncState } from '../db/index.ts'
import {
  type GarminDataType,
  isRateLimited as isGarminRateLimited,
  syncActivityDetails,
  syncGarminDataType,
} from '../integrations/garmin/sync.ts'
import {
  DEFAULT_SYNC_HISTORY_DAYS as GRAVL_HISTORY_DAYS,
  isRateLimited as isGravlRateLimited,
  syncGravlWorkouts,
} from '../integrations/gravl/sync.ts'
import { syncAllCalendars } from '../integrations/ical/sync.ts'
import { DEFAULT_SYNC_HISTORY_DAYS, syncLastFmData } from '../integrations/lastfm/sync.ts'
import {
  isRateLimited as isOuraRateLimited,
  type OuraDataType,
  syncOuraDataType,
} from '../integrations/oura/sync.ts'
import {
  isRateLimited as isRescueTimeRateLimited,
  needsSync as rescueTimeNeedsSync,
  syncRescueTimeData,
} from '../integrations/rescuetime/sync.ts'
import { auditError, auditInfo, auditWarn } from './audit-log.ts'
import { getSettings } from './settings.ts'

/** A Gravl run that stored, enriched or retracted activities — the deduction hook should re-run over its window. */
const gravlChangedActivities = (result: GravlSyncResult): boolean =>
  result.status === 'success' && (result.workouts_processed > 0 || result.activities_retracted > 0)

/** Default sync threshold - sync if last sync was more than 30 minutes ago */
export const DEFAULT_SYNC_THRESHOLD_MINUTES = 30

/** Providers a user can set a poll interval for (`user_settings.sync_intervals`). */
export type SchedulableProvider = 'calendar' | 'garmin' | 'gravl' | 'lastfm' | 'oura' | 'rescuetime'

/**
 * Poll interval for a provider: the user's per-provider setting, else their
 * `default`, else the server fallback. Shared by the pre-query auto-sync and
 * the background scheduler so "how stale is too stale" has one answer.
 */
export const resolveSyncInterval = (
  intervals: SyncIntervals | undefined,
  provider: SchedulableProvider,
  fallback: number,
): number => {
  const configured = intervals?.[provider] ?? intervals?.default
  return typeof configured === 'number' && configured > 0 ? configured : fallback
}

/**
 * First-sync fallback for the deduction window when there's no prior
 * last_sync_time. Set to the longest provider backfill (Garmin and Oura import
 * 90 days on a first sync; RescueTime and Last.fm import 30), so first-sync
 * deduction evaluation covers all freshly-imported data rather than just the
 * most recent month. Over-covering a provider that backfills less is harmless —
 * the extra days simply have no new data and evaluation is idempotent.
 */
const FIRST_SYNC_FALLBACK_DAYS = 90

type OuraClientType = ReturnType<typeof ouraClient>

export interface SyncProviderConfig {
  /** Garmin Connect client (optional - if not provided, Garmin sync is disabled) */
  garmin?: GarminClient
  /** Callback to get the Last.fm API key (optional - if not provided, Last.fm sync is disabled) */
  getLastFmApiKey?: () => Promise<string | null>
  /** Oura API client (optional - if not provided, Oura sync is disabled) */
  oura?: OuraClientType
  /** Gravl API client (optional - if not provided, Gravl sync is disabled) */
  gravl?: GravlClient
  /**
   * Fired after a successful auto-sync that ingested new data, so deduction
   * rules run over the freshly-synced window. Wired to the same
   * ActivityNotifier the REST `/sync` routes use; when omitted (e.g. in tests),
   * auto-sync still works but does not trigger deduction evaluation.
   */
  onActivitySynced?: ActivityNotifier
  /** Sync threshold in minutes when the user has no `sync_intervals` entry (default: 30) */
  syncThresholdMinutes?: number
}

/**
 * Create a sync provider with the given configuration.
 * The provider can be passed to query functions to enable auto-sync.
 */
export function createSyncProvider(config: SyncProviderConfig): SyncProvider {
  const fallbackThreshold = config.syncThresholdMinutes ?? DEFAULT_SYNC_THRESHOLD_MINUTES
  const thresholdFor = (intervals: SyncIntervals | undefined, provider: SchedulableProvider): number =>
    resolveSyncInterval(intervals, provider, fallbackThreshold)

  // Fire deduction evaluation over the window a sync just ingested, so rules
  // (activity / screentime / etc. conditions) run on freshly-synced data —
  // closing the same trigger gap the Last.fm path had. Only fires when the sync
  // succeeded and brought in new records. The window starts at the prior
  // last_sync_time (what an incremental sync fetched) or, on a first sync,
  // falls back far enough to cover the provider's full backfill (see
  // FIRST_SYNC_FALLBACK_DAYS).
  const triggerDeductionAfterSync = (
    user: string,
    priorSyncState: SyncState | null,
    result: { records_processed: number; status: string },
  ): void => {
    if (result.status !== 'success' || result.records_processed === 0) return
    const end = new Date()
    const start = priorSyncState?.last_sync_time ?? subDays(end, FIRST_SYNC_FALLBACK_DAYS)
    config.onActivitySynced?.(user, '*', start, end)
  }

  return {
    syncCalendarsIfNeeded: async (user: string): Promise<void> => {
      try {
        const settings = await getSettings(user)
        if (!settings.calendars || settings.calendars.length === 0) return

        // Check if any calendar needs sync by checking the first one
        // (they all get synced together)
        const syncState = await getSyncState(user, 'calendar', settings.calendars[0].name)
        const thresholdTime = subMinutes(new Date(), thresholdFor(settings.sync_intervals, 'calendar'))
        if (syncState?.last_sync_time && isBefore(thresholdTime, syncState.last_sync_time)) {
          return
        }

        auditInfo(user, 'sync', 'Auto-syncing calendars')
        await syncAllCalendars(user, settings.calendars)
      } catch (error) {
        auditError(user, 'sync', 'Failed to auto-sync calendars', { error: String(error) })
      }
    },

    syncGarminIfNeeded: async (user: string, dataType: string): Promise<void> => {
      if (!config.garmin) return

      try {
        // Check if this data type is disabled in user settings
        const settings = await getSettings(user)
        if (settings.garmin_disabled_data_types?.includes(dataType as GarminDataType)) return

        const syncState = await getSyncState(user, 'garmin', dataType)

        if (isGarminRateLimited(syncState)) {
          auditWarn(user, 'sync', `Garmin ${dataType} sync skipped - rate limited`, {
            retry_after: syncState?.retry_after?.toISOString(),
          })
          return
        }

        const thresholdTime = subMinutes(new Date(), thresholdFor(settings.sync_intervals, 'garmin'))
        if (syncState?.last_sync_time && isBefore(thresholdTime, syncState.last_sync_time)) {
          return
        }

        auditInfo(user, 'sync', `Auto-syncing Garmin ${dataType}`)
        const result = await syncGarminDataType(user, config.garmin, dataType as GarminDataType)

        // After syncing activities, also fetch per-second detail data (GPS, HR, etc.)
        if (dataType === 'activities') {
          await syncActivityDetails(user, config.garmin)
        }

        triggerDeductionAfterSync(user, syncState, result)
      } catch (error) {
        auditError(user, 'sync', `Failed to auto-sync Garmin ${dataType}`, { error: String(error) })
      }
    },

    syncGravlIfNeeded: async (user: string): Promise<void> => {
      if (!config.gravl) return

      try {
        if ((await config.gravl.connectionKind(user)) === null) return

        const syncState = await getSyncState(user, 'gravl', 'workouts')
        if (isGravlRateLimited(syncState)) {
          auditWarn(user, 'sync', 'Gravl sync skipped - rate limited', {
            retry_after: syncState?.retry_after?.toISOString(),
          })
          return
        }

        const settings = await getSettings(user)
        const now = new Date()
        const thresholdTime = subMinutes(now, thresholdFor(settings.sync_intervals, 'gravl'))
        if (syncState?.last_sync_time && isBefore(thresholdTime, syncState.last_sync_time)) {
          return
        }

        auditInfo(user, 'sync', 'Auto-syncing Gravl workouts')
        const windowStart = syncState?.last_sync_time ?? subDays(now, GRAVL_HISTORY_DAYS)
        const result = await syncGravlWorkouts(user, config.gravl)
        if (gravlChangedActivities(result)) {
          config.onActivitySynced?.(user, '*', windowStart, now)
        }
      } catch (error) {
        auditError(user, 'sync', 'Failed to auto-sync Gravl', { error: String(error) })
      }
    },

    syncLastFmIfNeeded: async (user: string): Promise<void> => {
      if (!config.getLastFmApiKey) return

      try {
        const settings = await getSettings(user)
        if (!settings.lastfm_username) return

        const apiKey = await config.getLastFmApiKey()
        if (!apiKey) return

        const syncState = await getSyncState(user, 'lastfm', 'scrobbles')
        const now = new Date()
        const thresholdTime = subMinutes(now, thresholdFor(settings.sync_intervals, 'lastfm'))
        if (syncState?.last_sync_time && isBefore(thresholdTime, syncState.last_sync_time)) {
          return
        }

        auditInfo(user, 'sync', 'Auto-syncing Last.fm scrobbles')
        // The sync fetches scrobbles from last_sync_time (or 30 days back on the
        // first sync) up to now. Remember that window so deduction rules — e.g.
        // scrobble-based auto-tagging — run over exactly the newly-ingested data.
        const windowStart = syncState?.last_sync_time ?? subDays(now, DEFAULT_SYNC_HISTORY_DAYS)
        const result = await syncLastFmData(user, apiKey, settings.lastfm_username)
        if (result.status === 'success' && result.scrobbles_processed > 0) {
          config.onActivitySynced?.(user, '*', windowStart, now)
        }
      } catch (error) {
        auditError(user, 'sync', 'Failed to auto-sync Last.fm', { error: String(error) })
      }
    },

    syncOuraIfNeeded: async (user: string, dataType: 'tags' | 'sessions'): Promise<void> => {
      if (!config.oura) return

      try {
        const ouraDataType: OuraDataType = dataType
        const syncState = await getSyncState(user, 'oura', ouraDataType)

        // Skip if rate limited
        if (isOuraRateLimited(syncState)) {
          auditWarn(user, 'sync', `Oura ${dataType} sync skipped - rate limited`, {
            retry_after: syncState?.retry_after?.toISOString(),
          })
          return
        }

        // Check if sync is needed (never synced or older than threshold)
        const settings = await getSettings(user)
        const thresholdTime = subMinutes(new Date(), thresholdFor(settings.sync_intervals, 'oura'))
        if (syncState?.last_sync_time && isBefore(thresholdTime, syncState.last_sync_time)) {
          return // Recently synced, no need to sync again
        }

        auditInfo(user, 'sync', `Auto-syncing Oura ${dataType}`)
        const accessToken = await config.oura.getAccessToken(user)
        const result = await syncOuraDataType(user, config.oura, ouraDataType, accessToken)
        triggerDeductionAfterSync(user, syncState, result)
      } catch (error) {
        auditError(user, 'sync', `Failed to auto-sync Oura ${dataType}`, { error: String(error) })
      }
    },

    syncRescueTimeIfNeeded: async (user: string): Promise<void> => {
      try {
        const settings = await getSettings(user)
        if (!settings.rescue_time_key) return

        const syncState = await getSyncState(user, 'rescuetime', 'productivity')

        if (isRescueTimeRateLimited(syncState)) return
        if (!rescueTimeNeedsSync(syncState, thresholdFor(settings.sync_intervals, 'rescuetime'))) return

        auditInfo(user, 'sync', 'Auto-syncing RescueTime productivity')
        const result = await syncRescueTimeData(user, settings.rescue_time_key)
        triggerDeductionAfterSync(user, syncState, result)
      } catch (error) {
        auditError(user, 'sync', 'Failed to auto-sync RescueTime', { error: String(error) })
      }
    },
  }
}
