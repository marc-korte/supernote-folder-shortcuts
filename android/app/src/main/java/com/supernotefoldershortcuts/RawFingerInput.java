package com.supernotefoldershortcuts;

/** Tap recognition for the one raw panel/orientation verified on hardware. */
final class RawFingerInput {
    static final int MAX_TOUCH_MAJOR = 255;
    private static final int SLOT_COUNT = 32;
    private static final int RAW_MAX_X = 2559;
    private static final int RAW_MAX_Y = 1919;
    private static final long TAP_MAX_DURATION_MS = 300;
    private static final int TAP_MAX_MOVEMENT_PX = 25;

    interface TapSink {
        void onTap(double x, double y, long downTime, long eventTime, int touchMajor);
        default void onDown(double x, double y, long downTime) {}
        default void onRejected(long downTime, long eventTime, String reason) {}
    }

    /** A verified panel needs a live reader; unsupported panels retain SDK input. */
    static final class MonitorHealth {
        private boolean expected;
        private boolean ready;
        synchronized void configure(boolean supported) { expected = supported; ready = false; }
        synchronized void opened() { ready = true; }
        synchronized void stopped() { ready = false; }
        synchronized boolean allowsValidation() { return !expected || ready; }
    }

    /** Shared native record closes the SDK/raw callback ordering race. */
    static final class Rejections {
        private final long[][] spans = new long[32][2];
        private int next;
        private int count;

        synchronized void record(long downTime, long eventTime) {
            for (int index = 0; index < count; index++) {
                if (spans[index][0] == downTime) {
                    spans[index][1] = Math.max(spans[index][1], eventTime);
                    return;
                }
            }
            spans[next][0] = downTime;
            spans[next][1] = eventTime;
            next = (next + 1) % spans.length;
            count = Math.min(count + 1, spans.length);
        }

        synchronized boolean contains(long downTime, long eventTime, long now) {
            if (downTime < 0 || eventTime < downTime) return true;
            for (int index = 0; index < count; index++) {
                long start = spans[index][0];
                long end = spans[index][1];
                if (now - end <= 5000 && downTime <= end + 50 && eventTime >= start - 50) {
                    return true;
                }
            }
            return false;
        }
    }

    private final TapSink sink;
    private final boolean[] active = new boolean[SLOT_COUNT];
    private final boolean[] eligible = new boolean[SLOT_COUNT];
    private final boolean[] pendingUp = new boolean[SLOT_COUNT];
    private final int[] rawX = new int[SLOT_COUNT];
    private final int[] rawY = new int[SLOT_COUNT];
    private final int[] startX = new int[SLOT_COUNT];
    private final int[] startY = new int[SLOT_COUNT];
    private final int[] touchMajor = new int[SLOT_COUNT];
    private final int[] peakTouchMajor = new int[SLOT_COUNT];
    private final int[] toolType = new int[SLOT_COUNT];
    private final String[] rejectionReason = new String[SLOT_COUNT];
    private final long[] downAt = new long[SLOT_COUNT];
    private int slot;

    RawFingerInput(TapSink sink) {
        this.sink = sink;
        for (int index = 0; index < SLOT_COUNT; index++) {
            rawX[index] = -1;
            rawY[index] = -1;
            startX[index] = -1;
            startY[index] = -1;
        }
    }

    /**
     * The host's other panels need mirroring and/or axis swaps. Never infer
     * their mapping from the display aspect ratio or Android model string.
     * Rotation 0 and this exact panel/display pair are the measured Manta case.
     */
    static boolean supports(String panelName, int width, int height, int rotation) {
        return "pt_mt".equals(panelName)
                && width == 1920 && height == 2560 && rotation == 0;
    }

    void process(int type, int code, int value, long now) {
        if (type == 3) { // EV_ABS
            if (code == 0x2f) { // ABS_MT_SLOT
                // An unsupported slot must not redirect its events to the last
                // valid finger, which could fabricate a tap when it lifts.
                slot = value >= 0 && value < SLOT_COUNT ? value : -1;
                return;
            }
            if (slot < 0) return;
            if (code == 0x39) { // ABS_MT_TRACKING_ID
                if (value >= 0) begin(slot, now);
                else pendingUp[slot] = true;
            } else if (code == 0x35) { // ABS_MT_POSITION_X
                rawX[slot] = value;
                rejectMoved(slot);
            } else if (code == 0x36) { // ABS_MT_POSITION_Y
                rawY[slot] = value;
                rejectMoved(slot);
            } else if (code == 0x30) { // ABS_MT_TOUCH_MAJOR
                touchMajor[slot] = value;
                if (active[slot]) {
                    peakTouchMajor[slot] = Math.max(peakTouchMajor[slot], value);
                    if (value < 0 || value > MAX_TOUCH_MAJOR) rejectContact(slot, now, "contact-size");
                }
            } else if (code == 0x37) { // ABS_MT_TOOL_TYPE: 0 finger, 1 pen, 2 palm
                toolType[slot] = value;
                if (active[slot] && value != 0) rejectContact(slot, now, "tool-type");
            }
        } else if (type == 0 && code == 0) { // EV_SYN / SYN_REPORT
            finishFrame(now);
        } else if (type == 0 && code == 3) { // SYN_DROPPED: state is no longer reliable
            for (int index = 0; index < SLOT_COUNT; index++) eligible[index] = false;
        }
    }

    private void begin(int index, long now) {
        boolean anotherFinger = false;
        for (int other = 0; other < SLOT_COUNT; other++) {
            if (active[other]) {
                eligible[other] = false;
                anotherFinger = true;
            }
        }
        active[index] = true;
        eligible[index] = !anotherFinger;
        pendingUp[index] = false;
        startX[index] = -1;
        startY[index] = -1;
        peakTouchMajor[index] = 0;
        rejectionReason[index] = null;
        downAt[index] = now;
    }

    private void finishFrame(long now) {
        for (int index = 0; index < SLOT_COUNT; index++) {
            if (!active[index]) continue;
            // Absolute values can be omitted when unchanged. Sample their
            // retained values after the whole DOWN frame, so metadata left by
            // an earlier palm does not reject a new fingertip before its new
            // size/tool values have arrived.
            peakTouchMajor[index] = Math.max(peakTouchMajor[index], touchMajor[index]);
            if (touchMajor[index] < 0 || touchMajor[index] > MAX_TOUCH_MAJOR) {
                rejectContact(index, now, "contact-size");
            }
            if (toolType[index] != 0) rejectContact(index, now, "tool-type");
            if (startX[index] < 0 && rawX[index] >= 0 && rawY[index] >= 0) {
                startX[index] = rawX[index];
                startY[index] = rawY[index];
                sink.onDown(rawX[index] * 1920.0 / RAW_MAX_X,
                        rawY[index] * 2560.0 / RAW_MAX_Y, downAt[index]);
            }
            if (!pendingUp[index]) continue;
            if (rejectionReason[index] != null) {
                sink.onRejected(downAt[index], now, rejectionReason[index]);
            }
            if (isTap(index, now)) {
                sink.onTap(rawX[index] * 1920.0 / RAW_MAX_X,
                        rawY[index] * 2560.0 / RAW_MAX_Y,
                        downAt[index], now, peakTouchMajor[index]);
            }
            active[index] = false;
            eligible[index] = false;
            pendingUp[index] = false;
        }
    }

    private void rejectContact(int index, long now, String reason) {
        eligible[index] = false;
        if (rejectionReason[index] == null) {
            rejectionReason[index] = reason;
            // Inform the SDK path too: its payload may label a palm as finger
            // and omit contact size. The final UP extends this rejected span.
            sink.onRejected(downAt[index], now, reason);
        }
    }

    private boolean isTap(int index, long now) {
        return eligible[index]
                && rawX[index] >= 0 && rawX[index] <= RAW_MAX_X
                && rawY[index] >= 0 && rawY[index] <= RAW_MAX_Y
                && startX[index] >= 0 && startY[index] >= 0
                && now >= downAt[index] && now - downAt[index] <= TAP_MAX_DURATION_MS
                && movementSquared(index) <= TAP_MAX_MOVEMENT_PX * TAP_MAX_MOVEMENT_PX;
    }

    private void rejectMoved(int index) {
        if (active[index] && startX[index] >= 0 && startY[index] >= 0
                && movementSquared(index) > TAP_MAX_MOVEMENT_PX * TAP_MAX_MOVEMENT_PX) {
            eligible[index] = false;
        }
    }

    private double movementSquared(int index) {
        // Raw axes have different scales on pt_mt. Use the same 25 screen
        // pixel radius as the SDK path, including diagonal movement, rather
        // than letting a raw Y drag become a stationary synthetic tap.
        double dx = ((double) rawX[index] - startX[index]) * 1920 / RAW_MAX_X;
        double dy = ((double) rawY[index] - startY[index]) * 2560 / RAW_MAX_Y;
        return dx * dx + dy * dy;
    }
}
