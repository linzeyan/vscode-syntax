package com.example.poly

import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** A published release and its assets. */
data class Release(val tag: String, val assets: List<String> = emptyList()) {
    val version: Triple<Int, Int, Int>
        get() {
            val m = SEMVER.matchEntire(tag) ?: error("bad tag: $tag")
            val (major, minor, patch) = m.destructured
            return Triple(major.toInt(), minor.toInt(), patch.toInt())
        }

    companion object {
        private val SEMVER = Regex("""^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$""")
    }
}

sealed interface Outcome {
    data class Ok(val release: Release) : Outcome
    data class Failed(val reason: String) : Outcome
}

suspend fun verifyAll(tags: List<String>): List<Outcome> = coroutineScope {
    tags.map { tag ->
        async {
            runCatching { Release(tag) }
                .fold(onSuccess = Outcome::Ok, onFailure = { Outcome.Failed(it.message ?: "?") })
        }
    }.map { it.await() }
}

fun describe(outcome: Outcome): String = when (outcome) {
    is Outcome.Ok -> "${outcome.release.tag} (${outcome.release.assets.size} assets)"
    is Outcome.Failed -> "FAILED: ${outcome.reason}"
}
