/**
 * Barrel re-export for all database modules.
 *
 * All consumers can continue importing from './db.ts' or '../db' unchanged.
 */

// Types (interfaces & type aliases)
export type {
  Activity,
  ActivityUpdate,
  BucketedMetricData,
  CachedActorPresentation,
  CalendarConfig,
  DailyAggregate,
  DailyMetricAggregate,
  DetectedLocation,
  DetectedLocationInput,
  DetectedLocationUpdate,
  EntityType,
  GeocodeStatus,
  LabResult,
  Location,
  McpSessionRecord,
  FoodItemEntity,
  Meal,
  MealFoodItem,
  MealFoodItemLink,
  MergedActivity,
  Micros,
  MetricStats,
  NamedLocation,
  NamedLocationInput,
  Note,
  OAuthToken,
  Place,
  ProductivityRecord,
  RawRecord,
  Report,
  ReportConfidence,
  ReportEntry,
  ReportFlag,
  ScreentimeCategory,
  ScreentimeCategoryInput,
  SyncState,
  SyncStatus,
  TimeSeriesPoint,
  UserSettings,
} from './types.ts'

// Connection & schema management
export {
  _setClientForUser,
  dropUserDb,
  getDbForUser,
  initializeSchema,
  listUserNames,
  loginToUserDb,
  makeNewUserDb,
  migrateSchema,
  query,
  schemaInitialized,
} from './connection.ts'

// Raw records
export {
  getAllScrobbles,
  getScrobbles,
  insertRawRecord,
  queryRawRecords,
  type QueryRawRecordsParams,
  type RawRecordRow,
  type ScrobbleRecord,
} from './raw-records.ts'

// Time series
export {
  deleteTimeSeriesBySource,
  deleteTimeSeriesMetric,
  deleteTimeSeriesPoint,
  getDailyAggregates,
  getDistinctMetrics,
  getRawDailySum,
  getSourceFilter,
  getLatestMetricValuesMulti,
  getTimeSeries,
  getTimeSeriesBucketed,
  getTimeSeriesEntriesMultiMetric,
  getTimeSeriesMultiMetric,
  getTimeSeriesStats,
  getTimeSeriesWithSource,
  insertTimeSeries,
} from './time-series.ts'

// Deduction Rules
export {
  deleteDeductionRule,
  deleteRuleActivities,
  deleteStaleRuleActivities,
  getDeductionRule,
  getDeductionRules,
  getDeductionRulesByIds,
  getEnabledDeductionRules,
  insertDeductionRule,
  insertDeductionRuleRun,
  updateDeductionRule,
} from './deduction-rules.ts'

// Activity Type Definitions
export {
  activityTypeExists,
  deleteActivityTypeDefinition,
  expandActivityTypes,
  getActivityTypeDefinition,
  getActivityTypeDefinitions,
  getActivityTypeNames,
  getDescendantTypes,
  getHealthConnectExerciseType,
  insertActivityTypeDefinition,
  mergeActivityTypeDefinition,
  renameActivityTypeDefinition,
  resolveActivityTypeByAlias,
  resolveActivityTypeFromHcExerciseType,
  resolveOrCreateActivityType,
  updateActivityTypeDefinition,
} from './activity-type-definitions.ts'

// Activities
export {
  adoptLegacyActivity,
  checkActivityConflict,
  deleteActivity,
  deleteGarminActivityWithWrongType,
  softDeleteActivityByExternalId,
  findActivityByExternalId,
  findMergeableActivity,
  findMergedGroupForActivity,
  getActivities,
  getActivitiesByCategory,
  getActivitiesExcludingCategories,
  getActivitiesNeedingDetail,
  getAllActivitiesInRange,
  getScreentimeActivities,
  migrateExerciseTypes,
  getNonSleepActivitiesMerged,
  getAllActivityTypeNames,
  getActivityById,
  getActivitySourcesByIds,
  getNearbyActivities,
  backfillSuperseded,
  getOverlappingActivities,
  getOverrideForActivity,
  getSleepSessions,
  hardDeleteActivitiesByExternalIdPrefix,
  hardDeleteActivitiesBySource,
  insertActivities,
  insertActivity,
  insertNewActivity,
  insertOverride,
  markActivityDetailSynced,
  materializeSuperseded,
  mergeOverlappingActivities,
  restoreActivity,
  updateActivity,
  updateActivityEndTimeByExternalId,
  updateActivityTypeByTagKey,
  updateScreentimeActivityCategoryPath,
} from './activities/index.ts'

// Locations
export {
  deleteDetectedLocation,
  deleteNamedLocation,
  findNearbyDetectedLocation,
  getDetectedLocationById,
  getDetectedLocations,
  getDetectedLocationsNeedingGeocode,
  getLocations,
  getNamedLocationById,
  getNamedLocations,
  insertDetectedLocation,
  insertLocation,
  insertLocations,
  insertNamedLocation,
  insertPlace,
  softDeleteSupersededLocations,
  updateDetectedLocation,
  updateNamedLocation,
} from './locations.ts'

// Productivity
export {
  batchUpdateResolvedCategory,
  deleteProductivityRecord,
  getAllProductivityForCategorization,
  getDistinctApps,
  getProductivity,
  type ProductivityBucketRow,
  getProductivityBucketed,
  getProductivityById,
  insertProductivity,
  restoreProductivityRecord,
} from './productivity.ts'

// Screentime categories
export {
  bulkInsertScreentimeCategories,
  deleteAllScreentimeCategories,
  deleteScreentimeCategoryWithChildren,
  getScreentimeCategories,
  getScreentimeCategoryById,
  insertScreentimeCategory,
  moveScreentimeCategory,
  updateScreentimeCategory,
  upsertScreentimeCategory,
} from './screentime-categories.ts'

// Notes
export {
  deleteNote,
  getNoteById,
  getNotesByEntityIds,
  getNotesForEntity,
  getNotesForTimeRange,
  getUserNotesJoined,
  insertNote,
  reanchorNotes,
  replaceUserNotes,
  updateNote,
  updateNoteTimesForEntity,
  upsertSyncedNote,
} from './notes.ts'

// Shared dashboards
export {
  createSharedDashboard,
  deleteSharedDashboard,
  getSharedDashboardById,
  getSharedDashboardBySlug,
  listPublicSharedDashboards,
  listSharedDashboards,
  type SharedDashboardInput,
  type SharedDashboardPatch,
  type SharedDashboardRecord,
  updateSharedDashboard,
} from './shared-dashboards.ts'

// Challenges
export {
  type ChallengeInput,
  type ChallengeMemberInput,
  type ChallengeMemberRecord,
  type ChallengeParticipationInput,
  type ChallengeParticipationRecord,
  type ChallengePatch,
  type ChallengeRecord,
  type ChallengeSpecFields,
  createChallenge,
  createChallengeParticipation,
  deleteChallenge,
  deleteChallengeParticipation,
  getChallengeById,
  getChallengeBySlug,
  getChallengeMemberByIdentity,
  getParticipationById,
  getParticipationByToken,
  getParticipationByUrl,
  listChallengeMembers,
  listChallengeParticipations,
  listChallenges,
  listChallengesAwaitingResult,
  listLeftChallengeUrls,
  listPublicChallenges,
  markChallengeResultPublished,
  removeChallengeMember,
  updateChallenge,
  updateChallengeMemberCache,
  upsertChallengeMember,
} from './challenges.ts'

// PostgreSQL error predicates
export { isMissingDatabase } from './pg-errors.ts'

// Feed actor (ActivityPub keypair)
export { type ActorKeyPair, getOrCreateActorKeyPair } from './feed-actor.ts'

// Feed followers (remote ActivityPub actors following a user)
export {
  countFeedFollowers,
  type FeedFollowerInput,
  type FeedFollowerRecord,
  getFeedFollowerByActor,
  getFeedFollowerById,
  listFeedFollowers,
  removeFeedFollower,
  removeFeedFollowerById,
  setFeedFollowerAccepted,
  updateFeedFollowerPresentation,
  upsertFeedFollower,
} from './feed-follower.ts'

// Feed following (actors this user follows)
export {
  countAcceptedFeedFollowing,
  type FeedFollowingInput,
  type FeedFollowingRecord,
  getFeedFollowing,
  getFeedFollowingByActor,
  listAcceptedFeedFollowing,
  listFeedFollowing,
  markFeedFollowingAccepted,
  removeFeedFollowing,
  removeFeedFollowingByActor,
  updateFeedFollowingNotify,
  updateFeedFollowingPresentation,
  upsertFeedFollowing,
} from './feed-following.ts'

// Likes ⭐ / boosts 🔄 (outbound `feed_reaction`, inbound `feed_post_reaction`)
export {
  countFeedPostReactions,
  type FeedPostReactionCount,
  type FeedPostReactionInput,
  type FeedPostReactionRecord,
  type FeedReactionInput,
  type FeedReactionRecord,
  type FeedReactionState,
  getFeedReaction,
  insertFeedReaction,
  listFeedPostReactions,
  listFeedReactionsForObjects,
  removeFeedPostReaction,
  removeFeedPostReactionByActivity,
  removeFeedReaction,
  updateFeedPostReactionPresentation,
  upsertFeedPostReaction,
} from './feed-reactions.ts'

// Home timeline (posts received from followed actors)
export {
  type BoostedCopyFields,
  countTimelineRepliesTo,
  deleteBoostEntry,
  deleteTimelineEntriesByActor,
  deleteTimelineEntryByUri,
  getTimelineEntryById,
  getTimelineEntryByObjectUri,
  hasCachedActorPresentation,
  isTimelineEntryVisible,
  listReplyUncheckedEntries,
  listTimelineEntries,
  listTimelineRepliesTo,
  listUnenrichedAurbodaEntries,
  markEnrichTransientFailure,
  markTimelineEntryReplyChecked,
  refreshBoostedCopies,
  setTimelineEntryReplyInfo,
  setTimelineEntryStructured,
  type TimelineCursor,
  type TimelineEntryInput,
  type TimelineEntryRecord,
  type TimelinePageRow,
  type TimelineReplyCount,
  type TimelineReplyFilter,
  type UnenrichedTimelineEntry,
  updateTimelineActorPresentation,
  upsertTimelineEntry,
} from './timeline.ts'
export { emitTimelineNotify, openTimelineChannel } from './timeline-notify.ts'

// Feed posts
export {
  type ArticlePostInput,
  countPublicFeedPosts,
  type ChallengePostInput,
  createArticlePost,
  createChallengePost,
  createFeedPost,
  createReplyPost,
  deleteFeedPost,
  type FeedPostCursor,
  type FeedPostInput,
  type FeedPostPageRow,
  type FeedPostPatch,
  type FeedPostRecord,
  findCoveringSharedSeriesWindow,
  getFeedPostById,
  getFeedTombstone,
  listFeedPostIdsByActivityIds,
  listFeedPosts,
  listPublicFeedPosts,
  listPublicFeedPostsKeyset,
  listPublicFeedPostsPage,
  listReplyPostsTo,
  type PublicFeedPageOpts,
  type ReplyPostInput,
  updateFeedPost,
} from './feed.ts'

// Auto-share rules (#903)
export {
  type AutoshareCandidate,
  type AutoshareRuleInput,
  type AutoshareRulePatch,
  type AutoshareRuleRecord,
  countAutosharePostsByRule,
  deleteAutoshareRule,
  getActivityIngestTimes,
  getAutoshareRules,
  getEnabledAutoshareRules,
  insertAutoshareRule,
  listAutoshareCandidates,
  listAutoshareSuppressedIds,
  updateAutoshareRule,
} from './autoshare-rules.ts'

// Food Items
export {
  deleteFoodItem,
  findOrCreateFoodItem,
  getFoodItemById,
  getFoodItemByName,
  getFoodItemsByIds,
  listFoodItems,
  type MergeFoodItemResult,
  mergeFoodItems,
  searchFoodItems,
  setFoodItemReference,
  updateFoodItem,
  upsertFoodItem,
} from './food-items.ts'
export {
  findMealsContainingFoodItem,
  getMealFoodItems,
  getMealFoodItemsBatch,
  setMealFoodItems,
} from './meal-food-items.ts'

// Sensitivity flags + food-item junction
export {
  deleteFoodItemSensitivities,
  deleteSensitivityFlag,
  type FoodItemSensitivityRow,
  getFoodItemSensitivities,
  getFoodItemSensitivityFlagIds,
  getFoodItemSensitivityNamesBatch,
  getSensitivityFlagByName,
  insertSensitivityFlag,
  listSensitivityFlags,
  mergeFoodItemSensitivities,
  type SensitivityFlag,
  type SensitivityFlagInput,
  setFoodItemSensitivities,
  updateSensitivityFlag,
} from './sensitivities.ts'

// Food item ingredients (composite/recipe support)
export {
  clearIngredients,
  findCompositeParentsOfIngredient,
  type FoodItemIngredientInput,
  type FoodItemIngredientRow,
  getIngredients,
  getIngredientsBatch,
  setIngredients,
} from './food-item-ingredients.ts'

// Food item portions (additional sizings)
export {
  deleteFoodItemPortion,
  deletePortionsForFoodItem,
  type FoodItemPortionRow,
  getFoodItemPortionById,
  getPortionsByFoodItemIds,
  insertFoodItemPortion,
  type InsertFoodItemPortionInput,
  listPortionsForFoodItem,
  type UpdateFoodItemPortionInput,
  updateFoodItemPortion,
} from './food-item-portions.ts'

// Meals
export {
  type DailyNutrientTotal,
  deleteMeal,
  type FrequentFoodItemRow,
  type FrequentMealRow,
  getDailyNutrientTotals,
  getFrequentFoodItems,
  getFrequentMeals,
  getMealById,
  getMealLogCompleted,
  getMealLogCompletedInRange,
  getMeals,
  getNutritionCompleteDaysInRange,
  insertMeal,
  type NutrientKey,
  NUTRIENT_KEYS,
  upsertMeal,
  setMealLogCompleted,
  unsetMealLogCompleted,
  updateMeal,
} from './meals.ts'

// Lab results (legacy)
export { getLabResults, insertLabResult } from './lab-results.ts'

// Reports (structured lab results)
export {
  deleteReport,
  getLatestMetricValue,
  getReportById,
  getReportEntryMetrics,
  getReports,
  insertReport,
  updateReport,
} from './reports.ts'

// OAuth
export { getOAuthToken, upsertOAuthToken } from './oauth.ts'

// Sync state
export { getAllSyncStates, getSyncState, resetSyncState, upsertSyncState } from './sync-state.ts'

// Health Connect
export {
  deleteHealthConnectRecords,
  getDailyAggregateValue,
  processDailyAggregate,
  processHealthConnectBatch,
  processHealthConnectData,
} from './health-connect.ts'

// Outbound sync queue
export {
  ackOutboundSync,
  enqueueOutboundSync,
  failOutboundSync,
  findHcRecordId,
  getOutboundSyncHistory,
  getPendingOutboundSync,
  reportSyncFailure,
  requeueOutboundSync,
  type EnqueueOutboundSyncInput,
  type OutboundSyncEntry,
  type OutboundSyncOperation,
  type OutboundSyncStatus,
  type PendingOutboundSyncResult,
} from './outbound-sync.ts'

// Uploaded icons
export { deleteIcon, getIcon, insertIcon } from './icons.ts'

// Profile avatar
export {
  deleteProfileAvatar,
  getProfileAvatar,
  getProfileAvatarVersion,
  type ProfileAvatar,
  upsertProfileAvatar,
} from './profile-avatar.ts'

// Shared food-item overrides (per-user customizations layered onto central rows)
export {
  clearSharedFoodItemOverride,
  getSharedFoodItemOverride,
  getSharedFoodItemOverridesByIds,
  setSharedFoodItemOverride,
  type SharedFoodItemOverride,
  type SharedFoodItemOverrideInput,
} from './shared-food-item-overrides.ts'

// Per-user nutrient recommendation overrides
export {
  clearUserNutrientRecommendation,
  getUserNutrientRecommendation,
  listUserNutrientRecommendations,
  upsertUserNutrientRecommendation,
  type UserNutrientRecommendationInput,
  type UserNutrientRecommendationRow,
} from './user-nutrient-recommendations.ts'

// Settings
export { getUserSettings, upsertUserSettings } from './settings.ts'

// Goals
export { deleteGoal, getGoals, insertGoal, replaceGoals } from './goals.ts'

// Custom metric definitions
export {
  bulkInsertCustomMetricDefinitions,
  deleteCustomMetricDefinition,
  getCustomMetricByName,
  getCustomMetricDefinitions,
  insertCustomMetricDefinition,
  mergeCustomMetric,
  updateCustomMetricDefinition,
} from './custom-metrics.ts'

// MCP sessions
export {
  deleteExpiredMcpSessions,
  deleteMcpSession,
  getMcpSession,
  getMcpSessionsForUser,
  saveMcpSession,
  touchMcpSession,
} from './mcp-sessions.ts'

// Audit log
export {
  cleanupAuditLog,
  insertAuditLog,
  queryAuditLog,
  type AuditLogQueryParams,
  type AuditLogRow,
} from './audit-log.ts'

// WebAuthn / passkey credentials
export {
  deleteWebAuthnCredential,
  getWebAuthnCredentialById,
  getWebAuthnCredentialsForUser,
  insertWebAuthnCredential,
  updateWebAuthnCredentialNickname,
  updateWebAuthnCredentialUsage,
  type WebAuthnCredentialRow,
} from './webauthn.ts'

// Row mappers (re-export for consumers that need them directly)
export {
  mapActivityRow,
  mapDetectedLocationRow,
  mapMcpSessionRow,
  mapMealRow,
  mapNamedLocationRow,
  mapNoteRow,
  mapReportEntryRow,
  mapReportRow,
  mapSyncStateRow,
  parseActivityType,
  parseDataSource,
  parseEntityType,
  parseGeocodeStatus,
  parseMetricType,
  parseSyncStatus,
} from './row-mappers.ts'
