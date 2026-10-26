package com.supernotefoldershortcuts;

import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.SystemClock;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileReader;
import java.io.InterruptedIOException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Reads only tap-sized finger gestures from the firmware's evdev stream. */
final class RawFingerTapMonitor implements Runnable {
    static final String EVENT_TAP = "folderLinkRawFingerTap";
    static final String EVENT_REJECTED = "folderLinkRawContactRejected";
    static final String EVENT_STOPPED = "folderLinkRawMonitorStopped";

    private static final String TAG = "[folder-link-native]";
    private static final int INPUT_EVENT_BYTES = 24;
    private static final byte[] WAKE_BYTE = {1};

    private static volatile RawFingerTapMonitor instance;
    private static final RawFingerInput.MonitorHealth health = new RawFingerInput.MonitorHealth();
    private static final RawFingerInput.Rejections rejectedContacts = new RawFingerInput.Rejections();

    static boolean isRejectedContact(long downTime, long eventTime) {
        return !health.allowsValidation()
                || rejectedContacts.contains(downTime, eventTime, SystemClock.uptimeMillis());
    }

    private volatile ReactApplicationContext reactContext;
    private final String devicePath;
    private final WindowManager windowManager;
    private final FileDescriptor device;
    private final Map<Long, RawDownState> downStates = new LinkedHashMap<>();

    private static final class RawDownState {
        final boolean noteInFront;
        boolean completed;
        boolean blocked = true;
        int revision = -1;
        Runnable pending;

        RawDownState(boolean inFront) { noteInFront = inFront; }

        void complete(NoteUiGuard.Snapshot snapshot) {
            Runnable publish;
            synchronized (this) {
                completed = true;
                blocked = snapshot == null || snapshot.blocked;
                revision = snapshot == null ? -1 : snapshot.revision;
                publish = pending;
                pending = null;
            }
            if (publish != null) publish.run();
        }

        void dispatch(Runnable publish) {
            synchronized (this) {
                if (!completed) { pending = publish; return; }
            }
            publish.run();
        }
    }
    private final RawFingerInput input = new RawFingerInput(new RawFingerInput.TapSink() {
        @Override
        public void onTap(double x, double y, long downTime, long eventTime, int touchMajor) {
            emitTap(x, y, downTime, eventTime, touchMajor);
        }

        @Override
        public void onDown(double x, double y, long downTime) {
            captureDown(x, y, downTime);
        }

        @Override
        public void onRejected(long downTime, long eventTime, String reason) {
            emitRejected(downTime, eventTime, reason);
        }
    });

    private volatile boolean running = true;

    // The reader parks in poll() rather than in a blocking read, so stopping it
    // is a write on this pipe. Closing the device descriptor instead does not
    // unblock a thread already inside read() on a character device: the thread
    // stayed parked for the life of the process, leaking itself and an evdev
    // descriptor on every teardown. Both ends are owned by the reader thread
    // and closed in its finally, so the lock is what stops stop() from writing
    // to a descriptor number that has since been handed to something else.
    private final Object wakeLock = new Object();
    private FileDescriptor wakeRead;
    private FileDescriptor wakeWrite;
    private boolean wakeClosed;

    private RawFingerTapMonitor(ReactApplicationContext context, String path) throws Exception {
        reactContext = context;
        devicePath = path;
        DisplayMetrics metrics = new DisplayMetrics();
        windowManager =
                (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        String eventName = path.substring(path.lastIndexOf('/') + 1);
        if (!eventName.matches("event[0-9]+")) {
            throw new IllegalStateException("unsupported raw finger input path");
        }
        String panel;
        try (BufferedReader reader = new BufferedReader(new FileReader(
                "/sys/class/input/" + eventName + "/device/name"))) {
            panel = reader.readLine();
        }
        boolean supported = RawFingerInput.supports(panel == null ? null : panel.trim(),
                metrics.widthPixels, metrics.heightPixels,
                windowManager.getDefaultDisplay().getRotation());
        health.configure(supported);
        if (!supported) {
            throw new IllegalStateException("raw finger fallback is unverified for panel "
                    + panel + " / " + metrics.widthPixels + "x" + metrics.heightPixels
                    + " / rotation " + windowManager.getDefaultDisplay().getRotation());
        }
        FileDescriptor openedDevice = null;
        FileDescriptor[] wake = null;
        try {
            // evdev open is nonblocking; no caller waits for an input record.
            // Readiness is reported only after the descriptor and wake pipe
            // exist, rather than optimistically before the worker opens them.
            openedDevice = Os.open(devicePath,
                    OsConstants.O_RDONLY | OsConstants.O_NONBLOCK | OsConstants.O_CLOEXEC, 0);
            wake = Os.pipe();
        } catch (Exception error) {
            closeQuietly(openedDevice);
            if (wake != null) { closeQuietly(wake[0]); closeQuietly(wake[1]); }
            throw error;
        }
        device = openedDevice;
        wakeRead = wake[0];
        wakeWrite = wake[1];
    }

    static synchronized void ensureStarted(ReactApplicationContext context, String path) throws Exception {
        if (instance != null && instance.running && instance.devicePath.equals(path)) {
            instance.reactContext = context;
            return;
        }
        if (instance != null) instance.stop();
        instance = new RawFingerTapMonitor(context, path);
        Thread thread = new Thread(instance, "folder-link-raw-finger");
        thread.setDaemon(true);
        try {
            health.opened();
            thread.start();
        } catch (Exception error) {
            instance.running = false;
            closeQuietly(instance.device);
            closeQuietly(instance.wakeRead);
            closeQuietly(instance.wakeWrite);
            health.stopped();
            throw error;
        }
    }

    static synchronized void stopForContext(ReactApplicationContext context) {
        if (instance != null && instance.reactContext == context) {
            instance.stop();
            instance = null;
        }
    }

    private void stop() {
        running = false;
        if (instance == this) health.stopped();
        // Not joined: the wake byte ends the poll immediately, and this runs on
        // the teardown path, where blocking the caller would be worse than
        // letting the last frame drain on its own thread.
        synchronized (wakeLock) {
            if (wakeClosed || wakeWrite == null) return;
            try {
                Os.write(wakeWrite, WAKE_BYTE, 0, WAKE_BYTE.length);
            } catch (ErrnoException | InterruptedIOException ignored) {
                // The reader is already on its way out.
            }
        }
    }

    @Override
    public void run() {
        try {
            if (!running) return;
            Log.i(TAG, "raw finger fallback listening on " + devicePath);
            readLoop(device);
        } catch (Exception e) {
            if (running) {
                Log.e(TAG, "raw finger fallback stopped: " + e.getMessage(), e);
            }
        } finally {
            boolean unexpected = running;
            running = false;
            if (instance == this) {
                health.stopped();
                if (unexpected) emitStopped();
            }
            closeQuietly(device);
            synchronized (wakeLock) {
                wakeClosed = true;
                closeQuietly(wakeRead);
                closeQuietly(wakeWrite);
                wakeRead = null;
                wakeWrite = null;
            }
            Log.i(TAG, "raw finger fallback released " + devicePath);
        }
    }

    private void readLoop(FileDescriptor device) throws ErrnoException, InterruptedIOException {
        StructPollfd devicePoll = new StructPollfd();
        devicePoll.fd = device;
        devicePoll.events = (short) OsConstants.POLLIN;
        StructPollfd wakePoll = new StructPollfd();
        wakePoll.fd = wakeRead;
        wakePoll.events = (short) OsConstants.POLLIN;
        StructPollfd[] watched = {devicePoll, wakePoll};

        byte[] event = new byte[INPUT_EVENT_BYTES];
        int filled = 0;
        while (running) {
            if (!awaitReadable(watched, devicePoll, wakePoll)) return;
            int count;
            try {
                count = Os.read(device, event, filled, INPUT_EVENT_BYTES - filled);
            } catch (ErrnoException e) {
                if (e.errno == OsConstants.EINTR || e.errno == OsConstants.EAGAIN) continue;
                throw e;
            }
            if (count <= 0) return;
            // evdev hands over whole records, but a short read still has to be
            // carried rather than parsed: half a record decodes as garbage.
            filled += count;
            if (filled < INPUT_EVENT_BYTES) continue;
            filled = 0;
            int type = unsignedShort(event, 16);
            int code = unsignedShort(event, 18);
            int value = signedInt(event, 20);
            input.process(type, code, value, SystemClock.uptimeMillis());
        }
    }

    /** True when the device has a record waiting, false when it is time to stop. */
    private boolean awaitReadable(
            StructPollfd[] watched, StructPollfd devicePoll, StructPollfd wakePoll)
            throws ErrnoException {
        int failed = OsConstants.POLLERR | OsConstants.POLLHUP | OsConstants.POLLNVAL;
        while (running) {
            try {
                Os.poll(watched, -1);
            } catch (ErrnoException e) {
                if (e.errno == OsConstants.EINTR) continue;
                throw e;
            }
            // The wake pipe is checked first: a stop that lands in the same
            // frame as a touch should end the thread, not publish one more tap.
            if ((wakePoll.revents & OsConstants.POLLIN) != 0) return false;
            if ((devicePoll.revents & OsConstants.POLLIN) != 0) return true;
            if ((devicePoll.revents & failed) != 0) return false;
        }
        return false;
    }

    @SuppressWarnings("deprecation")
    private boolean noteInFront() {
        try {
            ActivityManager manager = (ActivityManager) reactContext
                    .getSystemService(Context.ACTIVITY_SERVICE);
            List<ActivityManager.RunningTaskInfo> tasks = manager.getRunningTasks(1);
            ComponentName top = tasks.isEmpty() ? null : tasks.get(0).topActivity;
            return top != null && "com.ratta.supernote.note".equals(top.getPackageName())
                    && "com.ratta.supernote.note.view.NoteInsidePagesActivity".equals(top.getClassName());
        } catch (Exception ignored) { return false; }
    }

    private void captureDown(double x, double y, long downTime) {
        RawDownState state = new RawDownState(noteInFront());
        downStates.put(downTime, state);
        while (downStates.size() > 32) downStates.remove(downStates.keySet().iterator().next());
        if (!state.noteInFront) { state.complete(null); return; }
        try {
            NoteUiGuard.inspect((float) x, (float) y, state::complete);
        } catch (Exception ignored) { state.complete(null); }
    }

    private void emitTap(double screenX, double screenY, long downTime,
            long eventTime, int touchMajor) {
        RawDownState down = downStates.remove(downTime);
        if (down == null) return;
        down.dispatch(() -> publishTap(screenX, screenY, downTime, eventTime, touchMajor, down));
    }

    private void publishTap(double screenX, double screenY, long downTime,
            long eventTime, int touchMajor, RawDownState down) {
        if (!running || !down.noteInFront || down.blocked) return;
        DisplayMetrics metrics = new DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        if (!RawFingerInput.supports("pt_mt", metrics.widthPixels, metrics.heightPixels,
                windowManager.getDefaultDisplay().getRotation())) return;
        WritableMap event = Arguments.createMap();
        event.putDouble("x", screenX);
        event.putDouble("y", screenY);
        event.putDouble("durationMs", eventTime - downTime);
        event.putDouble("downTime", downTime);
        event.putDouble("eventTime", eventTime);
        event.putInt("touchMajor", touchMajor);
        event.putBoolean("noteInFrontAtDown", down.noteInFront);
        event.putBoolean("uiBlockedAtDown", down.blocked);
        event.putInt("uiRevisionAtDown", down.revision);
        try {
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(EVENT_TAP, event);
        } catch (Exception e) {
            Log.e(TAG, "raw finger tap emit failed: " + e.getMessage(), e);
        }
    }

    private void emitRejected(long downTime, long eventTime, String reason) {
        rejectedContacts.record(downTime, eventTime);
        WritableMap event = Arguments.createMap();
        event.putDouble("downTime", downTime);
        event.putDouble("eventTime", eventTime);
        event.putString("reason", reason);
        try {
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(EVENT_REJECTED, event);
        } catch (Exception e) {
            Log.e(TAG, "raw contact rejection emit failed: " + e.getMessage(), e);
        }
    }

    private void emitStopped() {
        try {
            WritableMap event = Arguments.createMap();
            event.putBoolean("supported", true);
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(EVENT_STOPPED, event);
        } catch (Exception ignored) { /* React may already be shutting down. */ }
    }

    private static void closeQuietly(FileDescriptor descriptor) {
        if (descriptor == null || !descriptor.valid()) return;
        try {
            Os.close(descriptor);
        } catch (ErrnoException ignored) {
            // Nothing useful is left to do with a descriptor that will not close.
        }
    }

    private static int unsignedShort(byte[] source, int offset) {
        return (source[offset] & 0xff) | ((source[offset + 1] & 0xff) << 8);
    }

    private static int signedInt(byte[] source, int offset) {
        return (source[offset] & 0xff)
                | ((source[offset + 1] & 0xff) << 8)
                | ((source[offset + 2] & 0xff) << 16)
                | (source[offset + 3] << 24);
    }
}
