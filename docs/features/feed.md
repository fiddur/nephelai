# Federated Activity Feed

The activity feed lets a user publish an **activity** (a run, a night's sleep, a
meditation, …) to their public feed, choosing **per post exactly which data leaves the
instance**, and have it delivered over **ActivityPub** to followers on Mastodon and the
wider fediverse. It reuses the same base-URL identity and `/u/<username>` namespace as
[shared dashboards](./sharing.md) and [challenges](./challenges.md).

The feed is built on [Fedify](https://fedify.dev). It has three layers:

1. **Persistence + metric selection** — what a post is and what it exposes.
2. **Public series endpoint** — the unauthenticated, data-driven privacy boundary for
   high-resolution series.
3. **ActivityPub federation** — a per-user actor, WebFinger discovery, follower
   inbox/outbox, and delivery of the post's lifecycle (create / update / delete).

## Feed posts

A feed post has a **`kind`**:

- **`activity`** (the default) — references one of the user's activities and shares a
  bounded metric selection (below). This is the original and, so far, only end-to-end
  kind.
- **`article`** — a long-form post: a `title`, markdown prose, and inline **chart** and
  **correlation** blocks, each over a locked `[start, end]` window (blocks inherit an
  article-level default window unless they override it). Data re-resolves **live**
  against the locked window — no data snapshot. A **chart block** draws one metric; a
  **correlation block** pairs a `trigger` and an `outcome` selector (the exploratory
  correlation engine's dimensions, with an optional `lag_days`) and renders as a scatter
  with the Pearson/Spearman coefficients and n. Modelled as a post kind on the same
  storage, so an article reuses the whole feed (visibility, federation, timeline,
  permalinks). The ordered blocks live in an `article` JSONB column. Authored via
  `POST /feed/articles` / `PATCH /feed/articles/:postId` (and the `create_article` /
  `update_article` MCP tools), or in the web app's article composer; prose renders
  through the shared markdown sanitiser and each windowed block resolves its data live
  over the locked window. An article **federates as a `Note`** (title in `name`, prose
  HTML in `content`, and a rendered PNG per chart/correlation block attached) so followers
  on Mastodon see the prose and images inline. (A `Note`, not an AS2 `Article`: Mastodon
  treats `Article` as a converted type and discards its `content`, rendering only a title
  and link.) The prose is sanitised through an allowlist wide enough for a QS write-up
  (GFM tables, images, `hr`, headings); note that **Mastodon's own inbound sanitiser then
  strips tables/images/`hr`** from a remote status, so a results table degrades to
  run-together cell text there — the charts still arrive as image attachments, and
  non-Mastodon / Aurboda-peer renderers keep the full formatting. Because an article
  federates as an ordinary `Note`, an Aurboda peer's existing inbound timeline ingestion
  (see [Home timeline](#home-timeline-inbound)) already stores it like any other post —
  sanitised prose + image attachments — with no article-specific ingest code. On top of
  that, a following Aurboda instance's [structured-enrichment
  fetch](#native-charts-from-aurboda-peers-structured-enrichment) resolves an article to
  its native `FeedStructuredArticle` payload (title + every block re-resolved live —
  bucketed chart samples, or the computed correlation + scatter points), so an Aurboda
  follower's timeline renders the full inline article — real interactive charts and
  scatters — instead of just the flattened prose and attached PNGs a Mastodon follower
  sees. **Export** — `GET /feed/articles/:postId/export` (and the `export_article_markdown`
  MCP tool) renders an article as paste-ready markdown — the title, the prose blocks
  verbatim, and one image link per chart/correlation block (the block-image endpoint
  below) — for pasting into a text-only destination like r/QuantifiedSelf, where the
  author adds their own write-up around the linked charts. A block whose image would 404
  (a chart window with no samples, a correlation with n < 3) gets an italic "not enough
  data in this window" note instead of a dead image link (#974). A **`followers`-only** article
  can't be exported (400): the export targets a public paste, but its chart images require
  the post's private capability token, which must never land in publicly-pasted text —
  make the article public or unlisted first.

- **`challenge`** — an **invitation to a challenge** (#994): the author's personal note
  (markdown, rendered through the same sanitiser as article prose) plus the challenge's
  canonical public URL — one of the user's own challenges (its share URL) or a challenge
  they joined (the host's URL), resolved **server-side** so a post can never carry a
  spoofed link. The payload (name + URL, and the host identity for a joined challenge)
  lives in a nullable `challenge` JSONB column; no join token and no standings data are
  embedded — anyone following the link goes through the normal public page / join-by-URL
  flow. Federates as a `Note` (Mastodon renders the link with the challenge page's
  existing OG preview card). Shared via `POST /feed/challenges` (and the
  `share_challenge` MCP tool) or the **Share to feed** button on the challenges page.
  The host instance's automatic **completion post** (see
  [challenges.md](challenges.md#completion--winner-announcement)) is the same kind
  with a `result` payload in the `challenge` column — the final podium (ranks, names,
  identities, totals) and member count — rendered natively as a podium on the card and
  federated with a "has finished" heading, the winner as a Mastodon-style mention link,
  and a `Mention` tag (plus `cc` + inbox delivery) per winner.

An **`activity`** feed post references one of the user's activities and records the
explicit metric selection that bounds what is shared:

- **`included_metrics`** — the scalar summaries the user opted to share (e.g.
  `duration`, `distance`, `heart_rate_avg`, `heart_rate_max`, `hr_zone_minutes`,
  `calories`, `stress_avg`). This is the single source of truth for the human-readable
  summary and the machine-readable scalars a remote Aurboda instance reads.
- **`series_metrics`** — a **separate, explicit opt-in** for high-resolution continuous
  series (e.g. per-5-second heart rate or stress). A per-sample trace is far more
  revealing than an average, so series are **off unless deliberately chosen**, even for
  a metric whose scalar summary is shared.
- **`visibility`** — `public`, `unlisted`, or `followers`. The `public`/`unlisted`
  pair is the shared `ShareVisibility` vocabulary (see [Sharing](./sharing.md)) that
  [challenges](./challenges.md) and shared dashboards also use; the feed extends it
  with the `followers` audience.
- **`include_chart` / `include_map`** — attach a rendered heart-rate chart and/or
  GPS route-map image to the post (see [Images](#images)).
- **`message`** — an optional personal message (plain text, linebreaks preserved)
  shown at the top of the post. The share dialog prefills it from the activity's
  description (its user-typed comments) — always shown editable before sharing, so
  private context can be redacted; an empty field shares no text. Cleared on edit
  by saving an emptied field.

Defaults are privacy-conservative: sharing an activity with no explicit selection
shares no scalars and, crucially, **no series**.

## ActivityPub federation

Each user is a single ActivityPub **actor** (a `Person`) at:

```
<public-base>/users/<username>          e.g. https://aurboda.net/users/fiddur
```

The `/users/` prefix is dedicated to federation and never collides with the human-facing
`/u/<username>` profile/dashboard pages. The actor publishes an RSA public key (used to
verify HTTP Signatures) held in the per-user `feed_actor` table.

**Discovery (WebFinger).** The actor is resolvable by handle:

```
acct:<username>@<host>                  e.g. @fiddur@aurboda.net
```

so anyone on Mastodon (or any fediverse server) can search for `@fiddur@aurboda.net`,
open the profile, and **Follow**. A `Follow` arrives at the actor's inbox; Aurboda
verifies its HTTP Signature and records the follower (`feed_follower`). By default it
replies immediately with an `Accept` so the remote server marks the relationship
established; if the user has enabled **manual approval** the follow is held as a pending
request instead (see [Follower approval](#follower-approval-inbound)). `Undo{Follow}`
removes the follower.

Canonical absolute URLs (actor id, inbox/outbox, object ids, WebFinger self-link) are
always built from the configured public base (`WEB_HOST`) as **https**, so they stay
correct behind the TLS-terminating proxy (which forwards over loopback http).

### Publishing & lifecycle delivery

Sharing, editing, or unsharing a post federates the matching activity to the user's
followers (best-effort, fire-and-forget; delivery is synchronous — a durable retry queue
is a later slice):

| Action  | Federated activity  | Effect on followers                       |
| ------- | ------------------- | ----------------------------------------- |
| Share   | `Create{Note}`      | The post appears in their timeline        |
| Edit    | `Update{Note}`      | Their stored copy is replaced             |
| Unshare | `Delete{Tombstone}` | The post is retracted from their timeline |

The `Note` is Mastodon-compatible: a structured HTML `content` — the bold title
headline, the author's personal message (if any), a line saying when the **activity**
happened (rendered in the author's device timezone, since AS2 `published` stays the
share time for timeline ordering), and the shared scalar summaries one per line —
plus a `name` headline, addressed per the post's visibility
(`public` → AS2 Public + followers; `unlisted` → followers + Public in `cc`; `followers`
→ followers only).

**QuantPub extension (#896).** An activity share's `Note` is dual-typed
`["Note", "quant:Exercise"]` and carries the typed [QuantPub](../fep/quantpub.md)
extension in-band: the AS2 window as native `startTime`/`endTime`, plus
`quant:activityType`, `quant:metrics` (the shared scalar summaries as
`key`/`value`/`unit` objects), `quant:series` links into the public series endpoint
(only for `public`/`unlisted` posts with a bounded window), and
`quant:structuredUrl` pointing at the structured post endpoint (carrying the
capability token on `followers`-only deliveries). The `quant:` term definitions are
embedded as an inline `@context` entry on every delivered/served document
(`quant:metrics`/`quant:series` are JSON literals, `"@type": "@json"`), and the
canonical context document is served at `GET /ns/quantpub`
(`application/ld+json`); `GET /.well-known/quantpub` is the FEP §4 discovery
document. Fedify's typed vocabulary drops unknown properties, so the extension is
spliced into the serialized JSON-LD of the outermost delivered/served object
(`services/activitypub/quant-extension.ts`); plain fediverse clients ignore the
extra type and terms and render the Note as before.

**Merged activities.** A post stores only `activity_id` (the plain anchor uuid). When that
activity is part of a **merge group** (overlapping cross-source records, shown in the
detail view as `merged:<anchor>`), the delivered/served/listed scalars and the rendered
chart/route images are resolved over the **full merged span** — the same window the detail
view and share dialog present — not the anchor sub-activity's narrower slice. The window is
resolved at query time (via the same `resolveActivityWindow` the `merged:` detail view
uses), so nothing denormalised is persisted on the post.

### Outbox & object serving

- **Outbox** (`/users/<username>/outbox`) — a **cursor-paginated** `OrderedCollection`
  of the user's `public` + `unlisted` posts as `Create{Note}` activities, newest-first, so
  the actor's profile shows their posts — both an activity share and an article are a
  `Create{Note}`. The root returns `totalItems` + `first`/`last` page links; each page
  (`?cursor=<offset>`) serves up to a fixed page size with a `next` link. `followers`-only
  posts are never listed.
- **Object** (`/users/<username>/feed/<postId>`) — the post's `Note`, served at its
  canonical id so a remote server can dereference it (an article's Note carries its prose
  in `content`; an activity's carries the shared-scalars summary). Only `public`/`unlisted`
  resolve; `followers`-only and unknown ids return 404. Once a `public`/`unlisted` post is
  **deleted**, that id returns **`410 Gone` with an AS2 `Tombstone`** (recorded in
  `feed_tombstone`) so a dereferencing server learns the object is _permanently_ gone
  rather than transiently missing. A `followers`-only id is never tombstoned — it never
  resolved publicly, so a 410 would leak that a post once existed.

The `Note` carries `published` = the post's share time (its `created_at`), so remote
servers order and timestamp it correctly instead of stamping it at receipt.

The object we deliver, list in the outbox, and serve at that id are all built from one
place, so they can't drift.

### Following other actors (inbound)

The feed also runs the **inbound** direction: a user can follow other fediverse actors
(remote _or_ another local Aurboda user). Following `@alice@mastodon.social`:

1. resolves the target actor (WebFinger + actor fetch) to its inbox + presentation,
2. records a **pending** follow in `feed_following`, then
3. sends a signed `Follow` from the user's actor to the followee's inbox.

Following **yourself** is rejected (it would deliver a `Follow` to your own inbox and echo your
posts into your timeline). Resolving the actor's avatar is bounded by a short timeout, so a slow
icon host can't hang the (synchronous) follow. When a follow fails, the web panel surfaces the
server's specific reason (e.g. an unresolvable handle) rather than a generic message.

When the followee's server answers with an `Accept`, the inbox marks the follow
**accepted**; a `Reject` drops it. Unfollowing sends an `Undo{Follow}` to the cached inbox
and removes the row. Local follows use the exact same path (delivered to the local inbox
over loopback), so there is no special-casing. Delivery is best-effort/synchronous, matching
the rest of the feed — a failed `Follow` POST leaves the pending row so the user can retry.

**Inbound `Update{Person}`** (#1057) — the mirror of the `Update{Person}` we deliver when our
own profile changes. A remote actor renaming themselves (or changing their avatar) sends one to
everyone who follows them, and nothing else ever re-reads a remote actor, so without it our
cached handle / display name / avatar stay stale indefinitely. An `Update` whose object id
**is** its actor id is the actor editing themselves — that equality is the same-actor rule, so
an `Update{Person}` describing anybody else is ignored — and the new presentation is then
fetched from that (signature-verified) actor id, never read off the embedded `Person`. Every
cached copy is refreshed together: the `feed_follower` and `feed_following` rows, the author
snapshot on their timeline entries, the "🔄 X boosted" line on cards they boosted, and their
reactions on the owner's own posts. Presentation only — the cached inbox URIs never move.

Each follow carries a **`notify_on_post`** flag (default `true`), toggled per-actor with the
bell in the web Following panel (or the `set_following_notify` MCP tool / `PATCH
/feed/following/:id`). It controls whether the Android app raises a notification for that
actor's new home-timeline posts; muting is preserved across a re-follow.

**Replies and mentions** (#1060): ingest stores a received Note's `inReplyTo` id as
`timeline_entry.in_reply_to_uri` and whether it carries a `Mention` of the timeline owner as
`mentions_me`. The timeline exposes both (plus `in_reply_to_mine`, true when the reply target
is one of the reader's own posts) and filters by the **`timeline_show_replies`** user setting
(toggle on the Feed page and in Settings): off (the default) hides followed actors' replies
to *other* people — posts the reader is **involved** in (replies to their own posts, Mentions
of them) always show, marked on the card. The inbox admits an involvement Note **from any
actor**, not only followees (a stranger's reply to your post, or a post mentioning you, is
the Mastodon-style interaction; the author snapshot comes from the signature-verified sender)
— everything else from non-followees is still dropped. The Android notifier follows the same
rule: top-level posts notify per the per-follow bell, involvement notifies regardless of who
wrote it. Entries also expose **`received_at`** (when this instance stored the post) — the
notifier's high-water mark, since `published_at` can arrive out of order after federation
retries. Entries ingested before this shipped are **lazily backfilled**: each timeline read
re-fetches a few unchecked objects (SSRF-guarded) and stamps their reply/Mention state.

**Expanding a thread**: `GET /feed/timeline/:id/replies` (and the MCP `get_timeline_replies`
tool) fetches a live, bounded snapshot of the post's remote `replies` collection — at most 20
replies from at most 15 SSRF-guarded requests within a 12s budget, HTML sanitised
server-side; `partial: true` marks a thread longer than the budget. Nothing is stored — the
web's "Show replies" button on each timeline card renders it on demand.

The snapshot also carries **`fetched`** (#1065): `false` means the origin's thread could not
be read at all (the post never loaded, or it declared a `replies` collection we couldn't
resolve). An empty list is then *unknown*, not *empty*, and the web says "Couldn't read the
thread from `<host>`." instead of "No replies found" — a failed fetch that reads as an empty
thread is a lie about someone else's conversation.

The reader's **own replies** to the same object are merged into the snapshot (marked
`mine: true`, matched on the reply's `object_uri`). The origin need not list our Note yet —
Mastodon adds it only once it has processed the `Create`, and a followers-only thread may
never expose it — and a thread that hides its own reader's reply reads as if it were never
sent. A reply the origin *does* list is kept as the origin's copy (that is what everyone else
sees) and only flagged `mine`; one it doesn't is appended in `published_at` order.

**Marker composition** (#1066): the card's markers compose rather than exclude each other —
`↩ replied to you` when the post answers one of yours, else `↩ a reply`, **plus** `@ mentioned
you` whenever it also carries a Mention of you. (A reply to your own post already implies the
mention, so that pair collapses to one marker.)

The actor advertises a **following collection** (`/users/<username>/following`) listing only
_accepted_ follows (a pending follow isn't a confirmed relationship yet). The followee's
inbox URIs are internal delivery details and are never exposed on the owner-facing API.

### Follower approval (inbound)

By default an account is **open**: an inbound `Follow` is auto-accepted and answered with an
`Accept` immediately. A user can instead switch on **manual approval** (the
`manually_approve_followers` setting) — a "locked account", advertised to the fediverse via
`manuallyApprovesFollowers: true` on the actor document, so Mastodon shows a follow _request_
and holds it pending.

With manual approval on, an inbound `Follow`:

1. is recorded in `feed_follower` as **pending** (`accepted = false`) — caching the
   follower's handle / display name / avatar (so the approval UI can show _who_ is asking)
   and the id of their `Follow` activity, but **no** `Accept` is sent yet;
2. surfaces as a request the owner can **approve** or **reject**.

**Approving** flips the row to accepted and sends the deferred `Accept` — echoing the
original `Follow` id so the follower's server matches it to its pending request.
**Rejecting** (or later **removing** an accepted follower) sends a `Reject` and drops the
row. Both are best-effort/synchronous like the rest of the feed. A re-delivered `Follow`
from an already-accepted follower never demotes them back to pending.

Only **accepted** followers appear in the followers collection + count and receive
`followers`-only posts — a pending request is not yet a follower. Switching the setting off
does not retroactively accept the already-pending requests; new follows simply auto-accept
again. The follower's inbox URIs are internal and never exposed on the owner-facing API.

### Home timeline (inbound)

Posts from followed actors arrive at the user's inbox and are stored as a **home timeline**.
When a `Create` or `Update` for a `Note` is delivered, the inbox:

1. confirms the sender is an **accepted** followee (`feed_following`) — activities from
   anyone else are ignored, so an unsolicited `Create` can't inject into the timeline,
2. **sanitises** the note's HTML content server-side (`sanitize-html`, a strict tag/attribute
   allowlist) — remote content is untrusted, so this is the XSS boundary, then
3. captures the note's **image attachments** (rendered chart / route map, or a Mastodon
   photo) — only inline `http(s)` images survive, then
4. upserts a `timeline_entry` (keyed by the note's `object_uri`, so an `Update` or a
   redelivery replaces in place rather than duplicating).

A card with **no** native structured payload (a Mastodon post) renders the sanitised HTML
plus the delivered **image attachment(s)**, the way Mastodon shows them. A card **with** one
(an Aurboda peer's post, see below) renders natively instead and suppresses the redundant
flattened HTML: an activity share shows its title, the author's message, the activity's
date, a stat grid, **one combined multi-metric chart** with per-metric toggle buttons, and a
**time-synced interactive map** that marks the position at the hovered chart time — the same
components the activity detail view uses (#1011) — while an article shows the full inline
article. Each delivered image is kept unless its native counterpart actually draws: the
chart PNG renders heart rate only, so it is skipped exactly when a drawable *heart-rate*
series is present, and the route PNG is skipped when the payload carries a drawable route.
A `followers`-only Aurboda share federates
its native payload to accepted followers too (via the capability token, see below), so a
follower gets the interactive chart rather than just the flat image; a Mastodon photo post
shows its photos.

A `Delete` removes the matching entry; unfollowing removes all of that actor's entries. The
timeline is read back **newest-first**, keyset-paginated on `(published_at, id)` behind an
opaque `next_cursor` — the same cursor style as the outbox — via `GET /feed/timeline` and the
`list_timeline` MCP tool. Because the content was sanitised on ingest, the web client renders
it directly.

Two ingest guards keep the timeline honest given `object_uri` is a **globally-unique** upsert
key: the note's id must be on the **sender's host** *and* it must declare `attributedTo` naming
the sender (so an accepted followee can't overwrite another actor's post by colliding its id —
a note with no `attributedTo` at all is refused too, since every real implementation sets it);
and `published_at` is **clamped to "not in the future"** on ingest (it's the sort key, so a
far-future timestamp would otherwise pin a post to the top).

**Backfill on follow.** So the timeline isn't empty until a new followee next posts, accepting
a follow triggers a one-off **backfill**: the followee's recent **public** posts are fetched
from their ActivityPub **outbox** and ingested through the exact same path as live delivery
(same sanitisation, image capture, structured enrichment, and `object_uri` upsert — so a
backfilled post that later arrives live just updates in place). It's driven off the `Accept`,
so it covers **remote** followees (on their server's Accept) and **local** ones alike (a local
follow auto-accepts through the same handler). Only the **outbox** is read, so `followers`-only
and older private posts are never backfilled — exactly what a non-follower could already see.
Backfill is **best-effort and bounded**: fire-and-forget (a slow or unreachable outbox never
blocks the follow), capped at the latest ~20 posts, and time-boxed. Backfilled posts are
historical, so they don't trigger the live **"N new posts"** pill — they simply appear in the
timeline on the next load, in their published order.

### Likes and boosts

Two Mastodon-style interactions, both over open ActivityPub vocabulary and both directions:
a **like** ⭐ is an AS2 `Like` (Mastodon's "favourite"), a **boost** 🔄 an AS2 `Announce`
("reblog"); each is retracted with an `Undo` of the same activity.

**Outbound** (the user taps ⭐ / 🔄 on a home-timeline card). The local `feed_reaction` row is
written first and is the source of both the card's state and the **activity id** we deliver
(`/users/<user>/likes/<id>`, `/users/<user>/announces/<id>`, `#undo` appended for the
retraction) — so an `Undo` always references exactly the activity that was sent. Those ids are
never dereferenced by Mastodon, so a GET on one may 404. Addressing follows Mastodon:

- a `Like` carries no `to`/`cc` and is delivered to the **post author's inbox only**;
- an `Announce` is `to: Public`, `cc: [followers, author]` and is delivered to **followers and
  the author as two independent sends**, so one dead inbox can't cancel the other.

The author's inbox comes from the cached `feed_following` row when we follow them (no network);
otherwise a bounded actor lookup, and a reaction we can't address fails with `502` rather than
storing a row the card would lie about. Delivery itself is **best-effort** (like `Follow`): a
failed POST is logged and the local state stands. Both toggles are **idempotent** — a second
like is a local no-op with no second delivery, and un-reacting something you never reacted to
changes nothing. Reacting to a **boost card** targets the *original* post, not the `Announce`.

**Inbound.** A `Like`/`Announce` of one of **our own** posts is recorded in
`feed_post_reaction` with a best-effort snapshot of the sender (handle / name / avatar), so the
owner can see who reacted; it is open to any actor (Mastodon requires no follow to favourite),
but strictly scoped to a post that is ours and still exists. That snapshot is **fetched from
the sender's actor id** (see the rule below), so an unresolvable actor leaves a countable but
anonymous reaction rather than an unverified byline. An `Undo` retracts it, scoped to the
undoing actor; when the `Undo`'s inner object doesn't resolve, the remote activity's own id is
matched instead.

An `Announce` **by an accepted followee of a third party's post** becomes a **boost card** in
the home timeline. A boost is its own row: `object_uri` is the *`Announce` activity id* (so two
followees boosting one post give two cards, and a boost never collides with the original's own
entry), `boost_of_uri` is the announced Note's id, `boosted_by_*` the followee, and
`published_at` is the boost time — so the card sorts where Mastodon puts it. Everything else
(author, content, images, structured payload) describes the **original** post, which is what
renders, under a "🔄 X boosted" line. Guards: only an **accepted** followee can boost into the
timeline; the announced object must resolve to a `Note` **on the same host as the announced
id** and declare `attributedTo` (whose host must match the Note's, as for any ingest); and a
post that is **already in the timeline directly** gets no boost card (Mastodon likewise hides a
reblog of a post you already have).

A boost card tracks the post it shows: the author's `Update{Note}` refreshes the **boost cards
of that Note** as well as the direct entry (the card is keyed on the `Announce` id, so the
ingest upsert alone would leave it showing pre-edit content), while its `published_at` stays at
boost time so it doesn't jump on an edit. And a boost is never treated as a *reply*, even when
the boosted Note is one: it stays visible with `timeline_show_replies` off (Mastodon shows
reblogs of replies), and it is left out of an own post's comment list + `reply_count`, which
would otherwise show the same comment twice under someone else's byline.

**An object embedded in an activity is never used.** The announced `Note`, its author, and
every actor whose name we store are always **dereferenced from their own ids**. This is the
security of the whole feature, not an optimisation: an AS2 activity may inline its object, and
a library will hand that inlined copy back without fetching anything — so a followee could
deliver an `Announce` carrying a `Note` with any `id` and an `attributedTo` `Person` with any
`preferredUsername` they chose, and every host/attribution check would be satisfied by data
they wrote, storing forged content under a real person's byline. Fetching by id makes the
claimed origin server the only thing that can describe its own posts and people (and the
lookup refuses a document whose `@id` is cross-origin to the URL it came from). Mastodon sends
a bare id for a boost anyway, so this is also the ordinary path.

The rule covers **every inbound path that writes a byline** (#1103), each choosing what an
unreadable actor document means: an inbound `Like`/`Announce` still records a countable but
anonymous reaction; an inbound `Follow` still records the follow (the relationship is real)
with unknown display fields, while its inbox — delivery addressing, not presentation — comes
from the signature-verified sender as before; a **stranger's** reply/mention Note is dropped
outright, since showing who replied is the entire point of admitting it; a boosted post's
author, likewise, yields no card.

`Undo{Announce}` removes the card, scoped to the booster; an author's `Delete` removes their
post *and* every boost of it; unfollowing removes that actor's own posts and their boosts, but
keeps other people's boosts of their posts (those are in the timeline on the booster's
account).

A `followers`-only post can't be boosted meaningfully — the `Announce` is public, but the
object stays unreadable to anyone who doesn't already follow the author, so their servers show
nothing.

### Replies (comments)

The third Mastodon-style interaction, also over open vocabulary. Replying 🗨 to a
home-timeline card publishes a **feed post of kind `reply`** — replies are not a separate
entity, so they reuse the whole feed machinery (visibility, delivery, editing, tombstoning,
permalinks) rather than a parallel one.

**Outbound.** `POST /feed/timeline/:id/reply` (MCP `reply_to_timeline_post`) takes
`{ message, visibility }` and resolves the target itself from the addressed timeline entry:
the object is `boost_of_uri ?? object_uri` (replying to a **boost card** answers the *original*
post) and the author is the entry's `actor_uri` / `handle`. Nothing about the target is
client-supplied, so a reply can never claim to answer a post the reader never received. The
author's inbox resolves exactly as for a like — cached `feed_following` row, else a bounded
actor lookup — and a reply we can't address fails with `502` **before** the row is written,
so no post is left claiming to answer someone who was never told.

`visibility` defaults to **`unlisted`**: Mastodon's convention is that a reply belongs to its
thread rather than on public timelines. The author can still choose `public` or `followers`.

The federated object is a `Note` at the post's canonical id
(`/users/<user>/feed/<postId>`) with:

- `inReplyTo` — the answered object's id;
- `content` — the author as a leading mention paragraph
  (`<span class="h-card"><a href="…" class="u-url mention">@user@host</a></span>`) followed by
  the reply markdown rendered through the shared outbound sanitiser (the same `renderProse`
  boundary as article prose and challenge notes);
- `tag` — a `Mention` of the answered author, named by the `@user@host` snapshot taken at reply
  time (derived from the actor URI when the entry never carried one);
- `to`/`cc` — the visibility table, **plus the answered author in `cc`** so their server accepts
  the reply even though they don't follow us.

`Create`/`Update`/`Delete` wrap it exactly like every other post kind (`#create`,
`#update-<epoch>`, `#delete` ids) and all three are fanned out to **followers and the answered
author as two independent sends** — the same shape the challenge completion post uses, so one
dead follower inbox can't cancel the notification that exists precisely for someone who
doesn't follow us. The author actor is dereferenced from its id (`lookupObject`), never read
off anything inline.

Replies appear in the **outbox** like any post, but are **excluded from the public-profile
post listing** (`GET /public/:username/posts`) — Mastodon's own default profile tab hides
replies, and a bare comment lifted out of its thread reads as noise on a profile.

**Own-post comments (inbound).** Nothing new is ingested: a reply to one of the owner's still
existing posts is already admitted to the timeline from **any** actor (#1060, above), so the
comments under a post are simply the `timeline_entry` rows whose `in_reply_to_uri` is that
post's object id. `GET /feed/:postId/replies` (MCP `get_feed_post_replies`) returns them
oldest-first as full `TimelineEntry`s — carrying the reader's own like/boost state and
repliable in turn — with **no network fetch at all**. The owner's feed listing carries a
`reply_count` per post from one batched count query per page (like the reaction counts beside
it), so the web shows a `🗨 n` chip that expands the comments in place.

**Web.** Each timeline card's action row gains a 🗨 button opening an inline composer
(textarea capped at `feedPostMessageMaxLength`, a compact visibility selector defaulting to
`unlisted`, Post / Cancel). Posting closes the composer, refetches an open thread snapshot, and
leaves a "Reply posted ✓" note. The same action row serves the comment cards under an own post,
so a comment can be favourited, boosted or replied to without leaving the post. A `reply` post
on the owner's own feed renders with a `↩ replying to <handle>` line (linked to the author) and
the message through the shared markdown renderer.

### Native charts from Aurboda peers (structured enrichment)

A delivered `Note` carries the QuantPub scalar summary in-band (see above), but not the
high-resolution series data itself. To render a **native interactive chart** (with real,
hoverable values) instead of the plain HTML when a post comes from **another Aurboda
instance**, the receiver fetches the structured data out-of-band on ingest (the FEP §7
id-convention path — reliable even when a typed consumer drops the in-band extension):

1. **Emit.** Every instance serves `GET /public/:username/feed/:postId` — a native JSON payload
   (`FeedStructuredPost`: a discriminated union on `kind`). An **activity** post resolves to
   `FeedStructuredActivity` (activity type/window, typed scalar `metrics`, inline
   high-resolution `series` samples, and — only when the post attaches the route map
   (`include_map`) — a downsampled GPS `route` of timestamped points, capped at 500, from the
   same locations the route image draws), reusing the exact same scalar resolution as delivery
   and the same data-scoped series resolution as the [public series
   endpoint](#public-series-endpoint-the-privacy-boundary). An **article** post resolves to
   `FeedStructuredArticle` (the title and every block, resolved in the same order as the
   article: a prose block's raw markdown verbatim; a chart block's bucketed samples over its
   locked window, bucketed the same way as its block image; a correlation block's computed
   Pearson/Spearman/n, the present-vs-absent group comparison, and the aligned scatter points —
   the same `getContinuousCorrelation` call the block image uses). Either way a peer can never
   read more than the author shared/published. `public`/`unlisted` posts resolve
   unconditionally; a `followers`-only post resolves only with a matching `?token=<image_token>`
   — the **same capability token** that authorizes its followers-only images (below), so the
   structured payload and the images share one authorization boundary.
2. **Detect + fetch.** On ingesting a `Create`/`Update`, if the note's id matches Aurboda's own
   object path (`/users/{user}/feed/{postId}` — a Mastodon status id never does, so no needless
   request is made), the receiver discovers the peer via `/.well-known/aurboda` and fetches its
   structured endpoint — the same path for an activity share or an article, since both federate
   as a `Note` and the object id doesn't distinguish them. For a `followers`-only post it lifts
   the capability token from the delivered image URL (the `?token=` embedded only in the
   follower's `Note`) and forwards it, so an accepted follower fetches the native payload while a
   public guess still 404s. A post whose origin is **this instance itself** (a local-to-local
   follow) skips discovery and HTTP entirely and resolves **in-process** through the same
   `resolveStructuredPost` the endpoint serves — fetching our own public origin would hairpin
   through the reverse proxy and, from inside the container, typically resolve to a private
   address the SSRF guard rightly refuses (#996). Remote fetches are **SSRF-guarded**
   (`safe-fetch`: public hosts only, no redirects, size + time bounded) and time-boxed; the
   origin is the accepted followee's own host. Any failure (non-Aurboda host, 404, malformed,
   timeout) still resolves to "no payload" — the post shows with its HTML — but is **logged**,
   so a broken enrichment path is diagnosable instead of looking identical to a Mastodon post
   (#996).
3. **Store + render.** The payload is stored on `timeline_entry.structured` (JSONB, NULL for
   non-Aurboda posts; a redelivery that can't re-fetch keeps the last-known value). The web
   timeline card renders, per `structured.kind`: for an **activity** post the native
   activity card — title, personal message, the activity's date, a Strava-style **stat
   grid** from the typed scalars, one **combined multi-metric chart** (per-metric toggles,
   crosshair tooltip) over the shared series, and a **time-synced interactive map** over the
   shared route (the hovered chart time marks the position, exactly like the activity detail
   view) — or the full inline article — title, prose, per-block chart/scatter — for
   an **article** post (mirroring the author's own live `ArticleContent` render, but built from
   the embedded payload rather than a live fetch, since a receiving peer has no credentials to
   call the author's authenticated endpoints).

Enrichment is strictly best-effort and additive: it never blocks or fails basic ingest, an
activity's series that weren't shared (the opt-in) simply produce no chart, and an article's
chart/correlation block with too little data renders the same "not enough data" fallback the
author's own live render shows.

**Lazy retro-enrichment (#996).** Entries ingested before enrichment shipped — or whose
ingest-time enrichment failed transiently — would otherwise keep `structured = NULL` forever.
Reading the timeline (REST `GET /feed/timeline` or the `list_timeline` MCP tool) kicks a
fire-and-forget pass that gives a small batch (3, newest first) of such Aurboda-shaped entries
one more attempt through the same enricher. A **definitive** outcome (payload stored, or a
gone/unauthorized/malformed response) stamps `enrich_attempted_at` so the entry is never
retried; a **transient** failure (network error, timeout) leaves it unstamped for a later
read — up to `MAX_TRANSIENT_ATTEMPTS` (3): the third transient failure stamps the entry
too, so a permanently unreachable peer can't hold the head of the newest-first queue
(#1021). At most one pass runs per user at a time, and a partial index keeps the drained-backlog
case free. An `Update` redelivery still re-enriches through the normal ingest path. The read
itself is never delayed; entries that gain a payload render natively on the next load.

### Live updates

New posts appear **without a refresh**. When a genuinely new `timeline_entry` is inserted, the
ingest path emits a Postgres `NOTIFY` ping on the user's DB (each user has one long-lived
connection, so the ping is received in-process). The web client holds an **SSE** stream open at
`GET /feed/timeline/stream`; each ping is forwarded as an empty `event: new` (no post content on
the wire — just "your timeline changed"). The client then refetches the newest page and shows a
**"N new posts"** pill; clicking it prepends the new posts.

The stream uses `fetch` (not `EventSource`) so the bearer token rides in the `Authorization`
header rather than the URL, and sends `X-Accel-Buffering: no` so nginx flushes each event
immediately. If the stream can't be opened or drops, the client **falls back to polling** the
same newest page every 30s — so the pill still works without a live connection. In-process
fan-out is handled by a single `TimelineHub` that keeps one `LISTEN` channel open per user
regardless of how many tabs are streaming.

### Images

A post can carry a rendered **heart-rate chart** (`include_chart`) and/or a **GPS
route map** (`include_map`) as AS2 `Image` attachments, so Mastodon shows them inline.
Both are rendered on demand (SVG → PNG) from the activity's data at public,
unauthenticated endpoints:

```
GET /api/public/:username/feed/:postId/chart.png
GET /api/public/:username/feed/:postId/chart.svg
GET /api/public/:username/feed/:postId/route.png
```

The chart is offered in two formats over the same series and window: the **PNG** is
what Mastodon and other peers attach, while **`chart.svg`** serves the same chart as
crisp, scalable `image/svg+xml` for **Aurboda-native** rendering (it stays sharp at
any size). Both share the same eligibility gate, capability-token model, and
`no-store` revocability.

An **article** renders one image per chart/correlation block for the same reason (so
Mastodon and export tools attach a raster of each block), at its own endpoints:

```
GET /api/public/:username/feed/:postId/blocks/:index/image.png
GET /api/public/:username/feed/:postId/blocks/:index/image.svg
```

Unlike an activity chart, a block has **no `include_chart` opt-in flag** — a chart or
correlation block can embed any metric over any window, so the post's **visibility** is
the whole authorization boundary (public/unlisted open; `followers`-only via the
`?token=` capability). The chart block renders the metric bucketed over the locked
window; the correlation block renders the scatter with its OLS line and coefficient
headline. It buckets in the author's **device timezone** (`device_timezone`, set by the
Android app) so a `1d` bucket splits on the author's calendar days like the web render;
for an author whose device timezone is unknown it falls back to UTC (the web render uses
the live browser timezone, so the two can differ by a day only in that case). Because an
article (unlike a shared activity) is editable **and** its locked window can later gain
backfilled data, the render cache keys on the post's `updated_at` **and** a coarse hourly
bucket, so an edit or new data serves a fresh image within ≤ 1h; a `null` (no-data) render
is remembered under the same key so a sparse public block can't re-run the render engine
on every hit. The AS2 `Image` attachment URL also carries `?v=<updated_at>` so a remote
media cache (which re-hosts the PNG at receipt) re-fetches after an edit.

A block image endpoint **404s** when the block is too sparse to draw (a chart with < 2
points, a correlation with n < 3) or has a zero-duration bucket. The article's `Note`
attaches one `Image` per chart/correlation block **unconditionally** (the attachment list
is built without a synchronous pre-render), so a sparse block ships an attachment URL
that resolves to 404 — a plain fediverse client just shows one fewer image. Note also
that **Mastodon caps a remote status at 4 media attachments** (`MEDIA_ATTACHMENTS_LIMIT`)
when processing an inbound `Create`, so an article with more than four chart/correlation
blocks shows only its first four images there (Aurboda peers, which fetch the native
payload, aren't capped).

An image is served when the matching flag was opted into. `public`/`unlisted` posts
serve their images unauthenticated. A `followers`-only post's image URLs instead carry
the post's **unguessable capability token** (`?token=<image_token>`), which is embedded
only in the `Note` delivered to followers; a request without a matching token 404s. This
is a deliberate capability-URL model (like the shared-dashboard slugs), chosen because
the fediverse fetches media **without** HTTP signatures — Mastodon's "authorized fetch"
signs ActivityPub object/actor requests, not media downloads — so a signed-request gate
wouldn't be exercised and followers would just see a broken image. The tradeoff is that a
leaked image URL grants access to that one rendered image (a chart or a route map,
not the underlying high-resolution series, which stays `followers`-excluded entirely).
Responses are `no-store`, so an unshare / cleared flag / a public→followers flip takes
effect immediately (the now-untoken'd public URL 404s). The route is drawn over an
**OpenStreetMap street basemap** (see below); **no privacy trimming** is applied (area
masking is a planned follow-up), so a route map reveals the precise area.

The chart image and the heart-rate **series** are the same data in two formats, so the
share dialog exposes them as **one control**: opting into the heart-rate series
(`series_metrics` ∋ `heart_rate`) also sets `include_chart`, so Aurboda followers get the
native interactive chart (from the series) and Mastodon/other peers get the rendered PNG.
The dialog derives `include_chart` from that one toggle rather than offering it separately
(the REST/MCP fields stay independent for programmatic callers). It only offers the
heart-rate control when the activity has heart-rate data, and the map toggle when it has an
actual GPS track.

**Route basemap.** The route map projects the GPS track into Web Mercator, fetches the
covering OpenStreetMap tiles, and composites them behind the track (with a white halo for
legibility) plus start/end markers. The required "© OpenStreetMap contributors"
attribution is baked into the image. OSM's tile usage policy is respected: a descriptive
`User-Agent`, and low volume — route renders are cached per post, so tiles are fetched at
most once per route until eviction. Tile fetching is best-effort with a short timeout; if
the tiles can't be fetched (e.g. offline) it falls back to a bare polyline on a dark
background.

## Public series endpoint (the privacy boundary)

High-resolution series are **never** embedded in a post. Instead each shared series is
exposed through a public, read-only endpoint:

```
GET /public/:username/series?metric=<key>&start=<iso>&end=<iso>&bucket=<5s|60s|…>
```

Like a shared-dashboard slug, it takes **no auth token** — so the scoping below is the
_entire_ privacy boundary, and it is **data-driven, not obscurity-based**. A request
resolves only when **all** of these hold:

1. some feed post shared **that exact metric as a series** (`series_metrics`) — sharing
   only the scalar summary never exposes the series;
2. that post is **`public` or `unlisted`** (a `followers`-only post has no public series);
3. the shared activity is **not soft-deleted** and has a bounded window (an `end_time`);
4. the activity's window **covers** the requested `[start, end]` range.

When it resolves, the effective range is **clamped** to the activity's window (the
caller's bounds can never widen it), the bucket granularity is **floored** server-side
(minimum 5s) to bound payloads, and only the requested metric's aggregated buckets are
returned — per-measurement timestamps are dropped. Anything else — an unshared metric,
a `followers`-only share, a window outside any shared activity — returns **404**.

Deleting a feed post, changing its visibility to `followers`, removing the metric from
`series_metrics`, or soft-deleting the activity all immediately stop the series from
resolving.

## Using it in the web app

- **Share** — an activity's detail page has a **Share to feed** button. It opens a dialog
  to write an optional personal message (prefilled from the activity's description /
  comments, fully editable), pick the summary metrics, optionally opt into full series,
  and choose the audience — with a **live preview** (#902) of the exact federated
  content (resolved server-side through the same code path as delivery, debounced) and
  which images would attach, so what leaves the instance is visible before Share. The **owner's own feed** renders each activity post with the
  **same native card component a subscribing Aurboda peer's timeline uses** — the owner-facing
  feed responses include the full structured payload (typed scalars + inline series + route,
  assembled by the same helper the public structured endpoint uses), so the author sees the
  interactive combined chart and time-synced map exactly as a follower would, and can verify
  what they shared. The listing is **keyset-paginated** (20 per page, "Load more" — the same
  cursor style as the home timeline), so the inline payload weight stays bounded per request
  however many posts exist (#1012). The **public profile** (`/u/:username`) attaches the same
  full structured payload per post (through the per-post LRU the structured endpoint shares,
  one fixed page of 20), so visitors see the identical native card. The MCP `list_feed` tool
  remains the one surface that omits `structured` (an intentional payload-weight divergence
  from `GET /feed`, not a capability gap: the underlying data is all reachable via the
  metric-query tools).
- **New article** — the **Feed** page has a **New article** button that opens the article
  composer: a title, an optional default time window, and an ordered list of **prose**
  (markdown), **chart** (a metric + optional per-block window + caption), and **correlation**
  (a trigger + outcome selector + optional lag/window/caption) blocks, plus the audience.
  Each chart draws its metric live over the locked window; each correlation draws a live
  scatter (with the coefficients) over its window.
- **Manage** — the **Feed** page (`/feed`, the 📣 item under the **Sharing** section in
  the sidebar) lists everything
  you've shared, with each post's audience and metrics. From there you can **Edit** a
  post — an activity share re-opens the share dialog (saving federates an `Update`); an
  article re-opens the article composer — or **Unshare** it (federates a `Delete`). An
  article also has an **Export markdown** button that fetches its paste-ready markdown
  export and offers a **Copy to clipboard** button for pasting into r/QuantifiedSelf or a
  similar text-only destination.
- **Follow** — the Feed page's **Following** panel lets you follow a fediverse actor by
  handle (`@user@host`) and see who you follow, with a **Pending** badge until the remote
  server accepts and an **Unfollow** button.
- **Followers** — the Feed page's **Followers** panel lists who follows you. If you've turned
  on **Manually approve new followers** (Settings → _Feed & Followers_), incoming follows show
  up here as **follow requests** with **Approve** / **Reject** buttons; accepted followers can
  be **Removed**. With approval off (the default), anyone can follow you automatically.
- **Home timeline** — below the Following panel, the Feed page shows your **Home timeline**:
  posts from the actors you follow, newest-first, as native cards with a **Load more** button
  to page further back. New posts arrive **live** (or via polling fallback) as a **"N new
  posts"** pill at the top; click it to reveal them.
- **Public profile** — a user's `/u/<username>` page shows their public feed (their
  `public`/`unlisted` posts, newest-first, as the same post card) alongside their shared
  dashboards and challenges. It's unauthenticated, so anyone — including a follower who saw
  a post in their timeline — can browse a person's public posts and info. A **local**
  author's name in the home timeline / Following / Followers lists links to their
  `/u/<username>` page; a remote (Mastodon &c.) author isn't linked (they have no page here).

## API

Owner-facing (authenticated, scoped to the caller):

| Method & path                      | Purpose                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /feed`                        | My feed posts, newest-first, keyset-paginated (`?cursor=` from the previous page's `next_cursor`); each post enriched with the shared activity's title/type, merged-span window, and full structured payload |
| `POST /feed/activities/:id/share`  | Publish an activity with a chosen metric selection                                                                      |
| `POST /feed/articles`              | Publish a long-form **article** (title + prose + inline chart/correlation blocks)                                       |
| `POST /feed/activities/:id/preview`| Live share **preview** (#902): the exact federated content + resolved metrics for a selection; creates nothing          |
| `POST /feed/challenges`            | Share a **challenge invitation** (personal note + canonical link); exactly one of `challenge_id`/`participation_id`     |
| `GET/POST /autoshare-rules` (+`/:id`, `/preview`) | [Auto-share rules](auto-share-rules.md): automatically publish matching settled activities (#903)         |
| `PATCH /feed/articles/:postId`     | Edit an article (title / blocks / default window / visibility)                                                          |
| `GET /feed/articles/:postId/export`| Export an article as paste-ready markdown (title + prose + one image link per block) for Reddit/text-only destinations  |
| `PATCH /feed/:postId`              | Edit an activity post's selection / visibility / attachments                                                            |
| `DELETE /feed/:postId`             | Unpublish any post (an activity post's public series stops resolving)                                                   |
| `GET /feed/following`              | List the actors I follow (accepted + pending)                                                                           |
| `POST /feed/following`             | Follow an actor by handle (`@user@host` or actor URL)                                                                   |
| `DELETE /feed/following/:id`       | Unfollow (sends `Undo{Follow}`)                                                                                         |
| `GET /feed/followers`              | List my followers; `?status=pending\|accepted\|all` (default `all`)                                                     |
| `POST /feed/followers/:id/approve` | Approve a pending follow request (sends the deferred `Accept`)                                                          |
| `DELETE /feed/followers/:id`       | Reject a request / remove a follower (sends `Reject`)                                                                   |
| `GET /feed/timeline`               | My home timeline (posts from followees), newest-first, `?cursor=` to page                                               |
| `GET /feed/timeline/stream`        | Server-Sent Events stream of live "new posts" pings (falls back to polling)                                             |
| `POST/DELETE /feed/timeline/:id/like`  | Favourite ⭐ / un-favourite a timeline post (`Like` / `Undo{Like}`); idempotent, returns the updated entry           |
| `POST/DELETE /feed/timeline/:id/boost` | Boost 🔄 / un-boost a timeline post (`Announce` / `Undo{Announce}`); idempotent, returns the updated entry           |
| `GET /feed/timeline/:id/replies`   | Bounded snapshot of a timeline post's thread (origin's `replies` + my own replies merged); `fetched`/`partial`          |
| `POST /feed/timeline/:id/reply`    | Reply 🗨 to a timeline post — publishes a `reply` post (`Create{Note inReplyTo}` + `Mention`); `visibility` defaults to `unlisted` |
| `GET /feed/:postId/reactions`      | Who favourited or boosted one of MY posts (newest first, max 100)                                                       |
| `GET /feed/:postId/replies`        | The comments received under one of MY posts (oldest first, max 100), as full timeline entries — no network fetch        |

Public / federation (unauthenticated):

| Method & path                                                | Purpose                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /public/:username/series`                               | Bucketed samples for a **shared** series within its window                                                 |
| `GET /public/:username/feed/:postId`                         | Native structured post (`FeedStructuredPost`: an activity's typed metrics + inline series, or an article's title + resolved blocks) for Aurboda-to-Aurboda enrichment |
| `GET /public/:username/feed/:postId/chart.png`               | Rendered HR chart (PNG) for an opted-in post (`?token=` for followers-only)                                |
| `GET /public/:username/feed/:postId/chart.svg`               | Same HR chart as crisp `image/svg+xml` for Aurboda-native rendering (`?token=` for followers-only)         |
| `GET /public/:username/feed/:postId/route.png`               | Rendered GPS route map for an opted-in post (`?token=` for followers-only)                                 |
| `GET /public/:username/feed/:postId/blocks/:index/image.png` | Rendered PNG of an article's chart/correlation block (visibility-gated; `?token=` for followers-only)      |
| `GET /public/:username/feed/:postId/blocks/:index/image.svg` | Same article block as crisp `image/svg+xml`                                                                |
| `GET /public/:username/posts`                                | A user's public/unlisted posts (newest-first, latest page) for their profile feed                          |
| `GET /.well-known/webfinger`                                 | Resolve `acct:<username>@<host>` → the actor                                                               |
| `GET /.well-known/quantpub`                                  | QuantPub discovery document (FEP §4): product, versions, `api_base`                                        |
| `GET /ns/quantpub`                                           | The published QuantPub JSON-LD `@context` document (`application/ld+json`)                                 |
| `GET /.well-known/nodeinfo`                                  | NodeInfo JRD pointing at the 2.1 document (#1047)                                                          |
| `GET /nodeinfo/2.1`                                          | NodeInfo 2.1: software `aurboda` + version, `activitypub` protocol (no usage stats — per-user DBs)         |
| `GET /users/:username`                                       | The actor document (`Person`); a browser (`Accept: text/html`) is 302-redirected to `/u/:username`         |
| `GET /users/:username/outbox`                                | Public + unlisted posts as `Create` activities                                                             |
| `GET /users/:username/followers`                             | The actor's followers collection                                                                           |
| `GET /users/:username/following`                             | The actor's following collection (accepted follows only)                                                   |
| `GET /users/:username/feed/:postId`                          | A single post's `Note` — an activity share or an article (or `410` Tombstone once deleted)                 |
| `POST /users/:username/inbox` (+ `/inbox`)                   | Inbound `Follow` / `Undo{Follow}` / `Accept` / `Reject` (HTTP-Signature verified)                          |

The actor's `icon` URL carries the avatar's upload time as a `?v=` version, and an avatar
upload/removal delivers an `Update{Person}` to accepted followers — remote servers (Mastodon
et al.) cache a copied avatar and re-download it only on one of those two signals, so without
them a changed avatar never propagates.

The owner-facing capability is also available over MCP as `list_feed`, `share_activity`,
`preview_activity_share`, `share_challenge`, `create_article`, `update_article`, `export_article_markdown`, `update_feed_post`,
`delete_feed_post`, `list_following`, `follow_actor`, `unfollow_actor`, `list_followers`,
`approve_follower`, `reject_follower`, `list_timeline`, `like_timeline_post`,
`unlike_timeline_post`, `boost_timeline_post`, `unboost_timeline_post`,
`get_timeline_replies`, `reply_to_timeline_post`, `get_feed_post_replies`, and
`list_feed_post_reactions` — all backed by the same services as
the REST routes (`create_article` / `update_article` ↔ `POST /feed/articles` / `PATCH
/feed/articles/:postId`; `export_article_markdown` ↔ `GET /feed/articles/:postId/export`), so an
article can be drafted conversationally by Claude via the same tools. Manual follower approval is
toggled with the `manually_approve_followers` user setting (`get_user_settings` /
`update_user_settings`).

## Storage

Feed posts live in the user's own database in the `feed_posts` table. A `kind` column
discriminates an `activity` post from an `article`, `challenge` or `reply` post; an article's
content (title + default window + ordered blocks) lives in a nullable `article` JSONB
column, a challenge share's link payload (name + canonical URL + optional host identity)
in a nullable `challenge` JSONB column, and in both cases the `activity_id`/metric
columns stay empty. A **reply** post likewise carries no activity or metrics: three nullable
columns hold what it answers — `in_reply_to_uri` (the AS2 object id), `in_reply_to_actor_uri`
(the `Mention` href) and `in_reply_to_handle` (the `@user@host` snapshot naming that mention,
taken at reply time like `timeline_entry.handle`) — with the reply text in `message`. All
three are resolved server-side from the timeline entry being replied to, never client-supplied.
A partial index on `(in_reply_to_uri, created_at)` backs the own-replies merge into a thread
snapshot. A nullable `message` column holds the author's
personal message (plain text; NULL when none was shared). `activity_id` is a
**soft reference** (no foreign key): activities are soft-deleted and the series lookup
re-checks `deleted_at` at query time, so a removed activity simply stops resolving rather
than cascading a delete. A GIN index over `series_metrics` backs the public series
endpoint's authorization check. Each post also holds an unguessable `image_token`
(defaulted at insert) that gates its `followers`-only image URLs. Deleting a
`public`/`unlisted` post hard-deletes its row
and, in the same statement, records its id in `feed_tombstone` so the object id can still
answer `410 Gone`. Followers live in `feed_follower` (keyed by the follower's `actor_uri`,
with a local `id` for the approve/reject API, the cached inbox + handle / display name /
avatar, the id of the `Follow` they sent — echoed in a deferred `Accept`/`Reject` — and an
`accepted` flag that is false while a request is pending); the actors this user **follows**
live in `feed_following` (keyed by a local `id`, with the followee's cached inbox + handle /
display name / avatar and an `accepted` flag); the actor's RSA keypair in `feed_actor`.
Posts received from followees are stored in `timeline_entry` (keyed by the remote note's
`object_uri` so an `Update`/redelivery replaces in place), holding the **already-sanitised**
content plus the author's cached handle / display name / avatar, indexed on
`(published_at DESC, id DESC)` for the keyset-paginated home timeline. A nullable
`structured` JSONB column carries the native Aurboda payload (`FeedStructuredPost`: an
activity's typed metrics + inline series, or an article's title + resolved blocks) fetched
during enrichment — NULL for non-Aurboda posts. On a
re-delivery whose enrichment failed, the upsert `COALESCE`s so the last-known `structured`
is preserved rather than wiped. A nullable `images` JSONB column holds the delivered
image attachments (`TimelineImage[]`: url + optional media type / alt / size), rendered as
the fallback when a post has no native structured chart. Four nullable columns
(`boost_of_uri`, `boosted_by_actor_uri`, `boosted_by_handle`, `boosted_by_display_name`) turn
a row into a **boost card** — see "Likes and boosts" above; they are NULL on a direct entry.
A partial index on `(in_reply_to_uri, published_at, id)` backs the **own-post comments**
listing and the batched per-page `reply_count`, so reading a feed page never scans the whole
timeline.

Reactions live in two tables, one per direction. `feed_reaction` holds the user's **own**
outbound likes/boosts: a `UNIQUE (kind, object_uri)` row per reacted-to post whose `id` mints
the delivered activity id (and its `#undo`), plus the post author's cached inbox so a
retraction needs no actor re-resolve — the uniqueness is what makes liking idempotent.
`feed_post_reaction` holds **inbound** reactions on the user's own posts, keyed
`(post_id, kind, actor_uri)` so a redelivery refreshes the presentation snapshot rather than
duplicating, with the remote activity's own id (`activity_uri`) so a bare-id `Undo` still
matches, and an index on `(post_id, created_at DESC)`. `post_id` is a **soft reference** like
`activity_id`, so `deleteFeedPost` drops the post's reactions in the same statement.

## Caveats & limitations

These are known and intentional for the current implementation:

- **Visibility downgrade doesn't retract from non-followers.** Narrowing a `public`
  post to `followers` federates an `Update` addressed only to followers; servers that
  showed it to non-followers keep their copy. This is an inherent ActivityPub limitation
  (Mastodon behaves the same) — there is no addressable "public" inbox to retract from.
- **The public series endpoint uses the anchor window for merged shares.** The delivered
  Note's scalar summary and the rendered images cover the full merged span, but
  `GET /public/:username/series` still authorizes only the shared activity's _own_ window
  (`findCoveringSharedSeriesWindow` joins on `activity_id`). The delivered Note's
  `quant:series` links are built over the merged span, so for a **merged** share with
  shared series those links can 404 until series authorization expands across a merge
  group (which needs the merge algorithm at query time — a planned follow-up); QuantPub
  consumers treat a failed series fetch as best-effort, so the post still renders.
- **Reactions are `Like`/`Announce` only.** There is no `EmojiReact` (Misskey/Akkoma's
  custom-emoji reactions), and likes/boosts are not listed in the actor's `outbox` or on the
  public profile — they are a private-to-the-owner record plus the delivered activity.
- **Remote cards carry no like/boost counts.** Mastodon does not push a post's totals to
  subscribers, so a home-timeline card shows only *your own* reaction state. Counts appear on
  the owner's own posts, from what was delivered to us.
- **Boosts are not backfilled on follow.** The on-follow backfill reads the followee's outbox
  for their own posts; their earlier boosts don't appear retroactively.
- **You can only reply to a post this instance holds.** A reply targets a home-timeline entry
  by its local id, so a reply that exists only inside a live thread snapshot fetched from a
  remote origin has nothing to address — reply to the card instead. Serving a `replies`
  collection on our own Notes (so other servers can walk our threads) is a follow-up.
- **No reply editing from the web.** The API supports it (`PATCH /feed/:postId` federates an
  `Update` to followers and the answered author), but the web card offers no editor — a reply
  is short enough to delete and repost.
- **Route maps have no privacy trimming.** The route is drawn over an OpenStreetMap
  basemap and shows the full track, so a public route map reveals the precise area
  (including start/end points, i.e. likely home/work); start-point and area masking are
  planned follow-ups. Only share a route publicly when that exposure is acceptable.

## Related

- [Sharing & public pages](./sharing.md) — the shared-dashboard foundation and the
  base-URL identity model this reuses.
- [Challenges](./challenges.md) — cross-instance federated competitions on the same
  `/u/:username` namespace.
- [QuantPub FEP draft](../fep/quantpub.md) — the vendor-neutral generalisation of
  this feed's federation pattern (vocabulary + out-of-band structured payloads),
  drafted for the FEP process so other QS tools can interoperate.
