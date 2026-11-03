package com.smarthandicrafts.operatorhub

import org.junit.Assert.*
import org.junit.Test

class NativePcmMixerTest {
    private fun pcm(value: Int, frames: Int, channels: Int = 1) = ByteArray(frames * channels * 2).also { bytes ->
        for (i in bytes.indices step 2) { bytes[i] = value.toByte(); bytes[i + 1] = (value shr 8).toByte() }
    }
    private fun sample(bytes: ByteArray, index: Int = 0) = ((bytes[index * 2].toInt() and 255) or (bytes[index * 2 + 1].toInt() shl 8)).toShort().toInt()
    @Test fun mixesMicrophoneAndCustomerIntoOneTimelineAndResamplesStereo() {
        val parts = mutableListOf<ByteArray>(); val mixer = NativePcmMixer { _, _, bytes -> parts.add(bytes) }
        mixer.add("mic", pcm(1000, 160), 16, 16000, 1, 10)
        mixer.add("customer", pcm(2000, 480, 2), 16, 48000, 2, 10)
        mixer.advance(10, true)
        assertEquals(1, parts.size); assertEquals(320, parts[0].size)
        assertEquals(2100, sample(parts[0])); assertEquals(2100, sample(parts[0], 159))
    }
    @Test fun longRecordingFlushesTenSecondPartsAndRetainsTheTail() {
        val sizes = mutableListOf<Int>(); val offsets = mutableListOf<Long>()
        val mixer = NativePcmMixer { _, at, bytes -> offsets.add(at); sizes.add(bytes.size) }
        for (i in 1..2010) { mixer.add("customer", pcm(1000, 160), 16, 16000, 1, i * 10L); mixer.advance(i * 10L) }
        mixer.advance(20100, true)
        assertEquals(listOf(320000, 320000, 3200), sizes); assertEquals(listOf(0L, 10000L, 20000L), offsets)
    }
    @Test fun missingAudioStaysSilentAndMixedAudioClipsWithoutOverflow() {
        var bytes = byteArrayOf(); val mixer = NativePcmMixer { _, _, out -> bytes = out }
        mixer.add("a", pcm(32000, 160), 16, 16000, 1, 10)
        mixer.add("b", pcm(32000, 160), 16, 16000, 1, 10)
        mixer.advance(1000, true)
        assertEquals(32767, sample(bytes)); assertEquals(0, sample(bytes, 15999))
    }
    @Test fun malformedAudioCannotDamageTheCallRecorder() {
        var bytes = byteArrayOf(); val mixer = NativePcmMixer { _, _, out -> bytes = out }
        mixer.add("bad", pcm(1000, 10), 32, 16000, 1, 10)
        mixer.add("bad", byteArrayOf(1), 16, 16000, 1, 10)
        mixer.advance(10, true); assertTrue(bytes.all { it == 0.toByte() })
    }
}
