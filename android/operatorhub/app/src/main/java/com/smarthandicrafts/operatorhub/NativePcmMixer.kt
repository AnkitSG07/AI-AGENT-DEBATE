package com.smarthandicrafts.operatorhub

import kotlin.math.abs
import kotlin.math.min

/** Single-threaded PCM timeline. Muted/private tracks never enter this mixer. */
internal class NativePcmMixer(private val output: (Int, Long, ByteArray) -> Unit) {
    companion object { const val RATE = 16000; const val PART = RATE * 10 }
    private val samples = IntArray(PART + RATE)
    private val positions = HashMap<String, Long>()
    private var offset = 0L
    private var index = 0
    fun add(track: String, bytes: ByteArray, bits: Int, rate: Int, channels: Int, elapsedMs: Long) {
        if (bits != 16 || rate !in 8000..192000 || channels !in 1..8 || bytes.size % (2 * channels) != 0) return
        val inputFrames = bytes.size / (2 * channels)
        val count = inputFrames.toLong() * RATE / rate
        if (count <= 0 || count > RATE) return
        val expected = (elapsedMs * RATE / 1000 - count).coerceAtLeast(0)
        var position = positions[track] ?: expected
        if (abs(position - expected) > RATE / 2) position = expected
        for (i in 0 until count.toInt()) {
            while (position + i - offset >= samples.size) flush(PART)
            val target = (position + i - offset).toInt()
            if (target < 0) continue
            val frame = min(inputFrames - 1, (i.toLong() * rate / RATE).toInt())
            var value = 0
            for (channel in 0 until channels) {
                val at = (frame * channels + channel) * 2
                value += ((bytes[at].toInt() and 255) or (bytes[at + 1].toInt() shl 8)).toShort().toInt()
            }
            samples[target] += value / channels * 7 / 10
        }
        positions[track] = position + count
    }
    fun advance(elapsedMs: Long, final: Boolean = false) {
        val end = (elapsedMs * RATE / 1000).coerceAtLeast(offset)
        while (end - offset >= PART + if (final) 0 else RATE / 5) flush(PART)
        if (final && end > offset) flush((end - offset).toInt())
    }
    private fun flush(count: Int) {
        val pcm = ByteArray(count * 2)
        for (i in 0 until count) {
            val value = samples[i].coerceIn(-32768, 32767)
            pcm[i * 2] = value.toByte(); pcm[i * 2 + 1] = (value shr 8).toByte()
        }
        output(index++, offset * 1000 / RATE, pcm)
        offset += count
        samples.copyInto(samples, 0, count, samples.size)
        samples.fill(0, samples.size - count)
    }
}
