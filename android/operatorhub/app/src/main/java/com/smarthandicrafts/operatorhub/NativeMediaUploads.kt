package com.smarthandicrafts.operatorhub

import android.content.Context
import androidx.work.*
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

/** Private durable upload queue. No bearer, room token or microphone is stored. */
internal object NativeMediaUploads {
    private fun directory(context: Context) = File(context.noBackupFilesDir, "call-media-pending").apply { mkdirs() }
    @Synchronized fun enqueue(context: Context, credential: DeviceLeasePolicy.Credential, path: String, body: JSONObject) {
        val dir = directory(context)
        val bytes = JSONObject().put("deviceId", credential.deviceId).put("generation", credential.generation)
            .put("path", path).put("body", body).toString().toByteArray(Charsets.UTF_8)
        check((dir.listFiles()?.sumOf { it.length() } ?: 0L) + bytes.size <= 128L * 1024 * 1024) { "Recording upload storage is full" }
        val temporary = File(dir, UUID.randomUUID().toString() + ".tmp")
        temporary.outputStream().use { it.write(bytes); it.fd.sync() }
        check(temporary.renameTo(File(dir, temporary.name.removeSuffix(".tmp") + ".json")))
        schedule(context)
    }
    @JvmStatic fun schedule(context: Context) {
        if (directory(context).listFiles()?.any { it.extension == "json" } != true) return
        val request = OneTimeWorkRequestBuilder<NativeMediaUploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("sh-call-media-uploads", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
    @JvmStatic fun pending(context: Context): Int = directory(context).listFiles()?.count { it.extension == "json" } ?: 0
    @JvmStatic fun failed(context: Context): Int = directory(context).listFiles()?.count { it.extension == "failed" } ?: 0
    private fun quarantine(file: File) { file.renameTo(File(file.parentFile, file.nameWithoutExtension + ".failed")) }
    fun drain(context: Context): Boolean {
        val store = NativeStore(context)
        for (file in directory(context).listFiles()?.filter { it.extension == "json" }?.sortedBy { it.lastModified() }?.take(50) ?: emptyList()) {
            val item = runCatching { JSONObject(file.readText()) }.getOrNull()
            if (item == null) { quarantine(file); continue }
            val credential = store.credential()
            // Re-enrollment must never upload another operator's queued audio.
            if (item.optString("deviceId") != credential.deviceId || item.optLong("generation") != credential.generation) { quarantine(file); continue }
            if (!DeviceLeasePolicy.valid(credential, System.currentTimeMillis())) return true
            val path = item.optString("path")
            if (!path.matches(Regex("/calls/[^/]+/(media-usage|recordings/[A-Za-z0-9_-]{8,100}/parts)"))) { quarantine(file); continue }
            try {
                if (!store.matchesCredential(credential)) return true
                NativeApi.request(path, "POST", item.getJSONObject("body"), credential.bearer)
                file.delete()
            } catch (error: NativeApi.ApiException) {
                // Retain rejected audio privately for diagnosis; one permanent
                // conflict must not strand every later call's recording.
                if (error.status in listOf(400, 403, 404, 409, 413, 422)) { quarantine(file); continue }
                return true
            } catch (_: Exception) { return true }
        }
        return directory(context).listFiles()?.any { file ->
            file.extension == "json" && runCatching {
                val item = JSONObject(file.readText()); val credential = store.credential()
                item.optString("deviceId") == credential.deviceId && item.optLong("generation") == credential.generation
            }.getOrDefault(false)
        } == true
    }
}

class NativeMediaUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = if (NativeMediaUploads.drain(applicationContext)) Result.retry() else Result.success()
}
