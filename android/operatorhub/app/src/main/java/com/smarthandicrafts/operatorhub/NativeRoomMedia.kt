package com.smarthandicrafts.operatorhub

import org.json.JSONObject

/** Lifecycle boundary lets call ownership be verified without opening a real microphone. */
internal interface NativeRoomMedia {
    fun connect(descriptor: JSONObject)
    fun setMuted(value: Boolean)
    fun setSpeaker(value: Boolean)
    /** Synchronously silence local capture/playout without waiting for RTC transport work. */
    fun silenceForClose(): Boolean
    fun close()
}
