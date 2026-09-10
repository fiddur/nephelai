import { describe, expect, it, vi } from 'vitest'

import type { GravlWorkoutDetail, GravlWorkoutSummary } from './types.ts'

vi.mock('../../db/index.ts', () => ({
  adoptLegacyActivity: vi.fn(),
  deleteActivity: vi.fn(),
  findActivityByExternalId: vi.fn(),
  insertActivity: vi.fn(),
  insertRawRecord: vi.fn(),
  materializeSuperseded: vi.fn(),
}))
vi.mock('../../db/notes.ts', () => ({ upsertSyncedNote: vi.fn() }))

import {
  buildGravlActivity,
  buildGravlSets,
  formatGravlSetsNote,
  type GravlProcessDeps,
  isExternalWorkout,
  isStrengthWorkout,
  lbToKg,
  processGravlWorkout,
  retractGravlNonWorkout,
} from './process.ts'

const WORKOUT_ID = '97248067-7947-4715-8FC9-d0048369a0d0'

const detail = (overrides: Partial<GravlWorkoutDetail> = {}): GravlWorkoutDetail => ({
  calories: 210,
  durationMinutes: 29,
  endDate: '2026-09-03T05:45:12Z',
  exercises: [
    {
      exerciseId: 12,
      exerciseName: 'Bench Press',
      sets: [
        { distance: null, duration: null, order: 2, reps: 8, rpe: null, setType: 'Normal', weight: 176.3698 },
        { distance: null, duration: null, order: 1, reps: 10, rpe: null, setType: 'Warmup', weight: 88.1849 },
        { distance: null, duration: null, order: 3, reps: 6, rpe: 8, setType: 'Failure', weight: 176.3698 },
      ],
      supersetId: null,
    },
    {
      exerciseId: 40,
      exerciseName: 'Plank',
      sets: [{ distance: null, duration: 40, order: 1, reps: 0, rpe: null, setType: 'Normal', weight: 0 }],
      supersetId: 3,
    },
  ],
  id: WORKOUT_ID,
  name: 'Push day',
  notes: 'Felt strong',
  personalRecordCount: 1,
  startDate: '2026-09-03T05:16:12Z',
  type: 'Today',
  volume: 3527.396,
  ...overrides,
})

describe('unit conversion', () => {
  it('converts Gravl’s pounds to kilograms with a clean round-trip', () => {
    expect(lbToKg(48.50164)).toBe(22)
    expect(lbToKg(176.3698)).toBe(80)
    expect(lbToKg(0)).toBe(0)
  })
})

describe('buildGravlSets', () => {
  it('flattens exercises into ordered sets in the #1044 shape with kg weights', () => {
    const sets = buildGravlSets(detail())
    expect(sets.map((s) => [s.exercise, s.order, s.set_type, s.weight, s.reps, s.time, s.rpe])).toEqual([
      ['Bench Press', 1, 'warmup', 40, 10, null, null],
      ['Bench Press', 2, 'normal', 80, 8, null, null],
      ['Bench Press', 3, 'failure', 80, 6, null, 8],
      ['Plank', 1, 'normal', null, null, 40, null],
    ])
    expect(sets[3]).toMatchObject({ exercise_id: 40, superset_id: 3 })
    expect('superset_id' in sets[0]).toBe(false)
  })

  it('maps the lowercase set types the live API actually sends', () => {
    const sets = buildGravlSets(
      detail({
        exercises: [
          {
            exerciseId: 12,
            exerciseName: 'Bench Press',
            sets: [
              {
                distance: null,
                duration: null,
                order: 1,
                reps: 10,
                rpe: null,
                setType: 'warmup',
                weight: 88,
              },
              {
                distance: null,
                duration: null,
                order: 2,
                reps: 8,
                rpe: null,
                setType: 'normal',
                weight: 176,
              },
              {
                distance: null,
                duration: null,
                order: 3,
                reps: 8,
                rpe: null,
                setType: 'dropset',
                weight: 132,
              },
              { distance: null, duration: null, order: 4, reps: 6, rpe: 9, setType: 'failure', weight: 176 },
            ],
            supersetId: null,
          },
        ],
      }),
    )
    expect(sets.map((s) => s.set_type)).toEqual(['warmup', 'normal', 'drop_set', 'failure'])
  })
})

describe('buildGravlActivity', () => {
  it('builds a strength_training activity keyed by the workout id with summary data', () => {
    const activity = buildGravlActivity(detail())
    expect(activity).toMatchObject({
      activity_type: 'strength_training',
      end_time: new Date('2026-09-03T05:45:12Z'),
      external_id: 'gravl-workout-97248067-7947-4715-8fc9-d0048369a0d0',
      source: 'gravl',
      start_time: new Date('2026-09-03T05:16:12Z'),
      title: 'Push day',
    })
    expect(activity.data).toMatchObject({
      calories: 210,
      exercise_count: 2,
      gravl_workout_id: '97248067-7947-4715-8fc9-d0048369a0d0',
      personal_record_count: 1,
      set_count: 4,
      volume_kg: 1600,
      workout_type: 'today',
    })
  })
})

describe('formatGravlSetsNote', () => {
  it('renders one line per exercise with warmup, failure, rpe and timed sets', () => {
    expect(formatGravlSetsNote(detail())).toBe(
      'Felt strong\n\nBench Press: 10×40 kg (w), 8×80 kg, 6×80 kg (f) @8\nPlank: 0:40',
    )
  })

  it('omits the notes block when the workout has none', () => {
    expect(formatGravlSetsNote(detail({ notes: null }))).toBe(
      'Bench Press: 10×40 kg (w), 8×80 kg, 6×80 kg (f) @8\nPlank: 0:40',
    )
  })
})

describe('processGravlWorkout', () => {
  const makeDeps = (
    existing: { id: string; data?: Record<string, unknown>; start_time?: Date } | null,
  ): GravlProcessDeps => ({
    adoptLegacyActivity: vi.fn().mockResolvedValue(null),
    deleteActivity: vi.fn().mockResolvedValue(true),
    findActivityByExternalId: vi.fn().mockResolvedValue(existing),
    insertActivity: vi.fn().mockResolvedValue('act-1'),
    insertRawRecord: vi.fn(),
    materializeSuperseded: vi.fn(),
    upsertSyncedNote: vi.fn(),
  })

  it('skips external round-trips without touching the database', async () => {
    const deps = makeDeps(null)
    expect(await processGravlWorkout('alice', detail({ type: 'external' }), deps)).toBe('skipped')
    expect(deps.insertRawRecord).not.toHaveBeenCalled()
    expect(deps.insertActivity).not.toHaveBeenCalled()
    expect(deps.deleteActivity).not.toHaveBeenCalled()
  })

  it('skips a workout with no logged set', async () => {
    const deps = makeDeps(null)
    expect(await processGravlWorkout('alice', detail({ exercises: [] }), deps)).toBe('skipped')
    expect(deps.insertActivity).not.toHaveBeenCalled()
  })

  it('retracts the empty row an earlier run imported for an external workout', async () => {
    const startTime = new Date('2026-09-08T09:04:51+02:00')
    const deps = makeDeps({
      data: { sets: [], workout_type: 'external' },
      id: 'act-9',
      start_time: startTime,
    })
    expect(await processGravlWorkout('alice', detail({ type: 'external' }), deps)).toBe('retracted')
    expect(deps.findActivityByExternalId).toHaveBeenCalledWith(
      'alice',
      'gravl',
      'gravl-workout-97248067-7947-4715-8fc9-d0048369a0d0',
    )
    expect(deps.deleteActivity).toHaveBeenCalledWith('alice', 'act-9')
    expect(deps.materializeSuperseded).toHaveBeenCalledWith('alice', startTime)
    expect(deps.insertActivity).not.toHaveBeenCalled()
  })

  it('leaves a Health Connect session stored under the Gravl identity alone', async () => {
    const deps = makeDeps({ data: { gravl_workout_id: 'x', metadata: {} }, id: 'act-hc' })
    expect(await processGravlWorkout('alice', detail({ type: 'external' }), deps)).toBe('skipped')
    expect(deps.deleteActivity).not.toHaveBeenCalled()
  })

  it('leaves a row that already carries sets alone', async () => {
    const deps = makeDeps({ data: { sets: [{ exercise: 'Bench Press' }] }, id: 'act-full' })
    expect(await retractGravlNonWorkout('alice', WORKOUT_ID, deps)).toBe(false)
    expect(deps.deleteActivity).not.toHaveBeenCalled()
    expect(deps.materializeSuperseded).not.toHaveBeenCalled()
  })

  it('does not recompute supersession when the row was already gone', async () => {
    const deps = makeDeps({ data: { sets: [] }, id: 'act-gone', start_time: new Date() })
    vi.mocked(deps.deleteActivity).mockResolvedValue(false)
    expect(await retractGravlNonWorkout('alice', WORKOUT_ID, deps)).toBe(false)
    expect(deps.materializeSuperseded).not.toHaveBeenCalled()
  })

  it('claims the Health Connect copy by Gravl’s clientRecordId, then upserts and writes the note', async () => {
    const deps = makeDeps({ id: 'act-1' })
    expect(await processGravlWorkout('alice', detail(), deps)).toBe('enriched')

    expect(deps.insertRawRecord).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({
        external_id: 'gravl-workout-97248067-7947-4715-8fc9-d0048369a0d0',
        record_type: 'gravl_workout',
        source: 'gravl',
      }),
    )
    expect(deps.adoptLegacyActivity).toHaveBeenCalledWith(
      'alice',
      { external_id: 'gravl-workout-97248067-7947-4715-8fc9-d0048369a0d0', source: 'gravl' },
      expect.arrayContaining([
        expect.objectContaining({
          client_record_id: `gravl-session-${WORKOUT_ID}`,
          data_origin: 'com.liteup.getgains',
          kind: 'hc_client_record',
        }),
      ]),
    )
    expect(deps.insertActivity).toHaveBeenCalledWith('alice', expect.objectContaining({ source: 'gravl' }))
    expect(deps.upsertSyncedNote).toHaveBeenCalledWith(
      'alice',
      'activity',
      'act-1',
      'gravl',
      expect.stringContaining('Bench Press: 10×40 kg (w)'),
      new Date('2026-09-03T05:16:12Z'),
      new Date('2026-09-03T05:45:12Z'),
    )
  })

  it('reports a created activity when nothing existed for the identity', async () => {
    const deps = makeDeps(null)
    expect(await processGravlWorkout('alice', detail(), deps)).toBe('created')
  })

  it('reports a re-processed Gravl row as updated, not enriched', async () => {
    const deps = makeDeps({ data: { sets: [] }, id: 'act-1' })
    expect(await processGravlWorkout('alice', detail(), deps)).toBe('updated')
  })

  it('treats external workouts by type, not by name, in either casing', () => {
    expect(isExternalWorkout({ type: 'External' })).toBe(true)
    expect(isExternalWorkout({ type: 'external' })).toBe(true)
    expect(isExternalWorkout({ type: 'NewSaved' })).toBe(false)
    expect(isExternalWorkout({ type: 'custom' })).toBe(false)
  })
})

describe('isStrengthWorkout', () => {
  const summary: GravlWorkoutSummary = {
    calories: 210,
    durationMinutes: 29,
    endDate: '2026-09-03T05:45:12Z',
    exerciseCount: 2,
    id: WORKOUT_ID,
    name: 'Push day',
    notes: null,
    personalRecordCount: 1,
    startDate: '2026-09-03T05:16:12Z',
    type: 'today',
    volume: 3527.396,
  }

  it('accepts a Gravl-logged workout with sets, by summary or detail', () => {
    expect(isStrengthWorkout(summary)).toBe(true)
    expect(isStrengthWorkout(detail())).toBe(true)
  })

  it('rejects external round-trips regardless of exercise count', () => {
    expect(isStrengthWorkout({ ...summary, type: 'external' })).toBe(false)
    expect(isStrengthWorkout(detail({ type: 'External' }))).toBe(false)
  })

  it('rejects workouts without a logged set', () => {
    expect(isStrengthWorkout({ ...summary, exerciseCount: 0 })).toBe(false)
    expect(isStrengthWorkout(detail({ exercises: [] }))).toBe(false)
    expect(
      isStrengthWorkout(
        detail({ exercises: [{ exerciseId: 1, exerciseName: 'Squat', sets: [], supersetId: null }] }),
      ),
    ).toBe(false)
  })
})
