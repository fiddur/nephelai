/**
 * User settings schemas.
 */

import { z } from 'zod'

import { baseResponseSchema, hrZoneSourceSchema } from './common.ts'
import { dashboardConfigSchema } from './dashboard.ts'
import { goalsSchema } from './goals.ts'
import { garminDataTypeSchema } from './sync.ts'
import { trainingLoadSettingsSchema } from './training-load.ts'

// Shared HR zone threshold field
const hrZoneThresholdSchema = z.number().int().positive()

/**
 * HR zone thresholds (zone 1-5 start values in bpm).
 */
export const hrZoneThresholdsSchema = z
  .object({
    1: hrZoneThresholdSchema.meta({ description: 'Zone 1 threshold (bpm)', example: 90 }),
    2: hrZoneThresholdSchema.meta({ description: 'Zone 2 threshold (bpm)', example: 108 }),
    3: hrZoneThresholdSchema.meta({ description: 'Zone 3 threshold (bpm)', example: 126 }),
    4: hrZoneThresholdSchema.meta({ description: 'Zone 4 threshold (bpm)', example: 144 }),
    5: hrZoneThresholdSchema.meta({ description: 'Zone 5 threshold (bpm)', example: 162 }),
  })
  .refine((data) => data[1] < data[2] && data[2] < data[3] && data[3] < data[4] && data[4] < data[5], {
    message: 'HR zone thresholds must be in ascending order',
  })
  .meta({ id: 'HrZoneThresholds' })

export type HrZoneThresholds = z.infer<typeof hrZoneThresholdsSchema>

// Shared HR zone seconds field
const hrZoneSecsValueSchema = z.number()

/**
 * HR zone seconds (time spent in each zone).
 */
export const hrZoneSecsSchema = z
  .object({
    0: hrZoneSecsValueSchema.meta({ description: 'Seconds below zone 1' }),
    1: hrZoneSecsValueSchema.meta({ description: 'Seconds in zone 1' }),
    2: hrZoneSecsValueSchema.meta({ description: 'Seconds in zone 2' }),
    3: hrZoneSecsValueSchema.meta({ description: 'Seconds in zone 3' }),
    4: hrZoneSecsValueSchema.meta({ description: 'Seconds in zone 4' }),
    5: hrZoneSecsValueSchema.meta({ description: 'Seconds in zone 5' }),
  })
  .meta({ id: 'HrZoneSecs' })

export type HrZoneSecs = z.infer<typeof hrZoneSecsSchema>

/**
 * Biological sex schema (used for calorie calculation formulas).
 */
export const biologicalSexSchema = z.enum(['male', 'female']).meta({
  description: 'Biological sex (used for calorie calculation formulas)',
  example: 'male',
  id: 'BiologicalSex',
})

export type BiologicalSex = z.infer<typeof biologicalSexSchema>

/**
 * Birth date schema (YYYY-MM-DD format).
 */
export const birthDateSchema = z.iso.date().meta({
  description: 'Birth date in YYYY-MM-DD format',
  example: '1985-06-15',
})

/**
 * RescueTime API key schema.
 */
export const rescueTimeKeySchema = z.string().min(1, 'RescueTime API key cannot be empty').meta({
  description: 'RescueTime API key (personal token)',
})

/**
 * Gravl personal access token schema.
 */
export const gravlApiTokenSchema = z.string().min(1, 'Gravl API token cannot be empty').meta({
  description: 'Gravl personal access token (gat_…), used when no OAuth grant exists',
})

/**
 * Background sync poll intervals, minutes per provider.
 */
export const syncIntervalsSchema = z
  .record(
    z
      .string()
      .meta({
        description: 'Provider name (gravl, garmin, oura, rescuetime, lastfm, calendar) or "default"',
      }),
    z.number().int().min(5).max(1440).meta({ description: 'Poll interval in minutes (5–1440)' }),
  )
  .meta({
    id: 'SyncIntervals',
    description:
      'How often the background scheduler polls each pull-based provider, in minutes. Keyed by provider name; the "default" key applies to providers without their own entry. Providers not listed fall back to the server default.',
  })

export type SyncIntervals = z.infer<typeof syncIntervalsSchema>

/**
 * Last.fm username schema.
 */
export const lastFmUsernameSchema = z.string().min(1, 'Last.fm username cannot be empty').meta({
  description: 'Last.fm username for scrobble sync',
})

/**
 * Tag mappings schema (UUID -> display name).
 */
export const tagMappingsSchema = z.record(z.string(), z.string()).meta({
  description: 'Tag mappings from Oura tag_type_code UUIDs to display names',
  id: 'TagMappings',
})

/**
 * Tag icons schema (tag key or display name -> emoji/URL).
 * @deprecated Use itemIconsSchema instead.
 */
export const tagIconsSchema = z.record(z.string(), z.string()).meta({
  description: 'Tag icon mappings (tag key or display name -> emoji character or image URL)',
  id: 'TagIcons',
})

/**
 * Item icons schema — unified icon mappings for all timeline items.
 *
 * Keys use a prefix convention:
 * - Tag names or tag_keys: "Coffee", "meditation" (no prefix, backwards-compatible with tag_icons)
 * - Activity types: "activity:sleep", "activity:nap", "activity:meditation"
 * - Exercise types: "exercise:Running", "exercise:Biking", etc.
 * - Screentime categories: "category:Work", "category:Work > Programming"
 *
 * Values are emoji characters or image URLs. An empty string explicitly clears the default icon.
 */
export const itemIconsSchema = z.record(z.string(), z.string()).meta({
  description:
    'Unified icon mappings for all timeline items (tags, activities, exercise types, screentime categories). Keys use prefix convention: activity:sleep, exercise:Running, category:Work > Programming, or plain tag names.',
  id: 'ItemIcons',
})

/**
 * Calendar config schema (name + ICS URL pair).
 */
export const calendarConfigSchema = z
  .object({
    name: z.string().min(1).meta({ description: 'Display name for the calendar' }),
    url: z.string().url().meta({ description: 'ICS URL for the calendar' }),
  })
  .meta({ id: 'CalendarConfig' })

export type CalendarConfig = z.infer<typeof calendarConfigSchema>

/**
 * Calendars schema (array of calendar configs).
 */
export const calendarsSchema = z.array(calendarConfigSchema).meta({
  description: 'Calendar ICS URL configurations',
  id: 'Calendars',
})

export type TagMappings = z.infer<typeof tagMappingsSchema>

/**
 * A configured meal slot for quick-logging.
 */
export const mealSlotSchema = z
  .object({
    default_hour: z.number().int().min(0).max(23).meta({ description: 'Default hour of day (0-23)' }),
    name: z.string().min(1).meta({ description: 'Meal slot name (e.g., "Breakfast", "Lunch")' }),
  })
  .meta({ id: 'MealSlot', description: 'A configured meal slot for quick-logging' })

export type MealSlot = z.infer<typeof mealSlotSchema>

/**
 * Array of configured meal slots.
 */
export const mealSlotsSchema = z.array(mealSlotSchema).meta({
  id: 'MealSlots',
  description: 'Configured meal slots for quick-logging',
})

/**
 * Sensitivity areas for meal tracking.
 */
export const sensitivityAreasSchema = z.array(z.string().min(1)).meta({
  id: 'SensitivityAreas',
  description: 'Sensitivity areas to track in meals (e.g., "gluten", "dairy", "red_meat")',
})

/**
 * Food-to-sensitivity mapping.
 * Maps exact food item names to sensitivity areas they contain.
 * E.g., { "Toasted rye bread": ["gluten"], "Milk": ["dairy"] }
 */
export const foodSensitivityMapSchema = z.record(z.string(), z.array(z.string())).meta({
  id: 'FoodSensitivityMap',
  description: 'Mapping from food item names to sensitivity areas they contain',
})

/**
 * Update settings input schema.
 */
export const updateSettingsInputSchema = z
  .object({
    birth_date: birthDateSchema.nullable().optional().meta({
      description: 'Birth date (set to null to clear)',
    }),
    calendars: calendarsSchema.nullable().optional().meta({
      description: 'Calendar ICS URL configurations (set to null to clear all)',
    }),
    dashboard: dashboardConfigSchema.nullable().optional().meta({
      description: 'Dashboard configuration (set to null to reset to defaults)',
    }),
    goals: goalsSchema.nullable().optional().meta({
      description: 'Goals (set to null to reset to defaults, empty array to clear all)',
    }),
    hr_zone_start: hrZoneThresholdsSchema.nullable().optional().meta({
      description: 'Custom HR zone thresholds (set to null to clear)',
    }),
    item_icons: itemIconsSchema.nullable().optional().meta({
      description:
        'Unified icon mappings for all timeline items — tags, activities, exercise types (set to null to clear all)',
    }),
    food_sensitivity_map: foodSensitivityMapSchema.nullable().optional().meta({
      description: 'Food-to-sensitivity mapping (set to null to clear)',
    }),
    meal_slots: mealSlotsSchema.nullable().optional().meta({
      description: 'Configured meal slots for quick-logging (set to null to clear)',
    }),
    lastfm_username: lastFmUsernameSchema.nullable().optional().meta({
      description: 'Last.fm username for scrobble sync (set to null to clear)',
    }),
    manually_approve_followers: z.boolean().nullable().optional().meta({
      description:
        'When true, incoming follows are held as pending requests you approve or reject; when false (default), anyone can follow you automatically (set to null to reset to the default).',
    }),
    rescue_time_key: rescueTimeKeySchema.nullable().optional().meta({
      description: 'RescueTime API key (set to null to clear)',
    }),
    sensitivity_areas: sensitivityAreasSchema.nullable().optional().meta({
      description: 'Sensitivity areas to track in meals (set to null to clear)',
    }),
    sex: biologicalSexSchema.nullable().optional().meta({
      description: 'Biological sex for calorie calculation (set to null to clear)',
    }),
    tag_icons: tagIconsSchema.nullable().optional().meta({
      description: 'Tag icon mappings (deprecated, use item_icons instead; set to null to clear all)',
    }),
    tag_mappings: tagMappingsSchema.nullable().optional().meta({
      description: 'Tag name mappings (set to null to clear all)',
    }),
    timeline_show_replies: z.boolean().nullable().optional().meta({
      description:
        "When true, followed actors' replies show as their own home-timeline cards whatever they answer; when false (default), replies to posts that aren't in your timeline are hidden — replies to your own posts, posts mentioning you, and replies within a thread you already see always appear (set to null to reset to the default).",
    }),
    training_load: trainingLoadSettingsSchema.nullable().optional().meta({
      description: 'Training load (Banister model) parameters (set to null to reset to defaults)',
    }),
    garmin_disabled_data_types: z.array(garminDataTypeSchema).nullable().optional().meta({
      description: 'Garmin data types to skip during sync (set to null to clear, enabling all)',
    }),
    gravl_api_token: gravlApiTokenSchema.nullable().optional().meta({
      description:
        'Gravl personal access token (set to null to clear). Ignored for sync while an OAuth grant exists.',
    }),
    sync_intervals: syncIntervalsSchema.nullable().optional().meta({
      description:
        'Background sync poll intervals in minutes per provider (set to null to reset to server defaults)',
    }),
  })
  .meta({ id: 'UpdateSettingsInput' })

export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>

/**
 * User settings response schema.
 */
export const userSettingsResponseSchema = baseResponseSchema
  .extend({
    birth_date: z.string().nullable().default(null).meta({ description: 'Birth date in YYYY-MM-DD format' }),
    calendars: calendarsSchema.default([]).meta({ description: 'Calendar ICS URL configurations' }),
    dashboard: dashboardConfigSchema
      .nullable()
      .default(null)
      .meta({ description: 'Custom dashboard configuration (null = use default)' }),
    food_sensitivity_map: foodSensitivityMapSchema
      .default({})
      .meta({ description: 'Food-to-sensitivity mapping' }),
    garmin_connected: z
      .boolean()
      .default(false)
      .meta({ description: 'Whether Garmin Connect is connected via stored session' }),
    garmin_disabled_data_types: z
      .array(garminDataTypeSchema)
      .default([])
      .meta({ description: 'Garmin data types currently disabled for sync' }),
    goals: goalsSchema.meta({ description: 'User goals for tracking metrics' }),
    hr_zone_start: hrZoneThresholdsSchema.meta({ description: 'Effective HR zone thresholds' }),
    hr_zone_start_source: hrZoneSourceSchema.default('default').meta({
      description: 'Source of HR zone thresholds',
    }),
    item_icons: itemIconsSchema.default({}).meta({
      description:
        'Unified icon mappings for all timeline items — tags, activities, exercise types (tag key or name -> emoji/URL)',
    }),
    lastfm_configured: z
      .boolean()
      .default(false)
      .meta({ description: 'Whether Last.fm API key is configured on server' }),
    lastfm_username: z
      .string()
      .nullable()
      .default(null)
      .meta({ description: 'Last.fm username for scrobble sync' }),
    manually_approve_followers: z.boolean().default(false).meta({
      description: 'Whether incoming follows are held for manual approval (locked account)',
    }),
    meal_slots: mealSlotsSchema.default([]).meta({ description: 'Configured meal slots for quick-logging' }),
    oura_configured: z
      .boolean()
      .default(false)
      .meta({ description: 'Whether Oura OAuth is configured on server' }),
    oura_connected: z.boolean().default(false).meta({ description: 'Whether Oura is connected via OAuth' }),
    gravl_configured: z
      .boolean()
      .default(false)
      .meta({
        description: 'Whether a Gravl OAuth app is configured on the server (enables "Connect Gravl")',
      }),
    gravl_connection: z
      .enum(['oauth', 'token'])
      .nullable()
      .default(null)
      .meta({
        description: 'How Gravl is connected: an OAuth grant, a personal token, or null when not connected',
      }),
    rescue_time_key: z.string().nullable().default(null).meta({ description: 'RescueTime API key' }),
    strava_connected: z
      .boolean()
      .default(false)
      .meta({ description: 'Whether Strava is connected via OAuth' }),
    strava_configured: z
      .boolean()
      .default(false)
      .meta({ description: 'Whether Strava OAuth is configured on server' }),
    sensitivity_areas: sensitivityAreasSchema
      .default([])
      .meta({ description: 'Sensitivity areas to track in meals' }),
    sync_intervals: syncIntervalsSchema.default({}).meta({
      description: 'Background sync poll intervals in minutes per provider (empty = server defaults)',
    }),
    sex: biologicalSexSchema
      .nullable()
      .default(null)
      .meta({ description: 'Biological sex for calorie calculation' }),
    tag_icons: tagIconsSchema.default({}).meta({
      description: 'Tag icon mappings (deprecated, use item_icons)',
    }),
    tag_mappings: tagMappingsSchema
      .default({})
      .meta({ description: 'Tag name mappings from UUIDs to display names' }),
    timeline_show_replies: z.boolean().default(false).meta({
      description:
        "Whether followed actors' replies to posts that aren't in your timeline show as their own home-timeline cards (replies to you, mentions of you, and replies within a thread you already see always show)",
    }),
    training_load: trainingLoadSettingsSchema
      .nullable()
      .default(null)
      .meta({ description: 'Training load (Banister model) parameters (null = defaults)' }),
    tz: z.string().nullable().default(null).meta({
      description: 'User timezone (IANA format, e.g. Europe/Stockholm). Auto-detected from device.',
    }),
  })
  .meta({ id: 'UserSettingsResponse' })

export type UserSettingsResponse = z.infer<typeof userSettingsResponseSchema>
