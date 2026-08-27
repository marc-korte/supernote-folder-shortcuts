package com.supernotefoldershortcuts;

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

import java.io.FileDescriptor;
import java.io.InterruptedIOException;

/** Reads only tap-sized finger gestures from the firmware's evdev stream. */
final class RawFingerTapMonitor implements Runnable {
    static final String EVENT_TAP = "folderLinkRawFingerTap";

    private static final String TAG = "[folder-link-native]";
    private static final int INPUT_EVENT_BYTES = 24;
    private static final int SLOT_COUNT = 32;
    private static final int EV_SYN = 0;
    private static final int EV_ABS = 3;
    private static final int SYN_REPORT = 0;
    private static final int ABS_MT_SLOT = 0x2f;
    private static final int ABS_MT_POSITION_X = 0x35;
    private static final int ABS_MT_POSITION_Y = 0x36;
    private static final int ABS_MT_TRACKING_ID = 0x39;
    private static final long TAP_MAX_DURATION_MS = 800;
    private static final int TAP_MAX_MOVEMENT_RAW = 60;
    private static final byte[] WAKE_BYTE = {1};

    private static RawFingerTapMonitor instance;

    private volatile ReactApplicationContext reactContext;
    private final String devicePath;
    private final int displayWidth;
    private final int displayHeight;
    private final boolean[] active = new boolean[SLOT_COUNT];
    private final boolean[] eligible = new boolean[SLOT_COUNT];
    private final boolean[] pendingUp = new boolean[SLOT_COUNT];
    private final int[] rawX = new int[SLOT_COUNT];
    private final int[] rawY = new int[SLOT_COUNT];
    private final int[] startX = new int[SLOT_COUNT];
    private final int[] startY = new int[SLOT_COUNT];
    private final long[] downAt = new long[SLOT_COUNT];

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

    private int slot;

    private RawFingerTapMonitor(ReactApplicationContext context, String path) {
        reactContext = context;
        devicePath = path;
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windowManager =
                (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        displayWidth = metrics.widthPixels;
        displayHeight = metrics.heightPixels;
        initializeSlots();
    }

    static synchronized void ensureStarted(ReactApplicationContext context, String path) {
        if (instance != null && instance.running && instance.devicePath.equals(path)) {
            instance.reactContext = context;
            return;
        }
        if (instance != null) instance.stop();
        instance = new RawFingerTapMonitor(context, path);
        Thread thread = new Thread(instance, "folder-link-raw-finger");
        thread.setDaemon(true);
        thread.start();
    }

    static synchronized void stopForContext(ReactApplicationContext context) {
        if (instance != null && instance.reactContext == context) {
            instance.stop();
            instance = null;
        }
    }

    private void stop() {
        running = false;
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
        FileDescriptor device = null;
        try {
            // Armed before the device is opened so a stop() racing startup
            // always has something to write to. pipe2 is not in the public SDK,
            // so these two carry no O_CLOEXEC; nothing here execs, and both ends
            // are closed in the finally below.
            FileDescriptor[] wake = Os.pipe();
            synchronized (wakeLock) {
                wakeRead = wake[0];
                wakeWrite = wake[1];
            }
            device = Os.open(devicePath, OsConstants.O_RDONLY | OsConstants.O_CLOEXEC, 0);
            if (!running) return;
            Log.i(TAG, "raw finger fallback listening on " + devicePath);
            readLoop(device);
        } catch (Exception e) {
            if (running) {
                Log.e(TAG, "raw finger fallback stopped: " + e.getMessage(), e);
            }
        } finally {
            running = false;
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
            process(type, code, value);
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

    private void process(int type, int code, int value) {
        if (type == EV_ABS) {
            if (code == ABS_MT_SLOT) {
                if (value >= 0 && value < SLOT_COUNT) slot = value;
                return;
            }
            if (code == ABS_MT_TRACKING_ID) {
                if (value >= 0) begin(slot);
                else pendingUp[slot] = true;
                return;
            }
            if (code == ABS_MT_POSITION_X) {
                rawX[slot] = value;
                rejectMoved(slot);
                return;
            }
            if (code == ABS_MT_POSITION_Y) {
                rawY[slot] = value;
                rejectMoved(slot);
            }
            return;
        }
        if (type == EV_SYN && code == SYN_REPORT) finishFrame();
    }

    private void begin(int targetSlot) {
        boolean anotherFinger = activeCount() > 0;
        if (anotherFinger) {
            for (int index = 0; index < SLOT_COUNT; index++) {
                if (active[index]) eligible[index] = false;
            }
        }
        active[targetSlot] = true;
        eligible[targetSlot] = !anotherFinger;
        pendingUp[targetSlot] = false;
        startX[targetSlot] = -1;
        startY[targetSlot] = -1;
        downAt[targetSlot] = SystemClock.uptimeMillis();
    }

    private void finishFrame() {
        long now = SystemClock.uptimeMillis();
        for (int index = 0; index < SLOT_COUNT; index++) {
            if (active[index] && startX[index] < 0 && rawX[index] >= 0 && rawY[index] >= 0) {
                startX[index] = rawX[index];
                startY[index] = rawY[index];
            }
        }
        for (int index = 0; index < SLOT_COUNT; index++) {
            if (!pendingUp[index]) continue;
            if (isTap(index, now)) {
                emitTap(rawX[index], rawY[index], now - downAt[index]);
            }
            clearSlot(index);
        }
    }

    private boolean isTap(int index, long now) {
        return active[index]
                && eligible[index]
                && rawX[index] >= 0
                && rawY[index] >= 0
                && startX[index] >= 0
                && startY[index] >= 0
                && now - downAt[index] <= TAP_MAX_DURATION_MS
                && movementSquared(index)
                <= TAP_MAX_MOVEMENT_RAW * TAP_MAX_MOVEMENT_RAW;
    }

    private void rejectMoved(int index) {
        if (active[index]
                && startX[index] >= 0
                && startY[index] >= 0
                && movementSquared(index)
                > TAP_MAX_MOVEMENT_RAW * TAP_MAX_MOVEMENT_RAW) {
            eligible[index] = false;
        }
    }

    private int movementSquared(int index) {
        int dx = rawX[index] - startX[index];
        int dy = rawY[index] - startY[index];
        return dx * dx + dy * dy;
    }

    private int activeCount() {
        int count = 0;
        for (boolean value : active) if (value) count++;
        return count;
    }

    private void emitTap(int touchX, int touchY, long durationMs) {
        int rawMaxX = Math.max(displayWidth, displayHeight) - 1;
        int rawMaxY = Math.min(displayWidth, displayHeight) - 1;
        double screenX = touchX * (double) displayWidth / Math.max(1, rawMaxX);
        double screenY = touchY * (double) displayHeight / Math.max(1, rawMaxY);
        WritableMap event = Arguments.createMap();
        event.putDouble("x", screenX);
        event.putDouble("y", screenY);
        event.putDouble("durationMs", durationMs);
        try {
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(EVENT_TAP, event);
        } catch (Exception e) {
            Log.e(TAG, "raw finger tap emit failed: " + e.getMessage(), e);
        }
    }

    private void initializeSlots() {
        for (int index = 0; index < SLOT_COUNT; index++) {
            rawX[index] = -1;
            rawY[index] = -1;
            clearSlot(index);
        }
    }

    private void clearSlot(int index) {
        active[index] = false;
        eligible[index] = false;
        pendingUp[index] = false;
        // Keep the last absolute coordinates. The touchscreen suppresses an
        // axis when its value did not change, so the next DOWN may need the
        // coordinate from a previous frame to form a complete point.
        startX[index] = -1;
        startY[index] = -1;
        downAt[index] = 0;
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
