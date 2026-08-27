package com.supernotefoldershortcuts;

import android.content.Context;
import android.content.ContextWrapper;
import android.view.View;

import com.facebook.react.bridge.ReactApplicationContext;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;

/**
 * Starts a narrow raw-finger fallback after a DOC -> NOTE handoff.
 *
 * Manta firmware resumes its SDK SimpleEventMonitor after the note returns,
 * but its native callback can then omit every DOWN and publish only orphan UP
 * events. Replacing or restarting that monitor does not repair the callback.
 * The host exposes no SDK recovery API, so this version-gated reflection reads
 * only the touch-device path already discovered by the host. RawFingerTapMonitor
 * then reports single-finger taps without modifying the firmware monitor.
 */
final class FingerMonitorReset {
    private static final String SERVICE_CLASS =
            "com.ratta.supernote.pluginhost.services.PluginHostService";
    private static final String MONITOR_FIELD = "mEventMonitor";

    private FingerMonitorReset() {}

    static void reset(ReactApplicationContext reactContext) throws Exception {
        Class<?> serviceClass = Class.forName(SERVICE_CLASS);
        Method getPluginContainer = serviceClass.getDeclaredMethod("getPluginContainer");
        // getDeclaredMethod finds the accessor whatever its modifier, but
        // invoking it does not: a firmware revision that makes this
        // package-private would throw IllegalAccessException here instead of
        // reporting a missing path.
        getPluginContainer.setAccessible(true);
        Object container = getPluginContainer.invoke(null);
        if (!(container instanceof View)) {
            throw new IllegalStateException("plugin container is unavailable");
        }

        Context context = ((View) container).getContext();
        Object service = unwrapService(context, serviceClass);
        if (service == null) {
            throw new IllegalStateException("plugin host service context is unavailable");
        }

        Field monitorField = resolveField(serviceClass, MONITOR_FIELD);
        Object monitor = monitorField.get(service);
        if (monitor == null) {
            throw new IllegalStateException("plugin host finger monitor is unavailable");
        }

        Class<?> monitorClass = monitor.getClass();
        Field keyField = resolveField(monitorClass, "FINGER_KEY");
        Field pathsField = resolveField(monitorClass, "paths");
        Object key = keyField.get(monitor);
        Object pathsValue = pathsField.get(monitor);
        if (!(pathsValue instanceof Map)) {
            throw new IllegalStateException("plugin host input paths are unavailable");
        }
        Object pathValue = ((Map<?, ?>) pathsValue).get(key);
        if (!(pathValue instanceof String) || !((String) pathValue).startsWith("/dev/input/")) {
            throw new IllegalStateException("plugin host finger path is unavailable");
        }

        RawFingerTapMonitor.ensureStarted(reactContext, (String) pathValue);
    }

    static void stop(ReactApplicationContext reactContext) {
        RawFingerTapMonitor.stopForContext(reactContext);
    }

    /**
     * getDeclaredField sees one class, so a host field declared on a supertype
     * reads as absent. That matters most for the monitor, which is resolved
     * from its runtime class: a subclassed or proxied SimpleEventMonitor would
     * hide FINGER_KEY and paths on the parent. Still throws NoSuchFieldException
     * when the field is genuinely absent, so the caller's fallback is unchanged.
     */
    private static Field resolveField(Class<?> type, String name) throws Exception {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                Field field = current.getDeclaredField(name);
                field.setAccessible(true);
                return field;
            } catch (NoSuchFieldException ignored) {
                // Declared further up the hierarchy, or not present at all.
            }
        }
        throw new NoSuchFieldException(type.getName() + "." + name);
    }

    private static Object unwrapService(Context context, Class<?> serviceClass) {
        Context current = context;
        for (int depth = 0; current != null && depth < 8; depth++) {
            if (serviceClass.isInstance(current)) return current;
            if (!(current instanceof ContextWrapper)) return null;
            Context next = ((ContextWrapper) current).getBaseContext();
            if (next == current) return null;
            current = next;
        }
        return null;
    }
}
