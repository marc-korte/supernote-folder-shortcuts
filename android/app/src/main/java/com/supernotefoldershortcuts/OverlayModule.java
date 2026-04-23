package com.supernotefoldershortcuts;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.HashMap;
import java.util.Map;

/**
 * Creates invisible SYSTEM_ALERT_WINDOW overlays — one per saved folder
 * shortcut — anchored over the linked word's on-screen rectangle. The
 * overlay consumes finger taps (tool=1) and fires a `folderLinkOverlayTap`
 * event with the shortcut id, leaving pen/stylus events to pass through
 * so writing, lassoing, and erasing continue to work unaffected.
 */
public class OverlayModule extends ReactContextBaseJavaModule {
    private static final String TAG = "[folder-link-native]";
    private static final String EVENT_TAP = "folderLinkOverlayTap";
    private static final long TAP_MAX_DURATION_MS = 300;
    private static final float TAP_MAX_MOVEMENT_PX = 25f;

    private final Map<String, View> overlays = new HashMap<>();
    private WindowManager wm;

    public OverlayModule(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return "FolderLinkOverlay";
    }

    @Override
    public void invalidate() {
        new Handler(Looper.getMainLooper()).post(this::removeAllOverlays);
        super.invalidate();
    }

    private void removeAllOverlays() {
        if (wm != null) {
            for (View v : overlays.values()) {
                try {
                    wm.removeViewImmediate(v);
                } catch (Exception ignore) {
                }
            }
        }
        overlays.clear();
        wm = null;
    }

    @ReactMethod
    public void setOverlays(ReadableArray list, Promise promise) {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                Context ctx = getReactApplicationContext();
                if (wm == null) {
                    wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
                }
                removeAllLocked();
                int added = 0;
                for (int i = 0; i < list.size(); i++) {
                    ReadableMap m = list.getMap(i);
                    if (m == null) continue;
                    String id = m.hasKey("id") ? m.getString("id") : null;
                    if (id == null) continue;
                    int x = m.hasKey("x") ? (int) m.getDouble("x") : 0;
                    int y = m.hasKey("y") ? (int) m.getDouble("y") : 0;
                    int w = m.hasKey("width") ? (int) m.getDouble("width") : 0;
                    int h = m.hasKey("height") ? (int) m.getDouble("height") : 0;
                    if (w <= 0 || h <= 0) continue;
                    View v = addOverlayLocked(ctx, id, x, y, w, h);
                    if (v != null) {
                        overlays.put(id, v);
                        added++;
                    }
                }
                Log.i(TAG, "setOverlays installed=" + added);
                promise.resolve(added);
            } catch (Exception e) {
                Log.e(TAG, "setOverlays failed: " + e.getMessage(), e);
                promise.reject("SET_FAILED", e);
            }
        });
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

    @ReactMethod
    public void clearOverlays(Promise promise) {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                removeAllLocked();
                promise.resolve(true);
            } catch (Exception e) {
                Log.e(TAG, "clearOverlays failed: " + e.getMessage(), e);
                promise.reject("CLEAR_FAILED", e);
            }
        });
    }

    private void removeAllLocked() {
        if (wm == null) return;
        for (View v : overlays.values()) {
            try {
                wm.removeView(v);
            } catch (Exception ignore) {
            }
        }
        overlays.clear();
    }

    private View addOverlayLocked(Context ctx, String id, int x, int y, int width, int height) {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                width,
                height,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = x;
        params.y = y;

        final ReactApplicationContext rctx = (ReactApplicationContext) ctx;
        final String overlayId = id;
        final long[] downTime = {0};
        final float[] downPos = {0, 0};

        View v = new FrameLayout(ctx) {
            @Override
            public boolean onTouchEvent(MotionEvent event) {
                // Only swallow finger events; let stylus fall through so writing works.
                if (event.getToolType(0) != MotionEvent.TOOL_TYPE_FINGER) {
                    return false;
                }
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downTime[0] = event.getEventTime();
                        downPos[0] = event.getRawX();
                        downPos[1] = event.getRawY();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        return true;
                    case MotionEvent.ACTION_UP: {
                        long duration = event.getEventTime() - downTime[0];
                        float dx = event.getRawX() - downPos[0];
                        float dy = event.getRawY() - downPos[1];
                        float move = (float) Math.sqrt(dx * dx + dy * dy);
                        if (duration <= TAP_MAX_DURATION_MS && move <= TAP_MAX_MOVEMENT_PX) {
                            WritableMap payload = Arguments.createMap();
                            payload.putString("id", overlayId);
                            try {
                                rctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                                        .emit(EVENT_TAP, payload);
                            } catch (Exception e) {
                                Log.e(TAG, "emit tap failed", e);
                            }
                        }
                        return true;
                    }
                    default:
                        return false;
                }
            }
        };
        v.setBackgroundColor(Color.TRANSPARENT);

        try {
            wm.addView(v, params);
            return v;
        } catch (Exception e) {
            Log.e(TAG, "addView failed for id=" + id + ": " + e.getMessage(), e);
            return null;
        }
    }
}
