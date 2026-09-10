/**
 * Database schema definitions for Aurboda.
 *
 * Per-domain table SQL lives in `schema/`; this file assembles the full
 * `createTableStatements` map and the dependency-respecting
 * `tableCreationOrder` array consumed by db/connection.ts and migrate.ts.
 *
 * See docs/data-storage.md for design decisions and data flow documentation.
 */

import { activitiesTables } from './schema/activities.ts'
import { locationsTables } from './schema/locations.ts'
import { mealsTables } from './schema/meals.ts'
import { metricsTables } from './schema/metrics.ts'
import { productivityTables } from './schema/productivity.ts'
import { reportsTables } from './schema/reports.ts'
import { socialTables } from './schema/social.ts'
import { systemTables } from './schema/system.ts'

// Re-export common types from shared api-spec package
export {
  aurbodaOnlyMetrics,
  aurbodaOnlySources,
  contextualHrvMetrics,
  cumulativeMetrics,
  cumulativeSources,
  getMetricAggregation,
  getMetricUnit,
  hrZoneMetrics,
  isContextualHrvMetric,
  isHrZoneMetric,
  isValidMetric,
  isValidMetricOrCustom,
  metricUnits,
  sumMetrics,
  validMetrics,
  type ActivityType,
  type CustomMetricDefinition,
  type DataSource,
  type MetricAggregation,
  type MetricType,
} from '@aurboda/api-spec'

export const SCHEMA_VERSION = 1

/**
 * All table creation statements in dependency order.
 * Assembled from per-domain SQL modules under `schema/`.
 */
export const createTableStatements: Record<string, string> = {
  ...activitiesTables,
  ...locationsTables,
  ...mealsTables,
  ...metricsTables,
  ...productivityTables,
  ...reportsTables,
  ...socialTables,
  ...systemTables,
}

/**
 * Order in which tables should be created (respecting dependencies).
 *
 * Key constraints:
 *  - activity_type_definitions before activities (FK)
 *  - reports before report_entries (FK)
 *  - meals + food_items before meal_food_items (FK)
 *  - deduction_rules before deduction_rule_runs (FK)
 *  - tag_definitions before tags (FK)
 */
export const tableCreationOrder = [
  'raw_records',
  'raw_records_indexes',
  'time_series',
  'time_series_indexes',
  'time_series_updated_at',
  'activity_type_definitions',
  'activity_type_definitions_indexes',
  'activity_type_definitions_seed',
  'activities',
  'activities_created_at',
  'activities_indexes',
  'activity_override_targets',
  'activity_override_targets_indexes',
  'activity_override_targets_trigger',
  'meals',
  'meals_indexes',
  'meal_log_completed',
  'food_items',
  'food_items_indexes',
  'food_items_search_setup',
  'food_item_ingredients',
  'food_item_ingredients_indexes',
  'food_item_portions',
  'food_item_portions_indexes',
  'meal_food_items',
  'meal_food_items_indexes',
  'sensitivity_flags',
  'sensitivity_flags_indexes',
  'food_item_sensitivities',
  'food_item_sensitivities_indexes',
  'shared_food_item_overrides',
  'user_nutrient_recommendations',
  'locations',
  'locations_indexes',
  'places',
  'places_indexes',
  'named_locations',
  'named_locations_indexes',
  'detected_locations',
  'detected_locations_indexes',
  'tag_definitions',
  'tag_definitions_indexes',
  'tags',
  'tags_indexes',
  'productivity',
  'productivity_indexes',
  'screentime_categories',
  'screentime_categories_indexes',
  'lab_results',
  'lab_results_indexes',
  'reports',
  'reports_indexes',
  'report_entries',
  'report_entries_indexes',
  'oauth_tokens',
  'sync_state',
  'uploaded_icons',
  'custom_metrics',
  'custom_metrics_indexes',
  'goals',
  'goals_indexes',
  'user_settings',
  'audit_log',
  'audit_log_indexes',
  'notes',
  'notes_indexes',
  'shared_dashboards',
  'shared_dashboards_indexes',
  'challenges',
  'challenges_indexes',
  'challenges_result_columns',
  'challenge_members',
  'challenge_members_indexes',
  'challenge_participations',
  'challenge_participations_indexes',
  'challenge_left',
  'feed_posts',
  'feed_posts_article_columns',
  'feed_posts_message_column',
  'feed_posts_challenge_column',
  'feed_posts_autoshare_column',
  'feed_posts_reply_columns',
  'autoshare_rules',
  'autoshare_suppressions',
  'feed_posts_indexes',
  'feed_posts_keyset_index',
  'feed_posts_reply_indexes',
  'feed_tombstone',
  'feed_actor',
  'feed_follower',
  'feed_follower_columns',
  'feed_following',
  'feed_following_notify',
  'timeline_entry',
  'timeline_entry_structured',
  'timeline_entry_images',
  'timeline_entry_enrich_attempted',
  'timeline_entry_enrich_attempts',
  'timeline_entry_reply',
  'timeline_entry_mentions',
  'timeline_entry_reply_checked',
  'timeline_entry_reply_checked_backstamp',
  'timeline_entry_boost',
  'timeline_entry_indexes',
  'timeline_entry_unenriched_indexes',
  'timeline_entry_reply_target_indexes',
  'timeline_entry_reply_unchecked_indexes',
  'timeline_entry_boost_indexes',
  'feed_reaction',
  'feed_post_reaction',
  'feed_post_reaction_indexes',
  'profile_avatar',
  'mcp_sessions',
  'mcp_sessions_indexes',
  'outbound_sync_queue',
  'outbound_sync_queue_indexes',
  'deduction_rules',
  'deduction_rules_indexes',
  'deduction_rule_runs',
  'deduction_rule_runs_indexes',
  'webauthn_credentials',
  'webauthn_credentials_indexes',
]

// Health Connect mappings are in schema-health-connect.ts — re-export for convenience
export {
  activityTypeToHealthConnectType,
  healthConnectActivityMapping,
  healthConnectMetricMapping,
  isHealthConnectSyncableActivity,
  isHealthConnectSyncableMetric,
  metricToHealthConnectType,
} from './schema-health-connect.ts'
