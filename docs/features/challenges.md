# Challenges (federated competitions)

A **challenge** is hosted by one user and measures a single built-in metric or
activity type — as a cumulative total — over a date span. Other users **join**,
including from a **different Aurboda instance**, and the challenge page shows a race
chart + leaderboard of each member's running total.

Challenges build directly on the [sharing](./sharing.md) foundation: the same
public `/u/:username/:slug` namespace, slugged public-or-unlisted visibility, the
base-URL federation identity, and the bucketed-data engine behind dashboards.

## Model

- **Spec (v1):** one `metric` (e.g. `steps`, summed) or `activity_type` (e.g.
  strength-training hours, summed) over `[start_ts, end_ts)` in a chosen timezone.
  Scoring is the cumulative total. (Buckets are computed in UTC for v1 — totals over
  a fixed window are exact and aligned across members; timezone-local bucketing is a
  later refinement.)
- **Members** are identified by their full public base URL
  (`https://host/u/user`). The host is always a member. A member contributes data
  through a capability **data endpoint** on their own instance.
- **Same instance is just an optimization:** when a member's host is this instance,
  the aggregator reads their data in-process instead of over HTTP. One join protocol,
  one data shape.
- **Visibility:** the `visibility` field is the shared `ShareVisibility` vocabulary
  (`public`/`unlisted`) also used by shared dashboards and the feed (see
  [Sharing](./sharing.md)). `public` challenges are listed on the host's `/u/<user>`
  profile; `unlisted` ones are reachable only by their slug. Stored as an `is_public`
  boolean and mapped at the API boundary.
- **Chart granularity (`spec.bucket_size`):** controls only the race chart's
  resolution — never the score (the cumulative total is bucket-size-independent).
  `auto` (default) adapts to the window so short challenges show intraday progress and
  long ones stay readable/cheap: ≤1d → 5-minute, ≤3d → 15-minute, ≤14d → 1-hour,
  ≤120d → daily, else weekly. A creator can instead fix a coarser bucket
  (`1d`/`1w`/`1M`) for very long challenges. The resolved size is exposed to viewers as
  `effective_bucket_size` on the public challenge; because it derives purely from the
  window, every instance resolves the same size, so members' series stay aligned.

## URLs & storage

- A challenge lives at `<public-base>/u/<username>/<slug>` — the **same namespace**
  as shared dashboards. The public resolver `/public/:username/:slug` returns a
  `type` (`dashboard` | `challenge`); slugs are unique across both per user.
- Challenges + members live in the **host's** per-user DB; a joiner's
  _participations_ live in the **joiner's** DB, each backed by an unguessable
  `data_token`. No central-DB tables.

## Federation protocol

Endpoints (under each instance's API base):

| Endpoint                                | Auth              | Purpose                                                                               |
| --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `GET /.well-known/aurboda`              | none              | Discovery: `{ product, version, federation, api_base }`                               |
| `GET /public/:username/:slug`           | none              | Resolve a slug → dashboard or challenge spec (incl. `join_token`, public member list) |
| `POST /public/:username/:slug/members`  | none              | Register-back: a joining instance adds itself as a remote member                      |
| `GET /public/:username/:slug/standings` | none (slug-gated) | Host-aggregated standings (`?refresh=1` busts the cache)                              |
| `GET /challenge-data/:username/:token`  | none (token)      | A member instance serves its own series for one challenge                             |
| `GET /public/:username/dashboards`      | none              | Public profile listing: public dashboards + public challenges (name, link, window, spec) |

**Join (canonical: "join by challenge URL on your own instance B", host = A):**

1. B reads `<A-base>/.well-known/aurboda` to verify A is an Aurboda host + locate its API.
2. B fetches the spec from `<A-api>/public/<user>/<slug>`.
3. B records a local participation (spec snapshot + random `data_token`), making
   `GET <B-api>/challenge-data/<user>/<token>` live.
4. B registers back to `<A-api>/public/<user>/<slug>/members` with its identity,
   display name, data-endpoint URL, and the `join_token`.
5. A validates the token, probes the endpoint, and stores the member.

The same-server "Join" button and the challenge page's "enter your host" prompt both
funnel into this. When B === A, steps 1–5 collapse to a direct local membership.

**Standings:** the host pulls each remote member's data endpoint (5-minute TTL cache,
persisted per member; a failed fetch falls back to last-known data flagged `stale`)
and computes local members in-process.

Each standing carries a **`last_updated`** — when that member's _contributing_ data
last changed. For a metric it is the newest `updated_at` among the contributing points
(the moment a point's value last changed; daily aggregates such as steps keep one row
per day at local midnight and are rewritten in place all day, so their `time` would
always read 00:00), falling back to the point's `time` for rows stored before
`updated_at` existed. For an activity type it is `MAX(start_time)` of the matching
activities. The same source filter bounds it as bounds the total. A member with
no data yet reports `null` (rendered as "—"), never the request time — so members on
0 don't all share a bogus "just now". Remote members report their own `last_updated`;
the host persists it (distinct from `last_fetched_at`, which is when the host fetched)
and surfaces it in standings.

**Discovery — open challenges from people you follow:** `GET /challenges/discover`
(MCP `discover_challenges`) walks the user's accepted ActivityPub followees. A followee
whose actor id has the `<base>/users/<name>` shape is a _candidate_ Aurboda peer
(Mastodon mints the same shape); `<base>/.well-known/aurboda` decides, remembered per
instance for an hour so a Mastodon followee costs one probe, not one per page load (and
one probe per instance even on a cold round: concurrent followees share the in-flight
one). Only a _definite_ answer is remembered — a 404 for the well-known document, a body
that isn't Aurboda's, a refused private address. Anything that says nothing about the
host (no answer at all, a 5xx, a 429 or 403, a DNS failure or a timeout) is transient:
it is not cached, the peer is retried next round, and it is counted instead in
`peers_unreachable`.

An Aurboda peer's public challenges are read from its public-profile listing (a followee
on the same instance in-process); ended ones, anything the user hosts, joined or left,
and any link that doesn't point into the host's own `/u/<name>/` space are dropped.
Leaving a challenge hard-deletes the participation row, so the "don't offer this again"
fact is kept as a tombstone in `challenge_left`, keyed by the canonical challenge URL
(query string and fragment dropped, trailing slashes trimmed, scheme and host
lowercased — the same spelling a joined participation is stored under, so the same
challenge pasted two ways is one challenge). Joining again clears the tombstone. The
result is ongoing first (soonest to end), then upcoming, plus `peers_unreachable` — how
many followed _instances_ didn't answer this round (three followees on one dead host
count once). Unlisted challenges are not discoverable, by design; a peer from before the
listing carried windows lists name + link only and is skipped rather than shown as
"ongoing".

## Completion & winner announcement

When a challenge's window closes, the **host's instance** announces the result: a
`challenge` post on the host's feed (see [feed.md](feed.md#feed-posts)) carrying the
frozen **final standings** — the podium (everyone ranked 1–3; competition ranking, so
equal totals share a rank and a tie for first means several winners) plus the member
count — with each **winner tagged** as an ActivityPub `Mention` (and addressed in
`cc`, delivered to their inbox), so the winner's own instance notifies them even when
they don't follow the host (a post mentioning you is one you're _involved_ in, see
[feed.md](feed.md#home-timeline-inbound)). A `public` challenge announces publicly; an
`unlisted` challenge is link-only by the host's choice, and even an `unlisted` post is
world-readable and would publish the slug (which hands out the join token + member
list), so its result goes to **followers only** — the tagged winners still get it in
their inbox. Only members who scored make the podium; a challenge nobody scored in
announces nothing.

- **Host setting:** `announce_winner` on the challenge (default **true**). In the web
  app: the "Announce the winner to my feed when it ends" checkbox when creating, and an
  "Announce winner" toggle on each hosted row while `announcement_pending` is true —
  the announcement has not been made or skipped (`result_published_at` unset) and the
  challenge has not ended, or ended within the 3-day announce window; older ones are
  never visited by the sweep, so the toggle disappears rather than promising nothing
  (#1078). Over the API the field is on `POST`/`PUT /challenges` and the
  `create_challenge` / `update_challenge` MCP tools.
- **Timing:** a scheduled sweep (pg-boss cron, every 10 minutes, over every user's
  hosted challenges) announces a challenge once it has been over for a **6-hour grace
  period**, so members' last-day data has had time to sync before the podium is
  frozen. Standings are re-fetched (remote members included) at that moment. A
  **stale** member — their instance couldn't be reached, so the host only has
  last-known (or zero) data — holds the announcement back to the next sweep rather
  than freezing a podium on cached totals; once the challenge has been over for
  **24 hours** (`STALE_ACCEPT_AFTER_MS`) last-known data is accepted so an instance
  that is gone for good can't block the result forever.
- **Once only, never retroactively:** `result_published_at` on the challenge is stamped
  when the announcement is made (or deliberately skipped), so a challenge never
  announces twice. Only challenges that ended within the last **3 days** are ever announced
  (`MAX_ANNOUNCE_AGE_MS`) — the column backfills `announce_winner = true` onto
  pre-existing challenges, and without that bound the first sweep after deploy would
  fan out every challenge that ever finished (federated deliveries can't be recalled).
  A sweep also publishes at most **20** posts (`MAX_ANNOUNCEMENTS_PER_SWEEP`); the rest
  wait for the next tick. Switching `announce_winner` off before the sweep runs
  suppresses the post; switching it back on later (still inside the window) re-arms it.
  `result_published_at` and the derived `announcement_pending` are exposed on the
  hosted `Challenge`.
- **Result payload** (`ChallengeResult` on the post's `challenge.result`): a snapshot
  of names, identities, ranks and totals as of the announcement. A winner's identity
  (`<base>/u/<user>`) maps to their actor id (`<base>/users/<user>`) for the `Mention`,
  and to their `@user@host` handle for its name; the federated HTML links the winner
  Mastodon-style (`h-card` / `u-url mention`).

The public challenge page medals the podium as soon as the window has closed (🏆/🥈/🥉
in the rank column), and the Android widget shows a result banner (see below). Both are
**provisional until the announcement**: the host's post freezes the podium only after
the grace period (up to 24 h with a stale member), and a member's last-day data syncing
in the meantime can still reorder the page (#1076). The page says so rather than
calling the standings final.

## Security & trust

- The unguessable slug + capability tokens are the gates; data endpoints are
  **host-only secrets** (never in any public response).
- `join_token` proves a joiner actually fetched the spec; the host probes the data
  endpoint before accepting and can remove members. Leaving deletes the participation
  so the endpoint 404s.
- **Trust model:** a member's instance is trusted to report honest numbers
  (Strava-style). A malicious self-hoster could serve fabricated values — accepted
  for now; instance-key signed requests are a future hardening.

## Deployment note

`GET /.well-known/aurboda` must be reachable at the **web base URL** an operator
gives out (e.g. `https://aurboda.net/.well-known/aurboda`). Route `/.well-known/*`
to the backend in the reverse proxy (standard for federation). Dev instances that hit
the backend directly need no extra config.

## Using it in the web app

- **Manage** at `/challenges` ("Challenges" under the sidebar **Sharing** section): create a challenge (name,
  metric or activity type, sum/count, unit, date range with This-week/This-month
  quick-sets, public/unlisted), copy its link, delete it; see challenges you've
  joined; and **join by URL** (paste any challenge link — local or remote).
- **From people you follow:** open challenges hosted by followed users (any Aurboda
  instance) that you haven't joined, each with a one-click **Join** — see _Discovery_
  above. The section is hidden while there is nothing to show; a note says when a
  followed instance couldn't be reached.
- **View** at `/u/<username>/<slug>`: a cumulative **race chart** (one line per
  member) + a **leaderboard** (rank, colour dot matching the member's chart line,
  `@member · host`, total, freshness). This is
  the same `/u/:username/:slug` page as shared dashboards — the server returns a
  `type` and the page renders the right view.
- **Join buttons:** logged-in users on the host instance get a one-click **Join**;
  anyone can **Join from another instance** (enter your Aurboda host → you're sent
  to your own instance's `/challenges/join`, which does the federated join).
- **Share to feed** (#994): every row on `/challenges` — hosted **and** joined — has a
  **Share to feed** button that publishes an invitation to the federated feed: an
  optional personal note (markdown, previewed in the dialog) plus the challenge's
  canonical link, with the usual `public`/`unlisted`/`followers` audience. The server
  resolves the linked name/URL from the challenge (or the joined participation) itself,
  and never embeds a join token or standings data. Federates as a `Note`; Mastodon shows
  the link with the challenge page's OG preview card. Also available as the
  `share_challenge` MCP tool / `POST /feed/challenges`. See
  [feed.md](feed.md#feed-posts) for the post model.

## Android widget

The Android app has a home-screen **Challenge widget** (2×2 and up): pick a
hosted or joined challenge when placing it and it shows the race chart and
leaderboard (same member colours as the web page), refreshed after each sync;
tapping it opens the challenge in the app. Standings are read from the hosting
instance's public standings endpoint, so it works for challenges hosted elsewhere
too. Once the challenge has ended the widget shows the **final standings**: a
banner with a big 🏆 "You won!" when you won (🥈 / 🥉 "You came 2nd/3rd" with the
winner named when you made the podium; otherwise who won and where you finished),
and medals in the leaderboard's rank column.

Reconfiguring a widget is awkward on some launchers, so a day after its challenge
ends the widget **moves on by itself**: to the running challenge of yours that ends
soonest, else the upcoming one that starts soonest (a challenge that vanished from
your lists — left, or deleted by its host — is replaced right away). With nothing
of your own open it **suggests** the first discovered challenge (see _Discovery_)
— "Join a challenge?" with its name, host and window; a tap opens its page with
the Join button. Without a suggestion the finished challenge's result stays up.
See `docs/android-app.md` → _Home-screen widgets_.

## API surface (authed, owner/joiner)

`/challenges` — `GET` (list hosted), `POST` (create), `GET/PUT/DELETE /:id`,
`GET /:id/standings`, `GET /:id/members`, `DELETE /:id/members/:memberId`,
`GET /challenges/participations/mine`, `GET /challenges/discover`, `POST /challenges/join`,
`DELETE /challenges/participations/:id`. The same CRUD + join is available over MCP
(`create/list/update/delete_challenge`, `join_challenge`). A hosted challenge carries
`announce_winner` (create/update/read; see _Completion & winner announcement_).

## Out of scope (v1) / future hardening

- Background polling, timezone-local bucketing, goals/consistency/teams.
- **Signed instance-to-instance requests** (instance keypairs) — would bind a
  registering member's identity to the instance that vouches for it, closing the
  register-back gaps below.
- Register-back is capped per challenge (`MAX_CHALLENGE_MEMBERS`) to bound growth,
  but within the v1 trust model a slug+`join_token` holder can still re-register an
  existing _remote_ member (overwriting its data-endpoint URL). Accepted for now.
- Standings has no in-flight de-duplication, so concurrent requests on a cold/expired
  cache each fan out to every remote member (thundering herd, bounded by the TTL +
  8s per-fetch timeout). A shared in-flight promise per challenge would remove it.
