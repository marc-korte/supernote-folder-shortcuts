package com.supernotefoldershortcuts;

import android.content.ComponentName;
import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.List;

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
    private static final String OVERLAY_ACTION =
            "com.ratta.supernote.launcher.slidebarstatusbarstate";
    private boolean overlayVisible;
    private long overlayGraceUntil;
    private int interactionRevision;
    private final BroadcastReceiver overlayReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (!OVERLAY_ACTION.equals(intent.getAction())) return;
            overlayVisible = intent.getBooleanExtra("show", false);
            overlayGraceUntil = SystemClock.uptimeMillis() + 1500;
            interactionRevision++;
        }
    };

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
    // Context probes are cheap and no longer wait behind getElements. A
    // half-second tick bounds listener recovery after returning from another
    // activity without increasing the 30-second page-scan cadence.
    private static final long TICK_MS = 500;

    private final Handler tickHandler = new Handler(Looper.getMainLooper());
    // volatile: invalidate() runs off the main thread, and a tick already
    // executing when it fires escapes removeCallbacks and re-posts itself. It
    // must see the write on its next run or the heartbeat survives the module.
    private volatile boolean alive = true;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!alive) return;
            // The plugin view is normally paused while the user is looking at
            // a note. That background state is exactly when link geometry and
            // the motion listener must be maintained.
            emitTick();
            tickHandler.postDelayed(this, TICK_MS);
        }
    };

    public FolderLinkModule(ReactApplicationContext reactContext) {
        super(reactContext);
        IntentFilter filter = new IntentFilter(OVERLAY_ACTION);
        if (Build.VERSION.SDK_INT >= 33) {
            reactContext.registerReceiver(overlayReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            reactContext.registerReceiver(overlayReceiver, filter);
        }
        tickHandler.postDelayed(tick, TICK_MS);
    }

    @Override
    public String getName() {
        return "FolderLinkNative";
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

    @Override
    public synchronized void invalidate() {
        alive = false;
        tickHandler.removeCallbacks(tick);
        getReactApplicationContext().unregisterReceiver(overlayReceiver);
        FingerMonitorReset.stop(getReactApplicationContext());
        NoteUiGuard.shutdown();
        super.invalidate();
    }

    /** The SDK's last-file context does not identify the app receiving input. */
    @ReactMethod
    @SuppressWarnings("deprecation")
    public void getForegroundActivity(Promise promise) {
        try {
            ActivityManager manager = (ActivityManager) getReactApplicationContext()
                    .getSystemService(Context.ACTIVITY_SERVICE);
            List<ActivityManager.RunningTaskInfo> tasks = manager.getRunningTasks(1);
            ComponentName top = tasks.isEmpty() ? null : tasks.get(0).topActivity;
            promise.resolve(top == null ? null : top.flattenToString());
        } catch (Exception e) {
            // Unknown foreground state must never arm a cached note rectangle.
            promise.resolve(null);
        }
    }

    @ReactMethod
    public synchronized void setNoteInteractionActive(boolean active) {
        if (!alive) return;
        NoteUiGuard.setActive(active);
    }

    @ReactMethod
    public void getInteractionState(double x, double y, Promise promise) {
        NoteUiGuard.inspect((float) x, (float) y, snapshot -> tickHandler.post(() -> {
            if (!alive) return;
            WritableMap result = Arguments.createMap();
            result.putBoolean("blocked", snapshot.blocked || overlayVisible ||
                    SystemClock.uptimeMillis() < overlayGraceUntil);
            result.putInt("revision", interactionRevision);
            result.putInt("uiRevision", snapshot.revision);
            promise.resolve(result);
        }));
    }

    /** Allow the evdev reader to classify size even when SDK UP arrives first. */
    @ReactMethod
    public void validateFingerContact(double downTime, double eventTime, Promise promise) {
        tickHandler.postDelayed(() -> {
            if (alive) promise.resolve(!RawFingerTapMonitor.isRejectedContact(
                    (long) downTime, (long) eventTime));
        }, 50);
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

    /**
     * A deadline that still fires while the plugin view is paused.
     *
     * React Native pauses its JavaScript timers whenever the picker is closed,
     * but native-to-JS callbacks remain live (the heartbeat above relies on
     * that). SDK context requests can be stranded during an activity handoff,
     * so JavaScript races them against this native clock instead of waiting for
     * the SDK's much longer request timeout and blocking every queued refresh.
     */
    @ReactMethod
    public void delay(int milliseconds, Promise promise) {
        int boundedDelay = Math.max(0, Math.min(milliseconds, 60_000));
        // A timeout already queued when the module is destroyed must not call
        // back into the React instance being torn down. Its JavaScript promise
        // disappears with that instance, so there is nothing left to settle.
        tickHandler.postDelayed(() -> {
            if (alive) promise.resolve(true);
        }, boundedDelay);
    }

    /** Renews the host's stale raw-input monitor after a document return. */
    @ReactMethod
    public void resetFingerMonitor(Promise promise) {
        tickHandler.post(() -> {
            if (!alive) return;
            try {
                FingerMonitorReset.reset(getReactApplicationContext());
                Log.i(TAG, "finger tap fallback ready");
                promise.resolve(true);
            } catch (Exception e) {
                Log.e(TAG, "finger monitor reset unavailable: " + e.getMessage(), e);
                promise.resolve(false);
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
