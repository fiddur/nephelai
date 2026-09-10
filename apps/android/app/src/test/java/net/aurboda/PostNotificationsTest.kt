package net.aurboda

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PostNotificationsTest {

    private fun entry(
        objectUri: String,
        actorUri: String,
        published: String,
        receivedAt: String? = null,
        inReplyToUri: String? = null,
        inReplyToMine: Boolean = false,
        mentionsMe: Boolean = false,
        boostedBy: BoostedBy? = null,
    ) =
        TimelineEntry(
            objectUri = objectUri,
            actorUri = actorUri,
            publishedAt = published,
            receivedAt = receivedAt,
            inReplyToUri = inReplyToUri,
            inReplyToMine = inReplyToMine,
            mentionsMe = mentionsMe,
            boostedBy = boostedBy,
        )

    private val alice = "https://mastodon.example/users/alice"
    private val bob = "https://mastodon.example/users/bob"

    @Test
    fun `first run notifies nothing but records the high-water mark`() {
        val entries = listOf(
            entry("p1", alice, "2026-07-15T10:00:00Z"),
            entry("p2", bob, "2026-07-15T11:00:00Z"),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice, bob), highWater = null)

        assertTrue(decision.toNotify.isEmpty())
        assertEquals(Instant.parse("2026-07-15T11:00:00Z"), decision.newHighWater)
    }

    @Test
    fun `notifies only posts newer than high-water from notify-on actors`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        val entries = listOf(
            entry("old", alice, "2026-07-15T09:00:00Z"), // older than hw → skip
            entry("new-alice", alice, "2026-07-15T10:30:00Z"), // notify
            entry("new-bob", bob, "2026-07-15T11:00:00Z"), // bob muted → skip
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)

        assertEquals(listOf("new-alice"), decision.toNotify.map { it.objectUri })
        assertEquals(Instant.parse("2026-07-15T11:00:00Z"), decision.newHighWater)
    }

    @Test
    fun `newness is judged by received_at when present (delayed federation arrival still notifies)`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        // Published BEFORE the high-water but received after — the exact case a
        // published-time high-water silently skipped (#1060).
        val entries = listOf(
            entry("late", alice, "2026-07-15T09:00:00Z", receivedAt = "2026-07-15T10:05:00Z"),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)
        assertEquals(listOf("late"), decision.toNotify.map { it.objectUri })
        assertEquals(Instant.parse("2026-07-15T10:05:00Z"), decision.newHighWater)
    }

    @Test
    fun `replies to others never notify, replies to your own posts do`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        val entries = listOf(
            entry("reply-other", alice, "2026-07-15T10:30:00Z", inReplyToUri = "https://x.example/1"),
            entry(
                "reply-mine",
                alice,
                "2026-07-15T10:40:00Z",
                inReplyToUri = "https://me.example/users/me/feed/abc",
                inReplyToMine = true,
            ),
            entry("top-level", alice, "2026-07-15T10:50:00Z"),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)
        assertEquals(listOf("reply-mine", "top-level"), decision.toNotify.map { it.objectUri })
    }

    @Test
    fun `involvement notifies even from actors outside the notify set`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        val stranger = "https://elsewhere.example/users/stranger"
        val entries = listOf(
            // A stranger's reply to MY post (admitted by the inbox involvement branch).
            entry(
                "stranger-reply",
                stranger,
                "2026-07-15T10:10:00Z",
                inReplyToUri = "https://me.example/users/me/feed/abc",
                inReplyToMine = true,
            ),
            // A stranger mentioning me in a top-level post.
            entry("stranger-mention", stranger, "2026-07-15T10:20:00Z", mentionsMe = true),
            // A stranger's plain post never notifies (and never reaches the timeline anyway).
            entry("stranger-plain", stranger, "2026-07-15T10:30:00Z"),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)
        assertEquals(listOf("stranger-reply", "stranger-mention"), decision.toNotify.map { it.objectUri })
    }

    @Test
    fun `a boost notifies on the BOOSTER, not the boosted post's author`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        val carol = "https://third.example/users/carol"
        val entries = listOf(
            // Alice (followed, notify on) boosted Carol's post — Carol isn't
            // followed at all, but the boost is in the timeline because of Alice.
            entry(
                "boost-by-alice",
                carol,
                "2026-07-15T10:10:00Z",
                boostedBy = BoostedBy(actorUri = alice, handle = "@alice@mastodon.example"),
            ),
            // Bob is muted, so his boost stays silent even though Carol isn't.
            entry(
                "boost-by-bob",
                carol,
                "2026-07-15T10:20:00Z",
                boostedBy = BoostedBy(actorUri = bob),
            ),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)
        assertEquals(listOf("boost-by-alice"), decision.toNotify.map { it.objectUri })
    }

    @Test
    fun `toNotify is ordered oldest-first`() {
        val hw = Instant.parse("2026-07-15T00:00:00Z")
        val entries = listOf(
            entry("c", alice, "2026-07-15T12:00:00Z"),
            entry("a", alice, "2026-07-15T08:00:00Z"),
            entry("b", alice, "2026-07-15T10:00:00Z"),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)
        assertEquals(listOf("a", "b", "c"), decision.toNotify.map { it.objectUri })
    }

    @Test
    fun `high-water never moves backwards when the page is empty`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        val decision = decideNotifications(emptyList(), notifyActorUris = setOf(alice), highWater = hw)
        assertTrue(decision.toNotify.isEmpty())
        assertEquals(hw, decision.newHighWater)
    }

    @Test
    fun `empty first run leaves high-water null`() {
        val decision = decideNotifications(emptyList(), notifyActorUris = emptySet(), highWater = null)
        assertNull(decision.newHighWater)
    }

    @Test
    fun `unparseable timestamps are ignored`() {
        val hw = Instant.parse("2026-07-15T10:00:00Z")
        val entries = listOf(
            entry("bad", alice, "not-a-date"),
            entry("good", alice, "2026-07-15T11:00:00Z"),
        )
        val decision = decideNotifications(entries, notifyActorUris = setOf(alice), highWater = hw)
        assertEquals(listOf("good"), decision.toNotify.map { it.objectUri })
        assertEquals(Instant.parse("2026-07-15T11:00:00Z"), decision.newHighWater)
    }

    @Test
    fun `htmlToSnippet strips tags, unescapes entities, and truncates`() {
        assertEquals("Hello world", htmlToSnippet("<p>Hello <b>world</b></p>"))
        assertEquals("a & b < c", htmlToSnippet("a &amp; b &lt; c"))
        val long = htmlToSnippet("<p>${"x".repeat(200)}</p>", maxLength = 10)
        assertTrue(long.endsWith("…"))
        assertEquals(10, long.length)
    }
}
