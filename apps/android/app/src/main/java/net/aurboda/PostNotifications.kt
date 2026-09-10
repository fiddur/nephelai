package net.aurboda

import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Data models + pure decision logic for the home-timeline post notifier
 * (NotificationWorker). Only the fields the notifier needs are declared; the
 * shared `appJson` ignores unknown keys, so the rest of the API payload is fine.
 */

/** One home-timeline post (subset of the backend `TimelineEntry`). */
@Serializable
data class TimelineEntry(
    @SerialName("object_uri") val objectUri: String,
    @SerialName("actor_uri") val actorUri: String,
    val handle: String? = null,
    @SerialName("display_name") val displayName: String? = null,
    val content: String = "",
    @SerialName("published_at") val publishedAt: String,
    // When this instance RECEIVED the post — monotonic per timeline, unlike
    // `published_at`, which can arrive out of order after federation retries.
    // Nullable for a backend that predates the field (rolling deploy).
    @SerialName("received_at") val receivedAt: String? = null,
    // Set when the post is a reply; `inReplyToMine` marks a reply to one of
    // the reader's own posts (always notified — you're involved).
    @SerialName("in_reply_to_uri") val inReplyToUri: String? = null,
    @SerialName("in_reply_to_mine") val inReplyToMine: Boolean = false,
    // A Mention of the reader — involvement, like a reply to their own post.
    @SerialName("mentions_me") val mentionsMe: Boolean = false,
    // Set when this card is a BOOST: the author fields above describe the
    // ORIGINAL post, this the followee who boosted it into the timeline.
    @SerialName("boosted_by") val boostedBy: BoostedBy? = null,
) {
    /** Best available human name for the notification title. */
    val authorLabel: String get() = displayName ?: handle ?: actorUri

    /**
     * Whose presence in the timeline this post is owed to — the booster for a
     * boost card, the author otherwise. This is the actor the notify-on-post
     * setting applies to: you follow the booster, not (necessarily) the author.
     */
    val sourceActorUri: String get() = boostedBy?.actorUri ?: actorUri
}

/** The followee who boosted a post into the timeline (subset of `TimelineBoostedBy`). */
@Serializable
data class BoostedBy(
    @SerialName("actor_uri") val actorUri: String,
    val handle: String? = null,
    @SerialName("display_name") val displayName: String? = null,
)

/** A page of the home timeline (subset of `TimelineResponse`). */
@Serializable
data class TimelinePage(
    val entries: List<TimelineEntry> = emptyList(),
)

/** A followed actor (subset of `FollowingActor`) — only what the notifier needs. */
@Serializable
data class FollowingActorLite(
    @SerialName("actor_uri") val actorUri: String,
    @SerialName("notify_on_post") val notifyOnPost: Boolean = true,
)

/** The owner's following list (subset of `FollowingResponse`). */
@Serializable
data class FollowingList(
    val following: List<FollowingActorLite> = emptyList(),
)

/** Outcome of a notifier poll: which posts to notify + the new high-water mark. */
data class NotifyDecision(
    /** Posts to raise a notification for, oldest-first. */
    val toNotify: List<TimelineEntry>,
    /** New high-water mark (latest post seen), or the previous one when nothing was seen. */
    val newHighWater: Instant?,
)

/** Lenient ISO-8601 parse (`Z` or an explicit offset), null when unparseable. */
fun parsePublishedAt(value: String): Instant? =
    runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()

/**
 * Decide which timeline posts to notify about.
 *
 * A post the reader is INVOLVED in — a reply to one of their own posts, or a
 * Mention of them — notifies whoever wrote it (its author may not be followed at
 * all: a stranger's reply/mention reaches the timeline through the inbox's
 * involvement branch). Any other post notifies when it is (a) not a reply to
 * someone else, and (b) from an actor in [notifyActorUris] (a followed account
 * with notifications left on). Everything is gated on being newer than
 * [highWater]; the new high-water mark advances to the latest post seen across
 * the whole page — so a muted or already-seen post never re-triggers.
 *
 * Newness is judged by `received_at` (when OUR instance stored the post), not
 * `published_at`: federation retries deliver posts out of publish order, and a
 * publish-time high-water silently skips any post that arrives after a
 * newer-published one. `published_at` remains the fallback for a backend that
 * predates `received_at`.
 *
 * On the first run ([highWater] is null) nothing is notified — we only record the
 * high-water mark, so enabling the feature doesn't dump the whole backlog.
 */
fun decideNotifications(
    entries: List<TimelineEntry>,
    notifyActorUris: Set<String>,
    highWater: Instant?,
): NotifyDecision {
    val dated = entries.mapNotNull { entry ->
        parsePublishedAt(entry.receivedAt ?: entry.publishedAt)?.let { entry to it }
    }
    val maxSeen = dated.maxOfOrNull { it.second }
    val newHighWater = listOfNotNull(highWater, maxSeen).maxOrNull()

    if (highWater == null) {
        return NotifyDecision(toNotify = emptyList(), newHighWater = newHighWater)
    }

    val toNotify = dated
        .filter { (entry, seenAt) ->
            val involved = entry.inReplyToMine || entry.mentionsMe
            seenAt.isAfter(highWater) &&
                (involved || (entry.inReplyToUri == null && entry.sourceActorUri in notifyActorUris))
        }
        .sortedBy { it.second }
        .map { it.first }
    return NotifyDecision(toNotify = toNotify, newHighWater = newHighWater)
}

/** Turn sanitised post HTML into a short plain-text snippet for a notification body. */
fun htmlToSnippet(html: String, maxLength: Int = 140): String {
    val text = html
        .replace(Regex("<[^>]+>"), " ")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace(Regex("\\s+"), " ")
        .trim()
    return if (text.length > maxLength) text.take(maxLength - 1).trimEnd() + "…" else text
}
