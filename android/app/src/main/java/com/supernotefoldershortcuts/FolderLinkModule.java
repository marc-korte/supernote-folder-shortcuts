package com.supernotefoldershortcuts;

import android.app.Activity;
import android.app.Application;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * The native side of the plugin: a heartbeat that survives JS timer suspension,
 * navigation into a folder, and display metrics.
 *
 * This class used to lay invisible SYSTEM_ALERT_WINDOW rectangles over each
 * linked word to catch finger taps. That is gone. The plugin's motion listener
 * reports finger touches as well as stylus ones, which made the windows
 * redundant, and they actively broke the note: a window swallows every finger
 * event inside it, so a linked object could no longer be dragged or resized.
 * Their geometry also came from the last refresh, so the tappable area lagged
 * behind an object that moved. Hit-testing a tap against the note's own link
 * rectangle has neither problem.
 */
public class FolderLinkModule extends ReactContextBaseJavaModule {
    private static final String TAG = "[folder-link-native]";
    private static final String EVENT_TICK = "folderLinkTick";

    /**
     * How often JS is nudged to re-check which note and page is open.
     *
     * This heartbeat lives here rather than in a JS setInterval because React
     * Native suspends JS timers while the host context is paused, and the
     * plugin's context is paused whenever the plugin view is closed — which is
     * exactly when it needs maintaining. A native Handler keeps running, and
     * native-to-JS events are still delivered (that is how PEN_UP arrives), so
     * this is the one tick that survives.
     */
    private static final long TICK_MS = 1500;

    private final Handler tickHandler = new Handler(Looper.getMainLooper());
    private boolean alive = true;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!alive) return;
            // Nothing to maintain while the host is in the background, and the
            // context APIs have no note to report on either.
            if (hostVisible()) emitTick();
            tickHandler.postDelayed(this, TICK_MS);
        }
    };

    private Application application;
    private Application.ActivityLifecycleCallbacks lifecycleCallbacks;
    private int resumedActivities = 0;
    /**
     * Only meaningful once an activity callback has actually fired: if the
     * plugin turns out to run somewhere without activities of its own, the
     * heartbeat keeps going rather than silently stopping forever.
     */
    private boolean lifecycleObserved = false;

    public FolderLinkModule(ReactApplicationContext reactContext) {
        super(reactContext);
        registerLifecycleCallbacks(reactContext);
        tickHandler.postDelayed(tick, TICK_MS);
    }

    @Override
    public String getName() {
        return "FolderLinkNative";
    }

    private boolean hostVisible() {
        return !lifecycleObserved || resumedActivities > 0;
    }

    private void emitTick() {
        try {
            getReactApplicationContext()
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(EVENT_TICK, null);
        } catch (Exception e) {
            // Expected until the JS context finishes coming up.
        }
    }

    private void registerLifecycleCallbacks(Context ctx) {
        Context app = ctx.getApplicationContext();
        if (!(app instanceof Application)) {
            Log.i(TAG, "no Application context; heartbeat will not track foreground state");
            return;
        }
        application = (Application) app;
        lifecycleCallbacks = new Application.ActivityLifecycleCallbacks() {
            @Override
            public void onActivityResumed(@NonNull Activity activity) {
                lifecycleObserved = true;
                resumedActivities++;
            }

            @Override
            public void onActivityPaused(@NonNull Activity activity) {
                lifecycleObserved = true;
                if (resumedActivities > 0) resumedActivities--;
            }

            @Override
            public void onActivityCreated(@NonNull Activity activity, @Nullable Bundle state) {}

            @Override
            public void onActivityStarted(@NonNull Activity activity) {}

            @Override
            public void onActivityStopped(@NonNull Activity activity) {}

            @Override
            public void onActivitySaveInstanceState(@NonNull Activity activity, @NonNull Bundle out) {}

            @Override
            public void onActivityDestroyed(@NonNull Activity activity) {}
        };
        application.registerActivityLifecycleCallbacks(lifecycleCallbacks);
    }

    @Override
    public void invalidate() {
        alive = false;
        tickHandler.removeCallbacks(tick);
        if (application != null && lifecycleCallbacks != null) {
            application.unregisterActivityLifecycleCallbacks(lifecycleCallbacks);
            lifecycleCallbacks = null;
        }
        super.invalidate();
    }

    /**
     * Opens the Supernote file manager and navigates into the given folder.
     *
     * The SDK's FileUtils.openFilePath wraps this same intent but passes the
     * user's current NOTE file path as `folder_path` and the target as
     * `only_open_file`, which on some firmware results in the file manager
     * opening its root view instead of the target folder. Setting
     * `folder_path` to the target directly navigates reliably.
     */
    @ReactMethod
    public void openFolder(String path, Promise promise) {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Context ctx = getReactApplicationContext();
                Intent intent = new Intent();
                intent.setComponent(new ComponentName(
                        "com.ratta.supernote.inbox",
                        "com.ratta.supernote.explorer.FileManagerMainActivity"));
                intent.putExtra("folder_path", path);
                intent.putExtra("source_type", 2);
                intent.setAction(Intent.ACTION_VIEW);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
                Log.i(TAG, "openFolder → " + path);
                promise.resolve(true);
            } catch (Exception e) {
                Log.e(TAG, "openFolder failed: " + e.getMessage(), e);
                promise.reject("OPEN_FOLDER_FAILED", e);
            }
        });
    }

    /** Used to convert a touch in screen pixels into page coordinates. */
    @ReactMethod
    public void getDisplayMetrics(Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            WindowManager localWm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            DisplayMetrics m = new DisplayMetrics();
            localWm.getDefaultDisplay().getRealMetrics(m);
            WritableMap map = Arguments.createMap();
            map.putInt("widthPixels", m.widthPixels);
            map.putInt("heightPixels", m.heightPixels);
            map.putDouble("density", m.density);
            map.putInt("densityDpi", m.densityDpi);
            promise.resolve(map);
        } catch (Exception e) {
            Log.e(TAG, "getDisplayMetrics failed: " + e.getMessage(), e);
            promise.reject("METRICS_FAILED", e);
        }
    }
}
