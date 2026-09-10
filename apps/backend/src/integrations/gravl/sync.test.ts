import { describe, expect, it, vi } from 'vitest'

import type { SyncState } from '../../db/types.ts'
import type { GravlClient } from './client.ts'
import type { GravlWorkoutDetail, GravlWorkoutSummary } from './types.ts'

vi.mock('../../db/index.ts', () => ({
  adoptLegacyActivity: vi.fn(),
  deleteActivity: vi.fn(),
  findActivityByExternalId: vi.fn(),
  getAllSyncStates: vi.fn(),
  getSyncState: vi.fn(),
  insertActivity: vi.fn(),
  insertRawRecord: vi.fn(),
  materializeSuperseded: vi.fn(),
  upsertSyncState: vi.fn(),
}))
vi.mock('../../db/notes.ts', () => ({ upsertSyncedNote: vi.fn() }))
vi.mock('../../services/settings.ts', () => ({ getSettings: vi.fn() }))

import { GravlApiError } from './client.ts'
import {
  calculateRetryAfter,
  enrichGravlWorkout,
  type GravlSyncDeps,
  isRateLimited,
  syncGravlWorkouts,
} from './sync.ts'

const NOW = new Date('2026-09-03T10:00:00Z')

const summary = (id: string, type: GravlWorkoutSummary['type'] = 'Today'): GravlWorkoutSummary => ({
  calories: 0,
  durationMinutes: 30,
  endDate: '2026-09-02T06:30:00Z',
  exerciseCount: 1,
  id,
  name: `Workout ${id}`,
  notes: null,
  personalRecordCount: 0,
  startDate: '2026-09-02T06:00:00Z',
  type,
  volume: 0,
})

const detailOf = (id: string): GravlWorkoutDetail => ({ ...summary(id), exercises: [] })

const page = (items: GravlWorkoutSummary[], hasNextPage = false) => ({
  hasNextPage,
  hasPreviousPage: false,
  items,
  pageNumber: 1,
  totalCount: items.length,
  totalPages: 1,
})

const makeClient = (overrides: Partial<GravlClient> = {}): GravlClient =>
  ({
    getAccessToken: vi.fn().mockResolvedValue('gat'),
    getWorkout: vi.fn(async (_token: string, id: string) => detailOf(id)),
    listWorkouts: vi
      .fn()
      .mockResolvedValue(
        page([
          summary('a'),
          summary('ext', 'external'),
          { ...summary('empty'), exerciseCount: 0 },
          summary('b'),
        ]),
      ),
    ...overrides,
  }) as unknown as GravlClient

const makeDeps = (
  state: SyncState | null,
  outcomes: Record<string, 'enriched' | 'updated' | 'created' | 'skipped'> = {},
) => {
  const deps: GravlSyncDeps = {
    auditError: vi.fn(),
    auditInfo: vi.fn(),
    getSyncState: vi.fn().mockResolvedValue(state),
    now: () => NOW,
    processWorkout: vi.fn(async (_user, detail) => outcomes[detail.id] ?? 'created'),
    retractWorkout: vi.fn(async (_user, workoutId) => workoutId === 'ext'),
    upsertSyncState: vi.fn(),
  }
  return deps
}

describe('syncGravlWorkouts', () => {
  it('lists the first-sync window, skips external and empty workouts, fetches detail and counts outcomes', async () => {
    const client = makeClient()
    const deps = makeDeps(null, { a: 'enriched', b: 'created' })

    const result = await syncGravlWorkouts('alice', client, {}, deps)

    expect(result).toEqual({
      activities_created: 1,
      activities_enriched: 1,
      activities_retracted: 1,
      status: 'success',
      workouts_processed: 2,
    })
    expect(deps.retractWorkout).toHaveBeenCalledWith('alice', 'ext')
    expect(deps.retractWorkout).toHaveBeenCalledWith('alice', 'empty')
    expect(deps.retractWorkout).toHaveBeenCalledTimes(2)
    expect(client.listWorkouts).toHaveBeenCalledWith('gat', {
      endDate: NOW,
      page: 1,
      startDate: new Date('2026-06-05T10:00:00Z'),
    })
    expect(client.getWorkout).toHaveBeenCalledTimes(2)
    expect(client.getWorkout).not.toHaveBeenCalledWith('gat', 'ext')
    expect(client.getWorkout).not.toHaveBeenCalledWith('gat', 'empty')
    expect(deps.upsertSyncState).toHaveBeenLastCalledWith('alice', {
      data_type: 'workouts',
      error_message: undefined,
      last_sync_time: NOW,
      provider: 'gravl',
      retry_after: undefined,
      status: 'idle',
    })
  })

  it('re-covers two days before the last sync on an incremental run and follows pagination', async () => {
    const client = makeClient({
      listWorkouts: vi
        .fn()
        .mockResolvedValueOnce(page([summary('a')], true))
        .mockResolvedValueOnce(page([summary('b')], false)),
    })
    const deps = makeDeps({
      data_type: 'workouts',
      last_sync_time: new Date('2026-09-01T10:00:00Z'),
      provider: 'gravl',
      status: 'idle',
    })

    const result = await syncGravlWorkouts('alice', client, {}, deps)

    expect(result.workouts_processed).toBe(2)
    expect(client.listWorkouts).toHaveBeenNthCalledWith(1, 'gat', {
      endDate: NOW,
      page: 1,
      startDate: new Date('2026-08-30T10:00:00Z'),
    })
    expect(client.listWorkouts).toHaveBeenNthCalledWith(2, 'gat', expect.objectContaining({ page: 2 }))
  })

  it('honours an explicit full resync start date', async () => {
    const client = makeClient()
    const deps = makeDeps({ data_type: 'workouts', last_sync_time: NOW, provider: 'gravl', status: 'idle' })
    await syncGravlWorkouts(
      'alice',
      client,
      { fullResync: true, startDate: new Date('2025-01-01T00:00:00Z') },
      deps,
    )
    expect(client.listWorkouts).toHaveBeenCalledWith(
      'gat',
      expect.objectContaining({ startDate: new Date('2025-01-01T00:00:00Z') }),
    )
  })

  it('skips while a rate-limit hold is in force', async () => {
    const client = makeClient()
    const retryAfter = new Date(NOW.getTime() + 600_000)
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const deps = makeDeps({
      data_type: 'workouts',
      provider: 'gravl',
      retry_after: retryAfter,
      status: 'rate_limited',
    })
    const result = await syncGravlWorkouts('alice', client, {}, deps)
    vi.useRealTimers()
    expect(result).toMatchObject({ status: 'skipped', retry_after: retryAfter.toISOString() })
    expect(client.listWorkouts).not.toHaveBeenCalled()
  })

  it('records the Retry-After on a 429 and does not advance last_sync_time', async () => {
    const client = makeClient({
      getWorkout: vi.fn().mockRejectedValue(new GravlApiError('Gravl API 429', 429, 120)),
    })
    const deps = makeDeps(null)

    const result = await syncGravlWorkouts('alice', client, {}, deps)

    expect(result.status).toBe('rate_limited')
    expect(result.retry_after).toBe('2026-09-03T10:02:00.000Z')
    const last = vi.mocked(deps.upsertSyncState).mock.calls.at(-1)![1]
    expect(last).toMatchObject({ retry_after: new Date('2026-09-03T10:02:00Z'), status: 'rate_limited' })
    expect(last.last_sync_time).toBeUndefined()
  })

  it('marks an auth failure as an error naming the token', async () => {
    const client = makeClient({
      getWorkout: vi.fn().mockRejectedValue(new GravlApiError('Gravl API 401', 401)),
    })
    const deps = makeDeps(null)
    const result = await syncGravlWorkouts('alice', client, {}, deps)
    expect(result.status).toBe('error')
    expect(vi.mocked(deps.upsertSyncState).mock.calls.at(-1)![1]).toMatchObject({
      error_message: 'Gravl rejected the token: Gravl API 401',
      status: 'error',
    })
    expect(deps.auditError).toHaveBeenCalled()
  })

  it('reports a not-connected user as an error rather than throwing', async () => {
    const client = makeClient({
      getAccessToken: vi.fn().mockRejectedValue(new Error('Gravl is not connected')),
    })
    const deps = makeDeps(null)
    const result = await syncGravlWorkouts('alice', client, {}, deps)
    expect(result).toMatchObject({ error: 'Gravl is not connected', status: 'error' })
  })
})

describe('enrichGravlWorkout', () => {
  const enrichDeps = (state: SyncState | null, processWorkout = vi.fn().mockResolvedValue('enriched')) => ({
    auditInfo: vi.fn(),
    getSyncState: vi.fn().mockResolvedValue(state),
    processWorkout,
  })

  it('fetches one workout and processes it', async () => {
    const client = makeClient()
    const deps = enrichDeps(null)
    expect(await enrichGravlWorkout('alice', client, 'a', deps)).toBe('enriched')
    expect(client.getWorkout).toHaveBeenCalledWith('gat', 'a')
    expect(deps.processWorkout).toHaveBeenCalledWith('alice', expect.objectContaining({ id: 'a' }))
  })

  it('propagates API failures so the queue can retry', async () => {
    const client = makeClient({
      getWorkout: vi.fn().mockRejectedValue(new GravlApiError('Gravl API 404', 404)),
    })
    await expect(enrichGravlWorkout('alice', client, 'a', enrichDeps(null))).rejects.toThrow(/404/)
  })

  it('skips while a rate-limit hold is in force instead of hitting Gravl again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const client = makeClient()
    const deps = enrichDeps({
      data_type: 'workouts',
      provider: 'gravl',
      retry_after: new Date(NOW.getTime() + 600_000),
      status: 'rate_limited',
    })
    expect(await enrichGravlWorkout('alice', client, 'a', deps)).toBe('skipped')
    vi.useRealTimers()
    expect(client.getWorkout).not.toHaveBeenCalled()
    expect(deps.auditInfo).toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('prefers Retry-After over the fallback hold', () => {
    expect(calculateRetryAfter(NOW, 30)).toEqual(new Date('2026-09-03T10:00:30Z'))
    expect(calculateRetryAfter(NOW)).toEqual(new Date('2026-09-03T10:05:00Z'))
    expect(calculateRetryAfter(NOW, 0)).toEqual(new Date('2026-09-03T10:05:00Z'))
  })

  it('only treats a future rate_limited hold as limiting', () => {
    expect(isRateLimited(null)).toBe(false)
    expect(
      isRateLimited({
        data_type: 'workouts',
        provider: 'gravl',
        retry_after: new Date(0),
        status: 'rate_limited',
      }),
    ).toBe(false)
  })
})
