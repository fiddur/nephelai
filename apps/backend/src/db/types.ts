/**
 * Shared type definitions for all db modules.
 *
 * Interfaces and type aliases extracted from the monolithic db.ts.
 * These are imported by both domain modules and row-mappers to avoid circular dependencies.
 */
import type {
  ActivityType,
  BiologicalSex,
  Confidence,
  DashboardConfig,
  DataSource,
  EntityType,
  GarminDataType,
  GeocodeStatus,
  MetricType,
  ReportFlag,
  SyncStatus,
  TrainingLoadSettings,
} from '@aurboda/api-spec'

// ============================================================================
// Feed (ActivityPub) — cached remote-actor presentation
// ============================================================================

/**
 * A remote actor's cached presentation snapshot (handle / display name /
 * avatar). Several feed tables keep one, and an inbound `Update{Person}`
 * refreshes them together (#1057).
 *
 * Declared here rather than imported from the ActivityPub service that produces
 * it (`ActorPresentation`, the same three fields): the db layer never imports
 * from services.
 */
export interface CachedActorPresentation {
  handle: string | null
  display_name: string | null
  avatar_url: string | null
}

// ============================================================================
// Raw Records
// ============================================================================

export interface RawRecord {
  id?: string
  source: DataSource
  record_type: string
  external_id?: string
  recorded_at: Date
  data: Record<string, unknown>
}

// ============================================================================
// Time Series
// ============================================================================

export interface TimeSeriesPoint {
  time: Date
  metric: string
  value: number
  unit?: string
  source: DataSource
}

export interface MetricStats {
  metric: string
  count: number
  min: number
  max: number
  avg: number
  stddev: number
  unit: string
}

export interface DailyMetricAggregate {
  date: string
  metric: string
  avg: number
  sum: number
}

export interface BucketedMetricData {
  bucket_start: Date
  metric: MetricType
  avg: number
  min: number
  max: number
  count: number
  sum: number
  first_time: Date
  last_time: Date
}

// ============================================================================
// Activities
// ============================================================================

export interface Activity {
  id?: string
  source: DataSource
  external_id?: string
  activity_type: ActivityType
  start_time: Date
  end_time?: Date
  title?: string
  data?: Record<string, unknown>
  deleted_at?: Date
  /** If set, this activity is a cross-source duplicate of the referenced activity. */
  superseded_by?: string
  /**
   * The synced activity ids this aurboda row is an override of. A
   * non-empty array marks this row as an override; the listed ids are
   * hidden by it in merged views and survive integration re-syncs.
   * Cascades on any target's delete: each target's removal unlinks it
   * from the override (the override row stays and its `override_target_ids`
   * shrinks); deleting the override removes all links.
   *
   * Multi-target overrides (#735) — one aurboda row may claim a
   * cross-source merge group as a whole rather than just one source row.
   * Only aurboda rows may carry an override.
   */
  override_target_ids?: string[]
}

/**
 * How to find an activity row written before external ids existed, so it can
 * be claimed for a `(source, external_id)` identity instead of duplicated
 * (#1080). Every matcher implies `external_id IS NULL AND deleted_at IS NULL`.
 */
export type LegacyMatch =
  /** A `garmin` row keyed only by `data.garmin_activity_id`. */
  | { kind: 'garmin_activity_id'; garmin_activity_id: number }
  /** A `health_connect` row whose HC metadata names this origin + client record. */
  | { kind: 'hc_client_record'; data_origin: string; client_record_id: string }
  /** A row of the given source at exactly this type + start (HC re-sending an older record). */
  | { kind: 'source_type_start'; source: string; activity_type: string; start_time: Date }

export interface MergedActivity extends Activity {
  source_ids?: string[] // only set when 2+ activities were merged
}

export interface ActivityUpdate {
  activity_type?: ActivityType
  start_time?: Date
  end_time?: Date | null
  title?: string
  data?: Record<string, unknown>
}

// ============================================================================
// Locations
// ============================================================================

export interface Location {
  id?: string
  source?: DataSource
  time: Date
  lat: number
  lon: number
  accuracy?: number
  altitude?: number
  velocity?: number
  regions?: string[]
}

export interface Place {
  id?: string
  source?: DataSource
  external_id?: string
  name: string
  lat: number
  lon: number
  radius: number
}

export interface NamedLocation {
  id: string
  name: string
  lat: number
  lon: number
  radius: number
  auto_create_activity: boolean
  created_at: Date
  updated_at: Date
}

export interface NamedLocationInput {
  name: string
  lat: number
  lon: number
  radius?: number
  auto_create_activity?: boolean
}

export type { GeocodeStatus }

export interface DetectedLocation {
  id: string
  lat: number
  lon: number
  radius: number
  total_minutes: number
  visit_count: number
  first_visit: Date
  last_visit: Date
  address: string | null
  geocode_status: GeocodeStatus
  created_at: Date
  updated_at: Date
}

export interface DetectedLocationInput {
  lat: number
  lon: number
  radius?: number
  total_minutes: number
  visit_count: number
  first_visit: Date
  last_visit: Date
}

export interface DetectedLocationUpdate {
  lat?: number
  lon?: number
  radius?: number
  total_minutes?: number
  visit_count?: number
  first_visit?: Date
  last_visit?: Date
  address?: string | null
  geocode_status?: GeocodeStatus
}

// ============================================================================
// Productivity
// ============================================================================

export interface ProductivityRecord {
  id?: string
  source?: DataSource
  start_time: Date
  end_time: Date
  activity: string
  title?: string
  category?: string
  productivity?: number
  duration_sec: number
  is_mobile?: boolean
  device_name?: string
  resolved_category?: string[]
  deleted_at?: Date
}

// ============================================================================
// Screentime Categories
// ============================================================================

export interface ScreentimeCategory {
  id: string
  name: string[]
  rule_type: 'regex' | 'none'
  rule_regex?: string
  ignore_case: boolean
  color?: string
  score?: number
  exclude_from_screentime?: boolean
  sort_order: number
  /** Slug pointing at the linked `activity_type_definitions` row. Set on first sync; never auto-changed. */
  activity_type_name?: string
  /** True when this category created the linked activity_type; false when it converged onto a pre-existing one. */
  category_owns_type?: boolean
  created_at: Date
  updated_at: Date
}

export interface ScreentimeCategoryInput {
  name: string[]
  rule_type: 'regex' | 'none'
  rule_regex?: string
  ignore_case?: boolean
  color?: string
  score?: number
  exclude_from_screentime?: boolean
  sort_order?: number
}

// ============================================================================
// Notes
// ============================================================================

export type { EntityType }

export interface Note {
  id: string
  entity_type: EntityType
  entity_id: string
  content: string
  /** Data source that created this note (e.g. 'oura'). Null for user-created notes. */
  source?: DataSource
  /** Inherited from the parent entity's start_time. Null for metric notes (composite key). */
  start_time?: Date
  /** Inherited from the parent entity's end_time, if any. */
  end_time?: Date
  created_at: Date
  updated_at: Date
}

// ============================================================================
// Lab Results
// ============================================================================

export interface LabResult {
  id?: string
  test_date: Date
  test_name: string
  test_category?: string
  value: number
  unit: string
  reference_low?: number
  reference_high?: number
  flag?: 'normal' | 'high' | 'low' | 'critical'
  lab_name?: string
  notes?: string
}

// ============================================================================
// Reports (structured lab results)
// ============================================================================

export type ReportConfidence = Confidence
export type { ReportFlag }

export interface ReportEntry {
  id: string
  report_id: string
  metric: string
  value: number
  unit: string
  method?: string
  confidence?: ReportConfidence
  reference_low?: number
  reference_high?: number
  flag?: ReportFlag
}

export interface Report {
  id: string
  report_type: string
  report_date: Date
  location?: string
  notes?: string
  created_at: Date
  entries: ReportEntry[]
}

// ============================================================================
// Meals
// ============================================================================

export type NutrientValue = number | { value: number; unit: string }
export type Micros = Record<string, NutrientValue>

export interface MealFoodItem {
  food_item_id?: string
  /** Soft pointer to the portion the user picked when logging, if any. */
  food_item_portion_id?: string
  /** Count of `food_item_portion_id` portions logged. */
  portion_count?: number
  name: string
  /** Icon for display — resolved live from the canonical food item; not snapshotted. */
  icon?: string
  quantity?: number
  unit?: string
  calories?: number
  protein?: number
  carbs?: number
  fat?: number
  fiber?: number
  micros?: Micros
  /** Sensitivity flag names — resolved live from food_item_sensitivities; not snapshotted. */
  sensitivities?: string[]
}

export interface Meal {
  id: string
  source: string
  meal_type?: string
  name?: string
  time: Date
  calories?: number
  protein?: number
  carbs?: number
  fat?: number
  fiber?: number
  food_items?: MealFoodItem[]
  micros?: Micros
  notes?: string
  sensitivities?: string[]
  created_at: Date
}

// ============================================================================
// Food Items (canonical library)
// ============================================================================

export interface FoodItemEntity {
  id: string
  name: string
  name_lower: string
  source: string
  source_id?: string
  is_composite?: boolean
  /** Soft pointer to a richer canonical food item (per-user OR central) used to inherit empty micronutrient fields. */
  reference_food_item_id?: string
  default_quantity?: number
  default_unit?: string
  /** Soft pointer to the preselected portion (food_item_portions.id) when logging. */
  default_portion_id?: string
  /** Default quantity to prefill when logging, in the unit named by default_portion_id (or base). */
  default_log_quantity?: number
  // ~65 nutrient fields are optional numbers, accessed dynamically via
  // NUTRIENT_FIELD_NAMES from api-spec. The index signature has to cover
  // every named field above too, hence the broad union — it loosens type
  // safety on nutrient destructuring as a trade-off for not boilerplating
  // 65 explicit columns. A dedicated cleanup PR could replace this with
  // `extends Partial<NutrientFields>` and drop the index signature.
  [nutrient: string]: string | number | boolean | Date | undefined
  created_at: Date
  updated_at: Date
}

export interface MealFoodItemLink {
  id: string
  meal_id: string
  food_item_id: string
  /**
   * Last-known name from the row's pre-PR snapshot column. Read-only
   * fallback for rows whose canonical food_item has been hard-deleted —
   * live resolution wins when the canonical row is still around.
   */
  legacy_food_item_name?: string
  /** Last-known icon from the snapshot column. See `legacy_food_item_name`. */
  legacy_food_item_icon?: string
  quantity?: number
  unit?: string
  /** Soft pointer to the portion the user picked when logging, if any. */
  food_item_portion_id?: string
  /** Count of `food_item_portion_id` portions logged (e.g. 3 for "3 ruta"). */
  portion_count?: number
  sort_order: number
  // Nutrient snapshot — same fields as FoodItemEntity
  [nutrient: string]: string | number | boolean | Date | undefined
}

// ============================================================================
// OAuth
// ============================================================================

export interface OAuthToken {
  provider: string
  access_token: string
  refresh_token?: string
  expires_at?: Date
  scopes?: string[]
}

// ============================================================================
// Sync State
// ============================================================================

export type { SyncStatus }

export interface SyncState {
  id?: string
  provider: string
  data_type: string
  last_sync_time?: Date
  sync_start_date?: Date
  status: SyncStatus
  error_message?: string
  retry_after?: Date
  updated_at?: Date
}

// ============================================================================
// Health Connect
// ============================================================================

export interface DailyAggregate {
  date: string // "2024-01-15"
  metric: string // "steps", "distance", etc.
  value: number
  data_origins: string[] // Contributing app package names
}

// ============================================================================
// User Settings
// ============================================================================

export interface CalendarConfig {
  name: string
  url: string
}

export interface UserSettings {
  birth_date?: string // YYYY-MM-DD
  calendars?: CalendarConfig[] // Calendar ICS URL configurations
  dashboard?: DashboardConfig // Custom dashboard configuration
  device_timezone?: string // IANA timezone from the Android device (e.g. "Europe/Stockholm")
  hr_zone_start?: { 1: number; 2: number; 3: number; 4: number; 5: number }
  lastfm_username?: string // Last.fm username for scrobble sync
  manually_approve_followers?: boolean // Hold incoming follows for manual approval (locked account)
  rescue_time_key?: string // RescueTime API key (personal token)
  sex?: BiologicalSex // Biological sex for calorie calculation
  timeline_show_replies?: boolean // Show followed actors' replies to posts outside your timeline as own cards
  item_icons?: Record<string, string> // Unified icon mappings for all timeline items (tags, activities, exercise types)
  tag_icons?: Record<string, string> // Deprecated: tag-only icons (migrated to item_icons)
  food_sensitivity_map?: Record<string, string[]> // Food item name -> sensitivity areas
  meal_slots?: Array<{ name: string; default_hour: number }> // Meal slots for quick-logging
  sensitivity_areas?: string[] // Sensitivity areas to track in meals
  tag_mappings?: Record<string, string> // Tag name mappings from UUIDs to display names
  training_load?: TrainingLoadSettings // Training load (Banister model) parameters
  garmin_disabled_data_types?: GarminDataType[] // Garmin data types to skip during sync
  gravl_api_token?: string // Gravl personal access token (used when no OAuth grant exists)
  sync_intervals?: SyncIntervals // Per-provider background poll intervals in minutes, `default` as fallback
}

/**
 * Background sync poll intervals in minutes, keyed by provider
 * (`gravl`, `garmin`, `oura`, `rescuetime`, `lastfm`, `calendar`) with
 * `default` as the fallback for providers without an explicit entry.
 */
export type SyncIntervals = Partial<Record<string, number>>

// ============================================================================
// MCP Sessions
// ============================================================================

export interface McpSessionRecord {
  session_id: string
  username: string
  created_at: Date
  last_activity: Date
}
