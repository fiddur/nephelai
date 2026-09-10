/**
 * Gravl workout → activity mapping (#1042).
 *
 * A Gravl workout becomes a `strength_training` activity keyed by
 * `gravl-workout-<uuid>` — the same identity the Health Connect processor
 * derives from Gravl's `clientRecordId` (#1080). So when the session already
 * reached us through Health Connect (timing, HR), this upsert lands on that
 * row and adds what only the Gravl API has: the sets.
 *
 * Sets are stored structurally in `data.sets`, one entry per set with the
 * exercise name repeated, in the shape #1044 defines for repeated data
 * (`exercise`, `weight` in kg, `reps`, `time` in seconds) plus Gravl's extras.
 * A human-readable rendering also goes into a synced note so the detail is
 * visible before the UI can render set arrays.
 *
 * Only workouts logged in Gravl itself with at least one exercise are
 * imported (`isStrengthWorkout`). Gravl also lists every session it read from
 * Health Connect as an `External` workout; importing those would give each
 * watch activity an empty strength_training twin that outranks the original
 * in the cross-source merge.
 */

import type { Activity, RawRecord } from '../../db/types.ts'
import type { GravlSet, GravlWorkoutDetail, GravlWorkoutExercise, GravlWorkoutSummary } from './types.ts'

import {
  adoptLegacyActivity,
  deleteActivity,
  findActivityByExternalId,
  insertActivity,
  insertRawRecord,
  materializeSuperseded,
} from '../../db/index.ts'
import { upsertSyncedNote } from '../../db/notes.ts'
import { GRAVL_HC_ORIGIN, gravlWorkoutExternalId } from '../../services/source-identity.ts'

/** Gravl reports every set weight in pounds regardless of the user's unit preference. */
export const LB_PER_KG = 2.20462262

export const lbToKg = (lb: number): number => Math.round((lb / LB_PER_KG) * 1000) / 1000

export type GravlSetKind = 'normal' | 'warmup' | 'drop_set' | 'failure'

/** One set, in the repeated-data shape of #1044 with Gravl's extra fields. */
export interface GravlSetRecord {
  exercise: string
  exercise_id: number
  order: number
  set_type: GravlSetKind
  /** kg */
  weight: number | null
  reps: number | null
  /** seconds */
  time: number | null
  /** metres */
  distance: number | null
  rpe: number | null
  superset_id?: number
}

export interface GravlProcessDeps {
  adoptLegacyActivity: typeof adoptLegacyActivity
  deleteActivity: typeof deleteActivity
  findActivityByExternalId: typeof findActivityByExternalId
  insertActivity: typeof insertActivity
  insertRawRecord: typeof insertRawRecord
  materializeSuperseded: typeof materializeSuperseded
  upsertSyncedNote: typeof upsertSyncedNote
}

const defaultDeps: GravlProcessDeps = {
  adoptLegacyActivity,
  deleteActivity,
  findActivityByExternalId,
  insertActivity,
  insertRawRecord,
  materializeSuperseded,
  upsertSyncedNote,
}

/**
 * Gravl's OpenAPI spec declares its enums in PascalCase (`External`,
 * `DropSet`) but the live API serializes them lowercase (`external`,
 * `dropset`), so every enum comparison goes through this.
 */
const enumValue = (value: string): string => value.toLowerCase()

/** Health Connect sessions round-tripped into Gravl from other apps carry no sets and must not be imported. */
export const isExternalWorkout = (workout: Pick<GravlWorkoutSummary, 'type'>): boolean =>
  enumValue(workout.type) === 'external'

/**
 * A workout worth importing: logged in Gravl itself and holding at least one
 * exercise with a set. Anything else — an External round-trip of a watch
 * session, or a workout started and abandoned — carries nothing Aurboda does
 * not already have, and importing it would override the original's type.
 */
export const isStrengthWorkout = (workout: GravlWorkoutSummary | GravlWorkoutDetail): boolean => {
  if (isExternalWorkout(workout)) return false
  return 'exercises' in workout
    ? workout.exercises.some((exercise) => exercise.sets.length > 0)
    : workout.exerciseCount > 0
}

const setKind = (setType: GravlSet['setType']): GravlSetKind => {
  switch (enumValue(setType)) {
    case 'warmup':
      return 'warmup'
    case 'dropset':
      return 'drop_set'
    case 'failure':
      return 'failure'
    default:
      return 'normal'
  }
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

const buildSet = (exercise: GravlWorkoutExercise, set: GravlSet): GravlSetRecord => ({
  distance: positive(set.distance),
  exercise: exercise.exerciseName,
  exercise_id: exercise.exerciseId,
  order: set.order,
  reps: positive(set.reps),
  rpe: positive(set.rpe),
  set_type: setKind(set.setType),
  time: positive(set.duration),
  weight: positive(set.weight) === null ? null : lbToKg(set.weight),
  ...(exercise.supersetId !== null && exercise.supersetId !== undefined
    ? { superset_id: exercise.supersetId }
    : {}),
})

export const buildGravlSets = (detail: GravlWorkoutDetail): GravlSetRecord[] =>
  detail.exercises.flatMap((exercise) =>
    [...exercise.sets].sort((a, b) => a.order - b.order).map((set) => buildSet(exercise, set)),
  )

const formatSeconds = (seconds: number): string => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const formatSet = (set: GravlSetRecord): string => {
  const parts: string[] = []
  if (set.reps !== null && set.weight !== null) parts.push(`${set.reps}×${set.weight} kg`)
  else if (set.reps !== null) parts.push(`${set.reps} reps`)
  else if (set.weight !== null) parts.push(`${set.weight} kg`)
  if (set.time !== null) parts.push(formatSeconds(set.time))
  if (set.distance !== null) parts.push(`${set.distance} m`)
  if (parts.length === 0) parts.push('—')
  const flag =
    set.set_type === 'warmup'
      ? ' (w)'
      : set.set_type === 'drop_set'
        ? ' (drop)'
        : set.set_type === 'failure'
          ? ' (f)'
          : ''
  const rpe = set.rpe !== null ? ` @${set.rpe}` : ''
  return `${parts.join(' ')}${flag}${rpe}`
}

/**
 * Sets as readable text, one line per exercise in workout order:
 * `Bench Press: 8×60 kg (w), 8×80 kg, 6×80 kg @8`.
 */
export const formatGravlSetsNote = (detail: GravlWorkoutDetail): string => {
  const lines = detail.exercises
    .filter((exercise) => exercise.sets.length > 0)
    .map((exercise) => {
      const sets = [...exercise.sets]
        .sort((a, b) => a.order - b.order)
        .map((set) => formatSet(buildSet(exercise, set)))
      return `${exercise.exerciseName}: ${sets.join(', ')}`
    })
  const notes = detail.notes?.trim()
  return [notes, lines.join('\n')].filter((part) => part && part.length > 0).join('\n\n')
}

export const buildGravlActivity = (detail: GravlWorkoutDetail): Activity => {
  const sets = buildGravlSets(detail)
  return {
    activity_type: 'strength_training',
    data: {
      calories: positive(detail.calories) ?? undefined,
      exercise_count: detail.exercises.length,
      gravl_workout_id: detail.id.toLowerCase(),
      personal_record_count: detail.personalRecordCount,
      set_count: sets.length,
      sets,
      volume_kg: positive(detail.volume) === null ? 0 : lbToKg(detail.volume),
      workout_type: enumValue(detail.type),
    },
    end_time: new Date(detail.endDate),
    external_id: gravlWorkoutExternalId(detail.id),
    source: 'gravl',
    start_time: new Date(detail.startDate),
    title: detail.name,
  }
}

export const buildGravlRawRecord = (detail: GravlWorkoutDetail): RawRecord => ({
  data: detail as unknown as Record<string, unknown>,
  external_id: gravlWorkoutExternalId(detail.id),
  record_type: 'gravl_workout',
  recorded_at: new Date(detail.startDate),
  source: 'gravl',
})

/**
 * `enriched`: a row that reached us another way (Health Connect) gained its
 * sets; `updated`: a row Gravl itself wrote earlier was re-processed;
 * `created`: nothing existed for the workout; `skipped`: not a strength
 * workout (External round-trip or no exercises) and nothing to undo;
 * `retracted`: not a strength workout, and the empty row an earlier run
 * imported for it was soft-deleted.
 */
export type GravlProcessOutcome = 'enriched' | 'updated' | 'created' | 'skipped' | 'retracted'

/**
 * The footprint of the import itself: a row whose `data.sets` it wrote and
 * left empty. A Health Connect session stored under the Gravl identity has
 * no `sets` key until enriched, and an enriched row has a non-empty one.
 */
const isImportedWithoutSets = (activity: Activity): boolean => {
  const sets = activity.data?.sets
  return Array.isArray(sets) && sets.length === 0
}

/**
 * Soft-delete the activity an earlier run imported for a workout that
 * `isStrengthWorkout` rejects. Until 2026-09-09 the External check compared
 * PascalCase against Gravl's lowercase JSON, so every watch session Gravl had
 * read from Health Connect came back as an empty `strength_training` row that
 * outranked the Garmin original in the cross-source merge. Only rows the
 * import wrote (an empty `data.sets`) are touched, and supersession is
 * recomputed so the original resurfaces. Returns true when a row was
 * retracted.
 */
export const retractGravlNonWorkout = async (
  user: string,
  workoutId: string,
  deps: Pick<
    GravlProcessDeps,
    'deleteActivity' | 'findActivityByExternalId' | 'materializeSuperseded'
  > = defaultDeps,
): Promise<boolean> => {
  const existing = await deps.findActivityByExternalId(user, 'gravl', gravlWorkoutExternalId(workoutId))
  if (!existing?.id || !isImportedWithoutSets(existing)) return false
  const deleted = await deps.deleteActivity(user, existing.id)
  if (deleted) await deps.materializeSuperseded(user, existing.start_time)
  return deleted
}

/**
 * Store one Gravl workout. Claims the Health Connect copy of the session
 * (matched on Gravl's own `clientRecordId`) before upserting, so an existing
 * session is enriched in place and a new one created only when Health Connect
 * never delivered it.
 */
export const processGravlWorkout = async (
  user: string,
  detail: GravlWorkoutDetail,
  deps: GravlProcessDeps = defaultDeps,
): Promise<GravlProcessOutcome> => {
  if (!isStrengthWorkout(detail)) {
    return (await retractGravlNonWorkout(user, detail.id, deps)) ? 'retracted' : 'skipped'
  }

  const activity = buildGravlActivity(detail)
  const externalId = activity.external_id!

  await deps.insertRawRecord(user, buildGravlRawRecord(detail))

  await deps.adoptLegacyActivity(user, { external_id: externalId, source: 'gravl' }, [
    {
      client_record_id: `gravl-session-${detail.id}`,
      data_origin: GRAVL_HC_ORIGIN,
      kind: 'hc_client_record',
    },
    {
      client_record_id: `gravl-session-${detail.id.toLowerCase()}`,
      data_origin: GRAVL_HC_ORIGIN,
      kind: 'hc_client_record',
    },
  ])
  const existing = await deps.findActivityByExternalId(user, 'gravl', externalId)

  const id = (await deps.insertActivity(user, activity)) ?? existing?.id
  if (id) {
    await deps.upsertSyncedNote(
      user,
      'activity',
      id,
      'gravl',
      formatGravlSetsNote(detail),
      activity.start_time,
      activity.end_time,
    )
  }

  if (!existing) return 'created'
  return Array.isArray(existing.data?.sets) ? 'updated' : 'enriched'
}
