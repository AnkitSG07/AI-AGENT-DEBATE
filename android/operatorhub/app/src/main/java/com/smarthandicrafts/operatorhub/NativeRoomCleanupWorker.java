package com.smarthandicrafts.operatorhub;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Network cleanup only: no Activity, room token or microphone acquisition. */
public final class NativeRoomCleanupWorker extends Worker {
    public NativeRoomCleanupWorker(@NonNull Context context, @NonNull WorkerParameters params) { super(context, params); }
    @NonNull @Override public Result doWork() {
        return NativeRoomCleanup.drainWorker(getApplicationContext()) ? Result.retry() : Result.success();
    }
}
