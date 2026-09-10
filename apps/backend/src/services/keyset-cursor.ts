/**
 * Opaque keyset-pagination cursor shared by the paginated feed surfaces (the
 * home timeline on `(published_at, id)`, the owner's feed and the public profile
 * listing on `(created_at, id)`): a `(timestamp, uuid)` position encoded as one
 * base64url token, so clients treat it as opaque and a crafted value can't reach
 * the SQL layer.
 *
 * The timestamp travels as Postgres' own `timestamptz::text` rendering, at full
 * **microsecond** precision. Round-tripping it through a JS `Date` would truncate
 * to milliseconds, and the page predicate compares at microsecond precision — so
 * a row sharing the cursor's millisecond but sorting after it would be excluded
 * by every page and become unreachable (#1025).
 */

export interface KeysetCursor {
  /** The boundary row's timestamp as Postgres text (µs precision), for `$::timestamptz`. */
  ts: string
  id: string
}

/** Encode a `(timestamp, id)` keyset position as an opaque base64url cursor. */
export const encodeKeysetCursor = (ts: string, id: string): string =>
  Buffer.from(`${ts}:${id}`).toString('base64url')

/** A canonical UUID, to validate a decoded cursor's id before it hits a `$::uuid` cast. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A Postgres `timestamptz::text` rendering (`2026-08-20 09:00:00.5007+00`) or the
 * ISO form of the same instant. Strict: the value is cast to `timestamptz` in the
 * page predicates, so anything else must decode to "no cursor" rather than reach
 * the SQL layer.
 */
const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

/**
 * A cursor issued BEFORE the µs-precision change: `<epoch-ms>:<uuid>`. Clients
 * hold these right now, so they keep working (at the old ms precision) instead of
 * silently sending every open page back to the top. `Number.isSafeInteger` alone
 * admits values outside the `Date` range, which would hand SQL an `Invalid Date`
 * — hence the finiteness check (#1023).
 */
const legacyMsToTs = (raw: string): string | undefined => {
  if (!/^-?\d+$/.test(raw)) return undefined
  const ms = Number(raw)
  if (!Number.isSafeInteger(ms)) return undefined
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/** Decode an opaque cursor, or undefined if it's missing/malformed (→ first page). */
export const decodeKeysetCursor = (cursor: string | undefined): KeysetCursor | undefined => {
  if (cursor == null || cursor === '') return undefined
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  // The timestamp itself contains colons, the uuid never does — so the LAST
  // colon is the separator in both the current and the legacy form.
  const sep = decoded.lastIndexOf(':')
  if (sep <= 0) return undefined
  const raw = decoded.slice(0, sep)
  const id = decoded.slice(sep + 1)
  // Validate the id is a UUID: it's cast to `uuid` in the page queries, so a
  // crafted `12345:not-a-uuid` cursor would otherwise 500 instead of paging.
  if (!UUID_RE.test(id)) return undefined
  if (TS_RE.test(raw)) return { id, ts: raw }
  const ts = legacyMsToTs(raw)
  return ts === undefined ? undefined : { id, ts }
}
