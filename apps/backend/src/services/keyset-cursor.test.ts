import { describe, expect, test } from 'vitest'

import { decodeKeysetCursor, encodeKeysetCursor } from './keyset-cursor.ts'

const UUID = '11111111-2222-4333-8444-555555555555'

describe('keyset cursor', () => {
  test('round-trips a (timestamp, id) position', () => {
    const ts = '2026-07-01T08:00:00.123Z'
    expect(decodeKeysetCursor(encodeKeysetCursor(ts, UUID))).toEqual({ id: UUID, ts })
  })

  test('carries Postgres’ own µs-precision rendering through unchanged (#1025)', () => {
    // `timestamptz::text`, the form the page queries select for the cursor: a
    // space separator, six fractional digits and a bare `+00` offset. Losing the
    // sub-millisecond part here would make a row inside that millisecond
    // unreachable from every page.
    const ts = '2026-08-20 09:00:00.500712+00'
    expect(decodeKeysetCursor(encodeKeysetCursor(ts, UUID))).toEqual({ id: UUID, ts })
  })

  test('still accepts a legacy <epoch-ms>:<uuid> cursor issued before the change', () => {
    // Clients hold these right now; rejecting one would silently send every open
    // page back to the top.
    const legacy = Buffer.from(`1787216400500:${UUID}`).toString('base64url')
    expect(decodeKeysetCursor(legacy)).toEqual({ id: UUID, ts: new Date(1787216400500).toISOString() })
  })

  test('missing/empty cursor decodes to undefined (first page)', () => {
    expect(decodeKeysetCursor(undefined)).toBeUndefined()
    expect(decodeKeysetCursor('')).toBeUndefined()
  })

  test('malformed cursors decode to undefined instead of reaching the SQL layer', () => {
    expect(decodeKeysetCursor('not base64url!')).toBeUndefined()
    // Valid base64url but no separator / non-UUID id / non-timestamp position.
    expect(decodeKeysetCursor(Buffer.from('justonepart').toString('base64url'))).toBeUndefined()
    expect(decodeKeysetCursor(Buffer.from('12345:not-a-uuid').toString('base64url'))).toBeUndefined()
    expect(decodeKeysetCursor(Buffer.from(`NaN:${UUID}`).toString('base64url'))).toBeUndefined()
    expect(decodeKeysetCursor(Buffer.from(`not-a-date:${UUID}`).toString('base64url'))).toBeUndefined()
    // A timestamp shape Postgres wouldn't produce (no offset, 7 fractional digits).
    expect(
      decodeKeysetCursor(Buffer.from(`2026-08-20 09:00:00:${UUID}`).toString('base64url')),
    ).toBeUndefined()
    expect(
      decodeKeysetCursor(Buffer.from(`2026-08-20 09:00:00.1234567+00:${UUID}`).toString('base64url')),
    ).toBeUndefined()
  })

  test('a legacy ms value outside the Date range decodes to undefined, not an Invalid Date (#1023)', () => {
    // `Number.isSafeInteger` admits it, but `new Date(ms)` is Invalid — which
    // node-postgres would render as an unparsable timestamp and 500 on.
    const crafted = Buffer.from(`9007199254740991:${UUID}`).toString('base64url')
    expect(decodeKeysetCursor(crafted)).toBeUndefined()
  })
})
