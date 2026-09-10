# Gravl

[Gravl](https://gravl.ai/) is a strength-training log. Its read-only REST API carries the one thing that never reached Aurboda automatically before: the actual sets — exercise, weight, reps, set type, RPE. Aurboda pulls workouts through the [Gravl API](https://gravl.ai/developers) and attaches that detail to the strength session Health Connect already delivered, or creates the activity when Health Connect did not.

## Data Synced

| Gravl Data     | Stored As                                                                                                | Notes                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Workouts       | `strength_training` activity, source `gravl`                                                             | Keyed by `gravl-workout-<uuid>`; title is the workout name             |
| Sets           | `data.sets` array on the activity + a note                                                               | One entry per set with the exercise repeated (the shape #1044 defines) |
| Workout totals | `data.volume_kg`, `data.calories`, `data.personal_record_count`, `data.set_count`, `data.exercise_count` |                                                                        |

Every workout is also preserved as raw JSON in the `raw_records` table (`record_type = 'gravl_workout'`).

### The set shape

```json
{
  "exercise": "Bench Press",
  "exercise_id": 12,
  "order": 2,
  "set_type": "normal",
  "weight": 80,
  "reps": 8,
  "time": null,
  "distance": null,
  "rpe": 8,
  "superset_id": 3
}
```

- `weight` is kilograms. Gravl reports every weight in **pounds** regardless of the account's unit preference; the sync converts (÷ 2.20462262, rounded to three decimals — 48.50164 lb round-trips to exactly 22 kg).
- `time` is seconds (planks, holds), `distance` metres (carries). Zero values are stored as `null`.
- `set_type` is `normal`, `warmup`, `drop_set` or `failure`. Gravl exposes warmup sets the app hides, so the API is richer than the app.
- `superset_id` is present only when Gravl reports one (it currently reads null everywhere).

A synced note (`source = 'gravl'`) renders the same data as text — `Bench Press: 10×40 kg (w), 8×80 kg, 6×80 kg (f) @8` — with Gravl's own workout notes above it, so the sets are readable in every view before the UI learns to render set arrays.

### What is deliberately not imported

- **`External` workouts.** These are Health Connect sessions round-tripped _into_ Gravl from other apps (Garmin, Polar, …). They carry no exercise data, and importing them would give every watch session an empty `strength_training` twin — one that outranks the Garmin original in the cross-source merge, so a rest or meditation session would surface as strength training.
- **Workouts without a logged set.** A workout started and abandoned in Gravl carries nothing Aurboda does not already have. Only workouts with at least one exercise holding a set are imported.

Gravl's OpenAPI spec spells its enums in PascalCase (`External`, `DropSet`) while the live API serializes them lowercase (`external`, `dropset`); the sync compares case-insensitively. Until 2026-09-09 it did not, and every watch session Gravl had read from Health Connect was imported as an empty strength session (with every set typed `normal`). The sync retracts those rows as it meets them again: a workout it now rejects whose activity row carries an empty `sets` array is soft-deleted and supersession is recomputed, so the original resurfaces. The incremental window only re-covers the last two days, so run one full resync (`POST /api/sync/gravl` with `full_resync: true`, or `sync_gravl(full_resync: true)`) to clean the whole history; the result reports the number as `activities_retracted`.

- Heart rate, GPS and per-set notes are not in the Gravl API; HR and location come from the watch (Garmin / Health Connect) on the same activity.
- Personal records, body measurements, templates and splits — see the follow-ups in [#1042](https://github.com/fiddur/aurboda/issues/1042).

## Enrich, don't duplicate

Most Gravl users already get their sessions through Health Connect: the Gravl app writes a `strength_training` session with correct timing and heart rate, `dataOrigin: com.liteup.getgains`, and its `clientRecordId` is literally `gravl-session-<workout-uuid>`.

Aurboda uses that key ([#1080](https://github.com/fiddur/aurboda/issues/1080)): a Health Connect session from Gravl is stored **as the Gravl activity** — `source = 'gravl'`, `external_id = 'gravl-workout-<uuid>'` — instead of as a `health_connect` row. The Gravl sync upserts onto the same row and adds the sets. No second row, nothing to merge, and the Gravl and Health Connect start times (which differ by a few seconds) never matter.

Sessions Health Connect delivered _before_ this existed are claimed the first time the Gravl sync sees their workout: the old `health_connect` row is re-sourced and enriched in place.

When both a Garmin watch and Gravl record the same session, the Garmin and Gravl rows still merge in the timeline (Gravl ranks above Garmin in the cross-source merge, so the row with the sets wins and Garmin's HR is blended in).

## Admin Setup

None is required. Optionally, register an OAuth app so users can connect with a click instead of pasting a token:

1. Email `developers@gravl.ai` with the app name, the redirect URI `https://<your-api-host>/auth/gravlcb` (shown in Admin Settings), and the scopes — `workouts:read` is all the sync needs. Registration is manual while the API is in beta.
2. Enter the issued client ID (`gci_…`) and secret (`gcs_…`) under **Admin Settings → Gravl API**.

The flow is authorization-code + PKCE (S256). Access tokens live six hours and are refreshed automatically; refresh tokens rotate on every use and are stored in the user's `oauth_tokens` row.

## User Setup

Go to **Data Sources → Gravl**. Two ways in, and the OAuth grant wins when both exist:

- **Personal access token.** Create one at [gravl.ai/developers/personal-tokens](https://gravl.ai/developers/personal-tokens) with the `workouts:read` scope and paste it into the token field. Works on any deployment, no admin involvement.
- **Connect Gravl (OAuth).** Available when the admin has configured an app. Click the button and grant access on Gravl.

Then **Sync Now**, or wait for the background poll.

## How Sync Works

- **REST:** `POST /api/sync/gravl` — `{ "full_resync": true, "start_date": "YYYY-MM-DD" }` optional. The result counts `workouts_processed` (real workouts seen), `activities_enriched` (Health Connect sessions that gained their sets) and `activities_created`; a re-processed Gravl row counts only as processed.
- **MCP:** `sync_gravl()`
- **Status:** `GET /api/sync/gravl/status`, `get_sync_status(provider: "gravl")`
- **Reset:** `DELETE /api/sync/gravl/state`

A run lists workouts in a window, drops `External` and set-less ones (retracting any stale import of them), fetches each real workout's detail (the list has no sets) and stores it. The window is 90 days on the first run or a full resync, otherwise from **two days before the last successful sync** — Gravl workouts get edited after the fact, and re-processing is idempotent.

**Rate limits:** 100 requests per 15 minutes per app + user. A run costs one list page plus one detail request per workout. On a 429 the sync state records Gravl's `Retry-After` (or a 5-minute hold when the header is missing); later runs and Health Connect-triggered enrichments are skipped until it passes, and `last_sync_time` is not advanced so the same window is re-covered.

### Triggered by Health Connect

When the Android app uploads a Gravl session, the backend enqueues an enrichment job for that workout id. A minute later (retried with backoff if Gravl is still saving) the sets are attached — minute-scale latency instead of waiting for the poll. See [Health Connect → Source identity](./health-connect.md#source-identity).

### Background polling

Gravl is polled by the background scheduler together with the other pull-based sources. The interval is per user: **Data Sources → Gravl → Background sync interval** (or the default interval on the Data Sources page; the server fallback is 30 minutes). See [Data Sources → Sync Behavior](./data-sources.md#sync-behavior).

## Disconnecting

- OAuth: **Disconnect** on the Gravl page, or `POST /api/auth/gravl/disconnect`. The grant is revoked at Gravl (best effort) and cleared locally.
- Personal token: **Remove token** on the Gravl page, or set `gravl_api_token` to `null` in user settings.

Activities already imported are kept.
