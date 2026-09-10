/**
 * Gravl REST API types (https://gravl.ai/developers, OpenAPI at
 * https://gravl.ai/openapi.json). Field names mirror the API's camelCase JSON;
 * conversion to Aurboda's snake_case happens in process.ts.
 *
 * Units per the API conventions: set weights are ALWAYS pounds regardless of
 * the user's preference, set distance is metres, set duration is seconds and
 * workout duration is minutes.
 */

/**
 * Enum casing: the OpenAPI spec declares these names in PascalCase, but the
 * live API serializes them in lowercase (`"type": "external"`,
 * `"setType": "warmup"`). Both spellings are admitted here and every
 * comparison in process.ts is case-insensitive.
 */
type GravlWorkoutTypeName = 'Today' | 'Custom' | 'Saved' | 'New' | 'Public' | 'External' | 'NewSaved'
type GravlSetTypeName = 'Normal' | 'Warmup' | 'DropSet' | 'Failure'

/**
 * `External` workouts are Health Connect sessions round-tripped INTO Gravl
 * from other apps (Garmin, Polar, …). They carry no exercise data and must be
 * dropped, otherwise every watch session would gain a third copy.
 */
export type GravlWorkoutType = GravlWorkoutTypeName | Lowercase<GravlWorkoutTypeName>

export type GravlSetType = GravlSetTypeName | Lowercase<GravlSetTypeName>

export interface GravlSet {
  order: number
  reps: number
  /** Pounds, always. */
  weight: number
  /** Seconds, for timed sets (planks, holds). */
  duration: number | null
  /** Metres. */
  distance: number | null
  rpe: number | null
  setType: GravlSetType
}

export interface GravlWorkoutExercise {
  exerciseId: number
  exerciseName: string
  supersetId: number | null
  sets: GravlSet[]
}

export interface GravlWorkoutSummary {
  id: string
  name: string
  notes: string | null
  /** ISO 8601, UTC. */
  startDate: string
  endDate: string
  durationMinutes: number
  type: GravlWorkoutType
  volume: number
  calories: number
  personalRecordCount: number
  exerciseCount: number
}

export interface GravlWorkoutDetail extends Omit<GravlWorkoutSummary, 'exerciseCount'> {
  exercises: GravlWorkoutExercise[]
}

export interface GravlPage<T> {
  items: T[]
  pageNumber: number
  totalPages: number
  totalCount: number
  hasPreviousPage: boolean
  hasNextPage: boolean
}

export interface GravlTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

/** RFC 9457 problem document, as returned on every non-2xx response. */
export interface GravlProblem {
  status?: number
  title?: string
  detail?: string
}
