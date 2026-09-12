---
slug: "xxxx"
authors: Fredrik Liljegren
status: DRAFT
dateReceived: (not yet submitted)
---

# FEP-xxxx: QuantPub — federated personal metrics for quantified-self sharing

> **Status of this document.** This is a pre-submission draft, developed in the
> open in the [Aurboda](https://github.com/fiddur/aurboda) repository (issue
> [#905](https://github.com/fiddur/aurboda/issues/905)) and intended for
> discussion on r/QuantifiedSelf and SocialHub before any submission to the
> [FEP process](https://codeberg.org/fediverse/fep). The FEP number is a
> placeholder.

> **Naming.** The working name is **QuantPub** with the namespace prefix
> `quant:`. The name is open for community input; alternatives under
> consideration include **Personal Metrics Vocabulary** and **MetricPub**.

## Summary

QuantPub is a small, vendor-neutral extension to [ActivityPub] for sharing
personal quantified-self data — workouts, sleep, heart-rate variability, steps,
mood — between federated instances **and** home-built personal tools, without
sacrificing either mainstream-fediverse compatibility or the author's control
over what leaves their instance.

It has three parts:

1. A tiny **vocabulary** (`quant:Exercise`, `quant:Observation`) for attaching
   typed scalar summaries and a bounded time window to an ordinary AS2 `Note`,
   so Mastodon-class servers render a readable status while implementing peers
   read machine-readable data.
2. An **out-of-band structured-payload pattern** — a well-known discovery
   document plus two public HTTP endpoints — because typed vocabulary
   extensions are, in practice, dropped by mainstream fediverse software. The
   out-of-band channel is the pragmatically interoperable core of this
   proposal.
3. **Privacy principles as normative requirements**: scalar summaries never
   imply series access, high-resolution series are a separate explicit opt-in,
   authorization is data-driven (unshared data is indistinguishable from
   nonexistent data), and revocation takes effect immediately.

A home-built QS tool can interoperate by implementing only the two endpoint
contracts and the discovery document — no ActivityPub actor required — and grow
into full federation later.

## Motivation

The quantified-self community is full of hand-rolled, single-user systems:
a database, some sync scripts, a dashboard. These tools will never converge on
one product, but they *could* converge on a small wire contract — and then
their owners could follow each other, see each other's structured data rendered
natively, and run cross-instance comparisons, the way single-vendor fitness
platforms do behind walled gardens today.

ActivityPub already solves identity, discovery, follow relationships, and
delivery. What is missing is:

- a shared shape for "a measured thing over a time window", and
- a realistic answer to the fact that **extension vocabularies do not survive
  federation** through mainstream servers. Mastodon-class software (and typed
  frameworks such as Fedify) parse inbound objects into a fixed vocabulary and
  drop unknown terms; an extension-only design silently degrades to nothing.

QuantPub therefore treats the in-band vocabulary as *progressive enhancement*
and standardises the out-of-band fetch: deliver a boring, Mastodon-compatible
`Note` (flattened text plus rendered-image attachments), and serve the
machine-readable payload at a discoverable public endpoint on the author's own
instance. A receiving peer that recognises the pattern fetches the structured
data; everyone else sees a perfectly good status.

This is running code: Aurboda federates activity shares and long-form articles
this way today, speaking this document's `quant:` vocabulary on the wire (see
Implementations). This FEP generalises that running code so any implementation
can join.

## Requirements

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in [RFC-2119].

## Specification

### 1. Conformance levels

- **Level 1 — Data publisher.** Serves the discovery document (§4) and the
  structured post and/or series endpoints (§5, §6). No ActivityPub required.
  Suitable for a static-ish personal site or a weekend-built QS tool.
- **Level 2 — Federated publisher.** Level 1, plus an ActivityPub actor that
  delivers `Note`-compatible objects (§2, §3) whose ids resolve to structured
  payloads via §5.
- **Level 3 — Federated peer.** Level 2, plus inbound: following others,
  detecting QuantPub-capable origins (§7), and enriching received posts with
  their structured payloads.

Naming is lowerCamelCase throughout. **JSON-LD extension terms** (the
`quant:` properties on AS2 objects) match ActivityStreams' own vocabulary,
and this proposal **reuses AS2 properties where they exist** (`startTime`,
`endTime`) instead of minting parallel terms. **HTTP payload fields and
metric keys** (§4–§6, §2.1) use the same lowerCamelCase — the payload layer
is a plain JSON contract, not JSON-LD, but one casing across both layers
matches AS2 and FitPub's established formats and means a post's `startTime`
and its payload's `startTime` are literally the same name. All timestamps are
ISO 8601 with timezone.
The JSON-LD namespace for the `quant:` prefix is `https://w3id.org/quantpub#`
(final IRI to be settled with the FEP number).

The values of `quant:metrics` and `quant:series` are **JSON literals**: the
published `@context` defines both terms with `"@type": "@json"` (JSON-LD 1.1),
so conforming processors preserve the nested objects verbatim — a metric's
`key`/`value`/`unit` and a series link's `metric`/`mediaType`/`href` — rather
than expanding (and losing) unmapped keys. This deliberately makes the
AS2-looking terms inside a series link (`mediaType`, `href`) opaque to JSON-LD
processing: a series entry is plain data, not an AS2 `Link` object. Consumers
MUST treat these values as plain JSON, not as JSON-LD node objects.

### 2. `quant:Exercise` — a shared workout

A shared exercise is an AS2 object, RECOMMENDED to be **dual-typed**
`["Note", "quant:Exercise"]` — `Note` first, so plain fediverse clients render
`name`/`content` as a status, while implementing peers recognise the second
type. The extra type is descriptive, not load-bearing: detection and
enrichment (§7) key on the object id or `quant:structuredUrl`, never on the
type, so a publisher MAY emit a single-typed `Note` where interoperability
requires it — deployed fediverse software mishandles array-valued `type` even
though multiple types are well-formed AS2 (FitPub's inbound handler, for one,
casts the object's `type` to a string and would reject or error on an array).

The typed fields:

| Property              | Type                    | Notes                                                                                      |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `startTime` (AS2)     | ISO 8601                | REQUIRED. Start of the bounded activity window — AS2's own property, reused                |
| `endTime` (AS2)       | ISO 8601                | End of the window (RECOMMENDED) — AS2's own property, reused                               |
| `quant:activityType`  | string                  | e.g. `running`, `cycling`, `meditation`                                                    |
| `quant:metrics`       | array of metric objects | The scalar summaries the author chose to share (§2.1)                                      |
| `quant:series`        | array of series links   | Links into the series endpoint — only for shared series on **publicly-visible** posts (§6) |
| `quant:structuredUrl` | URL                     | OPTIONAL explicit link to the object's §5 structured payload (see §7)                      |

Consumers MUST tolerate both the string and array forms of `type` on any
received object.

There is deliberately no duration property in the vocabulary: duration is
derivable from the window, and when the author chooses to share it as a stat
it appears in `quant:metrics` as the `duration` key (in seconds). AS2's
`duration` (`xsd:duration`) MAY be set additionally for plain-AS2 consumers.
(The §5 payload layer — plain JSON, not JSON-LD — still exposes a
`durationSeconds` convenience field.)

The `published` property carries the *share* time (timeline ordering); the
workout time lives in `startTime` — a workout shared a week later MUST NOT be
back-dated in followers' timelines.

#### 2.1 Metric objects

Each entry of `quant:metrics` is:

```json
{ "key": "heartRateAvg", "value": 152, "unit": "bpm" }
```

- `key` (REQUIRED): a lowerCamelCase machine key. This spec RECOMMENDS the common
  keys `duration`, `distance`, `heartRateAvg`, `heartRateMax`,
  `hrZoneMinutes`, `calories`, `steps`, `elevationGain`, `paceAvg`,
  `stressAvg`; implementations MAY add their own keys.
- `value` (REQUIRED): a number, or a small keyed record of numbers (e.g.
  HR-zone minutes `{ "z2": 22, "z3": 10 }`).
- `unit` (OPTIONAL): a unit string for the scalar form (`bpm`, `km`,
  `seconds`, `kcal`). A `seconds`-unit value SHOULD be rendered as a duration
  by consumers.

A publisher MUST emit only the metrics the author explicitly chose to share.
Absence of a key means "not shared", never "zero".

### 3. `quant:Observation` — a measured metric over a window

Exercise is one case of the general shape: *something was measured over a
bounded window*. A `quant:Observation` covers sleep, HRV, steps, mood, weight,
blood glucose — anything with a window and values. It is dual-typed
`["Note", "quant:Observation"]` (RECOMMENDED, with the same single-type
allowance as §2) and carries the same properties as §2 except
`quant:activityType`, replaced by:

| Property              | Type   | Notes                                              |
| --------------------- | ------ | -------------------------------------------------- |
| `quant:observationOf` | string | The domain observed, e.g. `sleep`, `daily`, `mood` |

The `quant:metrics` array carries the observed values with the same
`key`/`value`/`unit` shape (e.g. `sleepDuration`, `sleepScore`, `hrvAvg`,
`steps`, `mood`). An exercise is conceptually an observation with an activity
type; implementations MAY treat `quant:Exercise` as a specialisation of
`quant:Observation`.

### 4. Discovery: `/.well-known/quantpub`

An implementation MUST serve, at its web base URL:

```
GET /.well-known/quantpub
```

```json
{
  "product": "my-qs-tool",
  "version": "1.0.0",
  "quantpub": "0.1",
  "apiBase": "https://qs.example.net/api"
}
```

- `product` / `version`: free-form implementation identity.
- `quantpub`: the spec version implemented.
- `apiBase`: the absolute base URL under which the §5/§6 endpoints live.

This lets a peer verify a host speaks QuantPub and locate its API with one
cacheable request (responses SHOULD be cacheable, e.g. `max-age=3600`). It
mirrors the pattern of other `/.well-known` documents and deliberately does not
reuse NodeInfo: the document gates a fetch decision made on every ingest, so it
must be tiny and unambiguous.

### 5. Structured post endpoint

For every shared post, the origin MUST serve a machine-readable payload at:

```
GET {apiBase}/public/{username}/feed/{postId}
```

returning a JSON object discriminated on `kind`. For an exercise/observation
share, `kind: "activity"`:

```json
{
  "kind": "activity",
  "activityType": "running",
  "title": "Morning run",
  "startTime": "2026-08-15T06:30:00+02:00",
  "endTime": "2026-08-15T07:09:00+02:00",
  "durationSeconds": 2340,
  "metrics": [
    { "key": "duration", "value": 2340, "unit": "seconds" },
    { "key": "distance", "value": 8.2, "unit": "km" },
    { "key": "heartRateAvg", "value": 152, "unit": "bpm" },
    { "key": "hrZoneMinutes", "value": { "z2": 22, "z3": 10 } }
  ],
  "series": [
    {
      "metric": "heartRate",
      "unit": "bpm",
      "bucket": "5s",
      "samples": [
        {
          "start": "2026-08-15T06:30:00+02:00",
          "end": "2026-08-15T06:30:05+02:00",
          "avg": 121, "min": 118, "max": 124, "count": 5
        }
      ]
    }
  ],
  "route": [
    { "lat": 59.3251, "lon": 18.0710, "t": "2026-08-15T06:30:00+02:00" }
  ]
}
```

- `metrics` MUST contain exactly the shared scalars — the same set the
  delivered `Note` summarised.
- `series` MUST contain only series the author *separately* opted to share
  (§8), inlined as bucketed samples (§6.1) over the activity window. It MAY be
  empty.
- `route` (OPTIONAL) is the activity's GPS track as a time-ordered array of
  `{ "lat", "lon", "t" }` points (WGS84, ISO 8601 timestamps), downsampled by
  the publisher. Geography is its own explicit opt-in (§8.6): the field MUST
  be present only when the author chose to share the route — in Aurboda, by
  attaching the rendered route-map image, so the machine-readable track has
  exactly the same audience as the picture of it. This shape is used instead
  of a GeoJSON `LineString` because GeoJSON coordinate arrays carry no
  per-point time; the timestamps are what let a consumer sync the route to
  the series chart. They also
  expose position-at-time, and thus pace, to machine consumers — a client
  offering route sharing SHOULD say so.
- Implementations MAY define further `kind`s (Aurboda adds
  `kind: "article"` — a long-form post's title plus resolved prose/chart
  blocks). Consumers MUST ignore unknown kinds.

**Authorization** is by post visibility: a public or unlisted post resolves
unconditionally; a followers-only post resolves only with a valid capability
token or a signed follower fetch (§9); anything else — including a
nonexistent post — returns **404**.

### 6. Series endpoint

High-resolution series MUST NOT be embedded in federated objects. They are
served from one public, read-only endpoint:

```
GET {apiBase}/public/{username}/series?metric={key}&start={iso}&end={iso}&bucket={5s|60s|...}
```

A request resolves **only when all of the following hold** — this data-driven
check is the entire authorization boundary, and it is not obscurity-based:

1. Some shared post opted that exact `metric` in as a **series** (a shared
   scalar summary alone MUST NOT satisfy this);
2. that post is publicly visible (a followers-only share exposes no public
   series);
3. the underlying activity still exists (not deleted) and has a bounded window;
4. the activity's window covers the requested `[start, end]` range.

Anything else MUST return **404** — indistinguishable from a metric or window
that never existed. When the request resolves:

- The effective range MUST be clamped to the shared activity's window; the
  caller's bounds can never widen it.
- The bucket granularity MUST be floored server-side (RECOMMENDED minimum:
  5 seconds) to bound payload size and resolution.
- Only aggregated buckets are returned; per-measurement timestamps MUST be
  dropped.

#### 6.1 Bucketed samples

```json
{
  "metric": "heartRate",
  "unit": "bpm",
  "bucket": "5s",
  "samples": [
    {
      "start": "2026-08-15T06:30:00+02:00",
      "end": "2026-08-15T06:30:05+02:00",
      "avg": 121, "min": 118, "max": 124, "count": 5
    }
  ]
}
```

Each sample carries `start`, `end`, `avg`, `min`, `max`, `count`, and
optionally `sum` (for cumulative metrics such as steps). This one shape serves
exercise heart-rate traces, nightly HRV, daily step counts, and mood check-ins
alike — only the metric key and bucket size differ.

### 7. Detection and enrichment (Level 3)

A consuming peer needs a defined path from a received object to its §5
payload. Two mechanisms are specified; the id convention is the reliable
baseline, since typed AS2 frameworks on the *consuming* side may drop unknown
in-band properties before application code sees them:

- **Object-id convention (normative baseline).** A Level 2 publisher SHOULD
  mint post object ids as `{webBase}/users/{username}/feed/{postId}`. A
  consumer that matches this shape resolves the payload at
  `{apiBase}/public/{username}/feed/{postId}`, with `{apiBase}` taken from
  the origin's discovery document (§4).
- **`quant:structuredUrl` (in-band override).** A publisher whose URL layout
  differs MAY state the payload URL explicitly on the object. A consumer MUST
  only honour it when its host equals the object id's host — never fetch a
  cross-origin URL a remote object nominates.

On ingesting a `Create`/`Update` for a `Note`, a receiving peer:

1. checks whether the object carries `quant:structuredUrl` (same-host, above)
   or an id matching the object-id convention (a Mastodon status id never
   does, avoiding needless requests);
2. resolves the payload URL: a same-host `quant:structuredUrl` names it
   directly, so no discovery fetch is needed to *locate* it; the id
   convention instead requires `{apiBase}`, taken from
   `/.well-known/quantpub` on the object's origin host (cacheable). A
   consumer MAY still fetch the discovery document in the
   `quant:structuredUrl` case as a capability check on the origin, but MUST
   NOT require it;
3. fetches the structured post endpoint (§5) and stores the payload alongside
   the sanitised note for native rendering.

Enrichment MUST be best-effort and additive: any failure (non-QuantPub host,
404, malformed payload, timeout) leaves the plain note intact. Fetches MUST be
SSRF-guarded (public hosts only, no redirect following, size- and
time-bounded); see Security considerations.

### 8. Privacy model (normative)

1. **Scalars never imply series.** Sharing a scalar summary (e.g.
   `heartRateAvg`) MUST NOT expose the underlying series. A per-sample trace
   is far more revealing than an average.
2. **Series are a separate, explicit opt-in**, made per post, per metric. The
   default for any share MUST be: no series.
3. **Unshared equals nonexistent.** Requests for unshared data MUST return
   404, never 403 — the response must not reveal that unshared data exists.
4. **Revocation is immediate.** Deleting a post, narrowing its visibility,
   or removing a metric from its series opt-in MUST immediately stop the
   corresponding endpoints from resolving. **All** §5 and §6 responses —
   public and unlisted payloads included, not only capability-gated ones —
   MUST be served `Cache-Control: no-store`, so no intermediary extends
   access beyond revocation (a public post is just as deletable as a
   followers-only one). Only the discovery document (§4) is cacheable.
5. **Bounded resolution.** The server-side bucket floor (§6) is a privacy
   floor, not only a payload bound: implementations MUST NOT serve raw
   per-measurement *series* timestamps on public endpoints. (The §5 `route`'s
   per-fix `t` is not a series timestamp and is outside this rule's scope; it
   is governed by item 6.)
6. **Geography is its own explicit opt-in.** A GPS route MUST NOT be exposed
   by any scalar or series share; the default for any share MUST be: no
   route. Publishers SHOULD bound route resolution the way §6's bucket floor
   bounds series resolution — RECOMMENDED: at most 500 points per route (or
   an equivalent minimum inter-point spacing) — and SHOULD apply privacy
   geo-masking (home-zone trimming) before export, not only in rendering.

### 9. Capability tokens for follower-scoped payloads

Mainstream fediverse media and data fetches are **unsigned**: Mastodon's
"authorized fetch" signs ActivityPub object/actor requests, not media
downloads, so an HTTP-Signature-*only* gate on data endpoints would leave
Mastodon-class followers seeing broken content — and a Level 1 publisher has
no actor keys to verify against at all. QuantPub therefore uses **capability
URLs** as the baseline for followers-only posts:

- Each followers-only post carries an unguessable token. Its structured-payload
  and image URLs include `?token={token}` **only in the copies delivered to
  accepted followers** — the token never appears on any public surface.
- **Token conveyance MUST survive typed processing.** The §7 id convention
  alone yields a tokenless payload URL (a 404 for a followers-only post), and
  an extension property like `quant:structuredUrl` may be dropped by a typed
  consumer before application code sees it (§7). A publisher MUST therefore
  convey the token on every followers-only delivery through at least one of
  two channels, and MUST use the first whenever the post carries image
  attachments: (a) the delivered **image attachment URLs** (`?token={token}`
  on each `attachment` `Image` `url`) — standard AS2 attachments survive
  typed vocabularies; (b) `quant:structuredUrl` carrying the token, the only
  channel available for an **attachment-less** post (e.g. a followers-only
  sleep observation with no chart) — its survival depends on the consumer
  preserving unknown properties, so a publisher SHOULD attach at least one
  tokenised image where the post has any renderable image at all. Consumers
  SHOULD lift the token from a delivered attachment URL, falling back to a
  same-host `quant:structuredUrl`, and forward it to the structured-payload
  fetch. (Aurboda ships both channels; see Implementations.)
- A request with a matching token resolves; without one, 404 (§8.3).
- Tokens MUST be generated with a cryptographically secure RNG and MUST be
  revocable (regenerated or invalidated when the post is deleted or its
  visibility changes); combined with `no-store` (§8.4), revocation is
  immediate.
- The tradeoff is explicit: a leaked capability URL grants access to that one
  post's shared payload — never to the public series endpoint, which serves
  publicly-visible shares only.

**Signed fetches as an additional grant.** Purpose-built peers *can* sign
their data fetches — FitPub already authorizes followers-only activity details
by verifying an HTTP Signature on the detail `GET` against the requesting
actor's key and follow state. A Level 2+ publisher MAY therefore additionally
resolve a followers-only §5 payload for a request bearing a valid [HTTP
Signature] from an accepted follower (or that follower's instance actor),
and a Level 3 consumer SHOULD sign its enrichment fetches with its actor key
when it has one, so such publishers can grant access even where a token was
lost in transit. Signature authorization is strictly additive: it MUST NOT
replace capability tokens (which remain the only channel that works without
ActivityPub key material on either side), and a request that satisfies
neither channel still returns 404, never 403 (§8.3).

### 10. Coexistence and incremental adoption

Every part of this proposal is additive, so an implementation with an
established federation format can adopt it without breaking federation with
its own older versions:

- The discovery document (§4) and the §5/§6 endpoints are **new routes**; an
  existing vendor detail endpoint keeps serving unchanged alongside them.
- The `quant:*` properties and `quant:structuredUrl` ride alongside any
  existing vendor extension on the same `Note` (e.g. FitPub's
  `fitpub:detailUri`); consumers ignore properties they don't know, so old
  peers see exactly the object they saw before.
- Dual-typing is RECOMMENDED but not required (§2), because array-valued
  `type` is the one addition known to break some deployed consumers; a
  publisher whose install base predates array-type tolerance SHOULD start
  single-typed and add the second type once its consumers tolerate arrays.
- Nothing in §7 requires the *object id* to change: a publisher keeping its
  existing id layout uses `quant:structuredUrl` instead of the id convention.

## Implementing this in a weekend

A home-built QS tool becomes a **Level 1 publisher** with two-and-a-half
routes and no ActivityPub stack:

1. Serve `/.well-known/quantpub` (static JSON, §4).
2. Serve `GET /public/{you}/feed/{postId}` for each thing you choose to
   publish (§5) — for a single-user tool this can be near-static JSON.
3. Optionally serve the series endpoint (§6) for the series you explicitly
   share, with the four-condition check and 404 fallback.

Any Level 3 peer that learns one of your post URLs (a link in a toot, a
challenge, a directory) can now render your data natively. Adding a minimal
ActivityPub actor (WebFinger + inbox/outbox + `Create{Note}` delivery — Level
2) later makes you followable from Mastodon and every QuantPub peer, with the
structured channel already in place.

## Examples

### A federated exercise share (`Create`)

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    {
      "quant": "https://w3id.org/quantpub#",
      "quant:metrics": { "@type": "@json" },
      "quant:series": { "@type": "@json" }
    }
  ],
  "id": "https://qs.example.net/users/freja/feed/01J5X0#create",
  "type": "Create",
  "actor": "https://qs.example.net/users/freja",
  "published": "2026-08-15T08:02:11+02:00",
  "to": ["https://www.w3.org/ns/activitystreams#Public"],
  "cc": ["https://qs.example.net/users/freja/followers"],
  "object": {
    "id": "https://qs.example.net/users/freja/feed/01J5X0",
    "type": ["Note", "quant:Exercise"],
    "attributedTo": "https://qs.example.net/users/freja",
    "name": "Morning run",
    "content": "<p><strong>Morning run</strong></p><p>Duration 39m · Distance 8.2 km · Heart rate avg 152 bpm · HR zones z2 22, z3 10</p>",
    "published": "2026-08-15T08:02:11+02:00",
    "startTime": "2026-08-15T06:30:00+02:00",
    "endTime": "2026-08-15T07:09:00+02:00",
    "quant:activityType": "running",
    "quant:structuredUrl": "https://qs.example.net/api/public/freja/feed/01J5X0",
    "quant:metrics": [
      { "key": "duration", "value": 2340, "unit": "seconds" },
      { "key": "distance", "value": 8.2, "unit": "km" },
      { "key": "heartRateAvg", "value": 152, "unit": "bpm" },
      { "key": "hrZoneMinutes", "value": { "z2": 22, "z3": 10 } }
    ],
    "quant:series": [
      {
        "metric": "heartRate",
        "mediaType": "application/json",
        "href": "https://qs.example.net/api/public/freja/series?metric=heartRate&start=2026-08-15T06%3A30%3A00%2B02%3A00&end=2026-08-15T07%3A09%3A00%2B02%3A00&bucket=5s"
      }
    ]
  }
}
```

Mastodon renders the `content` and any attached chart image; a QuantPub peer
recognises the id shape (or the same-host `quant:structuredUrl`), discovers
the origin, and fetches the §5 payload. The inline `"@type": "@json"` term
definitions mirror what the published `@context` document will carry (§1);
once the final context IRI is settled, referencing it alone suffices.

### A sleep observation (object only)

```json
{
  "type": ["Note", "quant:Observation"],
  "name": "Last night's sleep",
  "content": "<p><strong>Last night's sleep</strong></p><p>Sleep 7h 40m · HRV avg 64 ms · Score 86</p>",
  "quant:observationOf": "sleep",
  "startTime": "2026-08-14T23:05:00+02:00",
  "endTime": "2026-08-15T06:45:00+02:00",
  "quant:metrics": [
    { "key": "sleepDuration", "value": 27600, "unit": "seconds" },
    { "key": "hrvAvg", "value": 64, "unit": "ms" },
    { "key": "sleepScore", "value": 86 }
  ]
}
```

### Series requests and the 404 boundary

```
GET /api/public/freja/series?metric=heartRate&start=2026-08-15T06:30:00%2B02:00&end=2026-08-15T07:09:00%2B02:00&bucket=60s
→ 200, bucketed samples (shared as a series on a public post, window covered)

GET /api/public/freja/series?metric=heartRate&start=2026-08-14T00:00:00Z&end=2026-08-16T00:00:00Z&bucket=60s
→ 404 (window not covered by any shared activity — the share can't be widened)

GET /api/public/freja/series?metric=stress&start=...&end=...&bucket=60s
→ 404 (stress scalar was shared, but its series was not opted in)
```

## Security considerations

- **Enrichment fetches are server-side requests to remote-controlled URLs.**
  Level 3 peers MUST SSRF-guard them: resolve to public addresses only, refuse
  redirects, and bound response size and time. The fetch origin SHOULD be
  restricted to the accepted followee's own host.
- **Remote content is untrusted.** Received `content` HTML MUST be sanitised
  server-side before storage/render; structured payloads MUST be
  schema-validated, and malformed payloads discarded (leaving the plain note).
- **Capability URLs can leak** (referrer headers, logs, pasted exports). Their
  blast radius is deliberately one post's shared payload; implementations
  SHOULD refuse to embed follower-scoped tokens in publicly-pasteable exports.
- **The 404 discipline is load-bearing.** Any distinguishable response for
  "exists but unshared" (403, different timing, different body) becomes a
  probe oracle for what data a user has.
- **Aggregation is not anonymisation.** Bucketed series still reveal patterns
  (sleep schedules, home departure times via workout starts). The per-metric,
  per-post opt-in exists so that authors make this choice deliberately;
  clients SHOULD present series sharing as distinct from summary sharing.
- **Routes are the most identifying payload.** A shared GPS track typically
  starts or ends at home. The §5 `route` opt-in binds the machine-readable
  track to the visual route image the author already chose to share, but
  publishers SHOULD offer home-zone masking and apply it before export, not
  only in rendering.

## Prior art

- **[FitPub](https://fitpub.social/)** — federated fitness tracking
  (Java/Spring, multi-instance) whose wire format is this proposal's closest
  relative and directly informed §10 and the §9 signed-fetch grant. FitPub
  delivers a plain `Note` (HTML content, one-line stat summary, generated
  map-image attachment) with AS2 `startTime`/`endTime` and an in-band pointer
  `fitpub: { "detailUri": … }` (namespace `https://fitpub.social/ns#`) to an
  out-of-band detail endpoint — the same Note-plus-pointer architecture as
  §2/§5. It differs in the parts this proposal standardises: the detail
  payload is its internal API DTO (fixed camelCase schema: `totalDistance`,
  `metrics.averageHeartRate`, `simplifiedTrack` GeoJSON, …) rather than a
  vendor-neutral contract; detection is by property presence plus NodeInfo
  software identity rather than a capability document; followers-only details
  are authorized by signed `GET`s (adopted here as the optional §9 grant)
  rather than capability tokens; non-public objects answer `403` rather than
  this proposal's normative `404` (§8.3); and it consumes only scalars and
  track geometry — no series concept. §10 describes how such an
  implementation adopts QuantPub without breaking federation with its own
  older versions. (Format read from the [FitPub
  source](https://codeberg.org/fitpub/fitpub) as of 2026-08-21:
  `ActivityPostProcessingService`, `ActivityPubContexts`,
  `RemoteActivityDetailsFetcher`, and `docs/federation.md`.)
- **[Open Pace](https://github.com/edance/openpace)** — federated running
  publishing; single-domain (exercise) and product-shaped rather than a
  vocabulary for arbitrary metrics.
- **[Endurain](https://github.com/joaovitoriasilva/endurain)** and
  **[Wanderer](https://github.com/Flomp/wanderer)** — self-hosted fitness /
  trail platforms with federation interest; natural candidate implementers.
- **[FEP-67ff]** (FEDERATION.md) — documenting federation behaviour per
  implementation; a QuantPub implementation SHOULD document its supported
  metric keys and endpoints there.
- **[FEP-400e]** — *Publicly appendable ActivityPub collections* (grishka;
  received 2021-02-16, finalized 2022-02-04): lets foreign actors append
  objects to a collection another actor owns. Not used by this document, but
  the natural building block for the QuantPub-adjacent feature of federated
  challenge leaderboards (cross-instance competitions appending member
  standings).
- Mastodon's handling of unknown types/properties — the observed behaviour
  (extensions dropped, `Article` content discarded) that motivates the
  `Note`-first dual-typing and the out-of-band channel.

## Implementations

- **[Aurboda](https://github.com/fiddur/aurboda)** — ships this document's
  vocabulary on the wire: delivered exercise shares are dual-typed
  `["Note", "quant:Exercise"]` with AS2 `startTime`/`endTime`,
  `quant:activityType`, `quant:metrics`, `quant:series`, and
  `quant:structuredUrl` (inline `@context` term definitions on every
  delivered/served object), serves the `/.well-known/quantpub` discovery
  document (§4) and a published context document at `/ns/quantpub`, the
  structured post endpoint (activity and article kinds, including the
  optional downsampled `route` — shared by attaching the route-map image, so
  track and image have the same audience), the data-driven
  public series endpoint, capability tokens for followers-only payloads, and
  Level 3 ingest/enrichment between Aurboda instances via the §7 id
  convention. This FEP generalises that running code — including the §9 token
  lift from delivered attachment URLs (`capabilityTokenFrom` in its
  enrichment path). Its delivery path matches §7's id convention: the
  delivered `Note`'s id is the resolvable post URL, with the `Create` as a
  `#create` fragment. (Remaining vendor-prefixed surface: the
  `/.well-known/aurboda` document backs Aurboda-specific challenge
  federation, alongside — not instead of — `/.well-known/quantpub`.) Aurboda's
  payload field naming predates this document's lowerCamelCase alignment — it
  currently serves the earlier snake_case forms (`start_time`, `api_base`,
  `heart_rate_avg`, …) — and will be updated once the naming settles in
  review.

## Copyright

CC0 1.0 Universal (CC0 1.0) Public Domain Dedication.

To the extent possible under law, the authors of this Fediverse Enhancement
Proposal have waived all copyright and related or neighboring rights to this
work.

[ActivityPub]: https://www.w3.org/TR/activitypub/
[HTTP Signature]: https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures
[RFC-2119]: https://datatracker.ietf.org/doc/html/rfc2119
[FEP-67ff]: https://codeberg.org/fediverse/fep/src/branch/main/fep/67ff/fep-67ff.md
[FEP-400e]: https://codeberg.org/fediverse/fep/src/branch/main/fep/400e/fep-400e.md
