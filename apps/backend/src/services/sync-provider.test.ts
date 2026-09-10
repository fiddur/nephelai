import { beforeEach, describe, expect, test, vi } from 'vitest'

import * as dbIndex from '../db/index.ts'

// Partial mock: keep the real exports (other sync integrations reference them
// at module load) and override only getSyncState.
vi.mock('../db/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof dbIndex>()),
  getSyncState: vi.fn(),
}))

vi.mock('./settings.ts', () => ({
  getSettings: vi.fn(),
}))

vi.mock('./audit-log.ts', () => ({
  auditError: vi.fn(),
  auditInfo: vi.fn(),
  auditWarn: vi.fn(),
}))

vi.mock('../integrations/lastfm/sync.ts', () => ({
  DEFAULT_SYNC_HISTORY_DAYS: 30,
  syncLastFmData: vi.fn(),
}))

vi.mock('../integrations/garmin/sync.ts', () => ({
  isRateLimited: vi.fn().mockReturnValue(false),
  syncActivityDetails: vi.fn().mockResolvedValue(undefined),
  syncGarminDataType: vi.fn(),
}))

vi.mock('../integrations/oura/sync.ts', () => ({
  isRateLimited: vi.fn().mockReturnValue(false),
  syncOuraDataType: vi.fn(),
}))

vi.mock('../integrations/rescuetime/sync.ts', () => ({
  isRateLimited: vi.fn().mockReturnValue(false),
  needsSync: vi.fn().mockReturnValue(true),
  syncRescueTimeData: vi.fn(),
}))

vi.mock('../integrations/gravl/sync.ts', () => ({
  DEFAULT_SYNC_HISTORY_DAYS: 90,
  isRateLimited: vi.fn().mockReturnValue(false),
  syncGravlWorkouts: vi.fn(),
}))

import type { GravlClient } from '../integrations/gravl/client.ts'

import { syncGarminDataType } from '../integrations/garmin/sync.ts'
import { syncGravlWorkouts } from '../integrations/gravl/sync.ts'
import { syncLastFmData } from '../integrations/lastfm/sync.ts'
import { syncOuraDataType } from '../integrations/oura/sync.ts'
import { syncRescueTimeData } from '../integrations/rescuetime/sync.ts'
import { getSettings } from './settings.ts'
import { createSyncProvider, resolveSyncInterval } from './sync-provider.ts'

describe('createSyncProvider › syncLastFmIfNeeded', () => {
  const lastSync = new Date('2026-06-01T00:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSettings).mockResolvedValue({ lastfm_username: 'bob' } as never)
    vi.mocked(dbIndex.getSyncState).mockResolvedValue({ last_sync_time: lastSync } as never)
  })

  const build = (onActivitySynced = vi.fn()) => ({
    onActivitySynced,
    provider: createSyncProvider({ getLastFmApiKey: async () => 'api-key', onActivitySynced }),
  })

  test('triggers deduction over the synced window when new scrobbles arrived', async () => {
    vi.mocked(syncLastFmData).mockResolvedValue({ scrobbles_processed: 3, status: 'success' })
    const { onActivitySynced, provider } = build()

    await provider.syncLastFmIfNeeded('alice')

    expect(syncLastFmData).toHaveBeenCalledWith('alice', 'api-key', 'bob')
    expect(onActivitySynced).toHaveBeenCalledTimes(1)
    const [user, activityType, start, end] = onActivitySynced.mock.calls[0]
    expect(user).toBe('alice')
    expect(activityType).toBe('*') // evaluate all rules
    expect(start).toEqual(lastSync) // window starts at last_sync_time
    expect((end as Date).getTime()).toBeGreaterThan((start as Date).getTime())
  })

  test('does not trigger deduction when no new scrobbles were processed', async () => {
    vi.mocked(syncLastFmData).mockResolvedValue({ scrobbles_processed: 0, status: 'success' })
    const { onActivitySynced, provider } = build()

    await provider.syncLastFmIfNeeded('alice')

    expect(onActivitySynced).not.toHaveBeenCalled()
  })

  test('does not trigger deduction when the sync failed', async () => {
    vi.mocked(syncLastFmData).mockResolvedValue({
      error: 'boom',
      scrobbles_processed: 0,
      status: 'error',
    })
    const { onActivitySynced, provider } = build()

    await provider.syncLastFmIfNeeded('alice')

    expect(onActivitySynced).not.toHaveBeenCalled()
  })

  test('skips syncing entirely when synced within the threshold', async () => {
    vi.mocked(dbIndex.getSyncState).mockResolvedValue({ last_sync_time: new Date() } as never)
    vi.mocked(syncLastFmData).mockResolvedValue({ scrobbles_processed: 5, status: 'success' })
    const { onActivitySynced, provider } = build()

    await provider.syncLastFmIfNeeded('alice')

    expect(syncLastFmData).not.toHaveBeenCalled()
    expect(onActivitySynced).not.toHaveBeenCalled()
  })
})

describe('createSyncProvider › syncGarminIfNeeded', () => {
  const lastSync = new Date('2026-06-01T00:00:00Z')
  const garmin = {} as never // only handed to the mocked syncGarminDataType

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSettings).mockResolvedValue({} as never) // no disabled data types
    vi.mocked(dbIndex.getSyncState).mockResolvedValue({ last_sync_time: lastSync } as never)
  })

  const build = () => {
    const onActivitySynced = vi.fn()
    return { onActivitySynced, provider: createSyncProvider({ garmin, onActivitySynced }) }
  }

  test('triggers deduction over the synced window after a successful sync with new records', async () => {
    vi.mocked(syncGarminDataType).mockResolvedValue({
      data_type: 'sleep',
      records_processed: 4,
      status: 'success',
    } as never)
    const { onActivitySynced, provider } = build()

    await provider.syncGarminIfNeeded('alice', 'sleep')

    expect(onActivitySynced).toHaveBeenCalledTimes(1)
    const [user, activityType, start] = onActivitySynced.mock.calls[0]
    expect(user).toBe('alice')
    expect(activityType).toBe('*')
    expect(start).toEqual(lastSync)
  })

  test('does not trigger deduction when no new records were processed', async () => {
    vi.mocked(syncGarminDataType).mockResolvedValue({
      data_type: 'sleep',
      records_processed: 0,
      status: 'success',
    } as never)
    const { onActivitySynced, provider } = build()

    await provider.syncGarminIfNeeded('alice', 'sleep')

    expect(onActivitySynced).not.toHaveBeenCalled()
  })

  test('does not trigger deduction when the sync errored', async () => {
    vi.mocked(syncGarminDataType).mockResolvedValue({
      data_type: 'sleep',
      records_processed: 0,
      status: 'error',
    } as never)
    const { onActivitySynced, provider } = build()

    await provider.syncGarminIfNeeded('alice', 'sleep')

    expect(onActivitySynced).not.toHaveBeenCalled()
  })

  test('covers the full backfill window on a first sync (no prior sync state)', async () => {
    vi.mocked(dbIndex.getSyncState).mockResolvedValue(null)
    vi.mocked(syncGarminDataType).mockResolvedValue({
      data_type: 'sleep',
      records_processed: 4,
      status: 'success',
    } as never)
    const { onActivitySynced, provider } = build()

    await provider.syncGarminIfNeeded('alice', 'sleep')

    expect(onActivitySynced).toHaveBeenCalledTimes(1)
    const [, , start, end] = onActivitySynced.mock.calls[0]
    const daysBack = ((end as Date).getTime() - (start as Date).getTime()) / 86_400_000
    expect(daysBack).toBeGreaterThan(89.5) // 90-day fallback, not the Last.fm 30
    expect(daysBack).toBeLessThan(90.5)
  })

  test('skips entirely when the data type is disabled', async () => {
    vi.mocked(getSettings).mockResolvedValue({ garmin_disabled_data_types: ['sleep'] } as never)
    const { onActivitySynced, provider } = build()

    await provider.syncGarminIfNeeded('alice', 'sleep')

    expect(syncGarminDataType).not.toHaveBeenCalled()
    expect(onActivitySynced).not.toHaveBeenCalled()
  })
})

describe('createSyncProvider › syncOuraIfNeeded', () => {
  const lastSync = new Date('2026-06-01T00:00:00Z')
  const oura = { getAccessToken: vi.fn().mockResolvedValue('token') } as never

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSettings).mockResolvedValue({} as never)
    vi.mocked(dbIndex.getSyncState).mockResolvedValue({ last_sync_time: lastSync } as never)
  })

  test('triggers deduction over the synced window after a successful sync with new records', async () => {
    vi.mocked(syncOuraDataType).mockResolvedValue({ records_processed: 2, status: 'success' } as never)
    const onActivitySynced = vi.fn()
    const provider = createSyncProvider({ oura, onActivitySynced })

    await provider.syncOuraIfNeeded('alice', 'sessions')

    expect(onActivitySynced).toHaveBeenCalledWith('alice', '*', lastSync, expect.any(Date))
  })

  test('does not trigger deduction when no new records were processed', async () => {
    vi.mocked(syncOuraDataType).mockResolvedValue({ records_processed: 0, status: 'success' } as never)
    const onActivitySynced = vi.fn()
    const provider = createSyncProvider({ oura, onActivitySynced })

    await provider.syncOuraIfNeeded('alice', 'sessions')

    expect(onActivitySynced).not.toHaveBeenCalled()
  })
})

describe('createSyncProvider › syncRescueTimeIfNeeded', () => {
  const lastSync = new Date('2026-06-01T00:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSettings).mockResolvedValue({ rescue_time_key: 'rt-key' } as never)
    vi.mocked(dbIndex.getSyncState).mockResolvedValue({ last_sync_time: lastSync } as never)
  })

  test('triggers deduction over the synced window after a successful sync with new records', async () => {
    vi.mocked(syncRescueTimeData).mockResolvedValue({ records_processed: 7, status: 'success' } as never)
    const onActivitySynced = vi.fn()
    const provider = createSyncProvider({ onActivitySynced })

    await provider.syncRescueTimeIfNeeded('alice')

    expect(onActivitySynced).toHaveBeenCalledWith('alice', '*', lastSync, expect.any(Date))
  })

  test('skips when no RescueTime key is configured', async () => {
    vi.mocked(getSettings).mockResolvedValue({} as never)
    vi.mocked(syncRescueTimeData).mockResolvedValue({ records_processed: 7, status: 'success' } as never)
    const onActivitySynced = vi.fn()
    const provider = createSyncProvider({ onActivitySynced })

    await provider.syncRescueTimeIfNeeded('alice')

    expect(syncRescueTimeData).not.toHaveBeenCalled()
    expect(onActivitySynced).not.toHaveBeenCalled()
  })
})

describe('resolveSyncInterval', () => {
  test('prefers the provider entry, then default, then the server fallback', () => {
    expect(resolveSyncInterval({ default: 60, gravl: 15 }, 'gravl', 30)).toBe(15)
    expect(resolveSyncInterval({ default: 60, gravl: 15 }, 'garmin', 30)).toBe(60)
    expect(resolveSyncInterval({}, 'garmin', 30)).toBe(30)
    expect(resolveSyncInterval(undefined, 'oura', 30)).toBe(30)
  })

  test('ignores non-positive values', () => {
    expect(resolveSyncInterval({ gravl: 0 }, 'gravl', 30)).toBe(30)
  })
})

describe('createSyncProvider › syncGravlIfNeeded', () => {
  const lastSync = new Date('2026-06-01T00:00:00Z')

  const gravl = (kind: 'oauth' | 'token' | null) =>
    ({ connectionKind: vi.fn().mockResolvedValue(kind) }) as unknown as GravlClient

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getSettings).mockResolvedValue({} as never)
    vi.mocked(dbIndex.getSyncState).mockResolvedValue({ last_sync_time: lastSync } as never)
    vi.mocked(syncGravlWorkouts).mockResolvedValue({
      activities_created: 0,
      activities_enriched: 2,
      activities_retracted: 0,
      status: 'success',
      workouts_processed: 2,
    })
  })

  test('syncs a connected user whose last sync is stale and fires deduction over the window', async () => {
    const onActivitySynced = vi.fn()
    const client = gravl('token')
    const provider = createSyncProvider({ gravl: client, onActivitySynced })

    await provider.syncGravlIfNeeded('alice')

    expect(syncGravlWorkouts).toHaveBeenCalledWith('alice', client)
    expect(onActivitySynced).toHaveBeenCalledWith('alice', '*', lastSync, expect.any(Date))
  })

  test('does nothing for a user without a Gravl connection', async () => {
    const provider = createSyncProvider({ gravl: gravl(null) })
    await provider.syncGravlIfNeeded('alice')
    expect(syncGravlWorkouts).not.toHaveBeenCalled()
  })

  test('honours the user’s own interval over the server threshold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-01T00:20:00Z'))
    vi.mocked(getSettings).mockResolvedValue({ sync_intervals: { gravl: 60 } } as never)
    const provider = createSyncProvider({ gravl: gravl('oauth'), syncThresholdMinutes: 10 })

    await provider.syncGravlIfNeeded('alice')
    expect(syncGravlWorkouts).not.toHaveBeenCalled()

    vi.mocked(getSettings).mockResolvedValue({ sync_intervals: { default: 15 } } as never)
    await provider.syncGravlIfNeeded('alice')
    expect(syncGravlWorkouts).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('skips when the gravl integration is not configured', async () => {
    const provider = createSyncProvider({})
    await provider.syncGravlIfNeeded('alice')
    expect(syncGravlWorkouts).not.toHaveBeenCalled()
  })
})
