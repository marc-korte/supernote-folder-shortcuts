package com.supernotefoldershortcuts;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityNodeInfo;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.List;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** Reads the note's actual view layers; raw motion alone cannot see popups. */
final class NoteUiGuard {
    private static final String TAG = "[folder-link-native]";
    private static final long INSPECTION_TIMEOUT_MS = 750;
    private static final Object LOCK = new Object();
    private static NoteUiGuard instance;
    private static boolean active;

    static final class Snapshot {
        final boolean blocked;
        final int revision;

        Snapshot(boolean blocked, int revision) {
            this.blocked = blocked;
            this.revision = revision;
        }
    }

    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "folder-link-note-ui");
        thread.setDaemon(true);
        return thread;
    });
    private final HandlerThread callbacks = new HandlerThread("folder-link-ui-callbacks");
    private final Handler deadlines;
    private final NoteUiPolicy.History history = new NoteUiPolicy.History();
    private final List<Request> requests = new ArrayList<>();
    private volatile int revision;
    private long lastWarning;
    private UiAutomation automation;
    private Object connection;
    private volatile boolean closed;
    private final AtomicBoolean eventRefreshQueued = new AtomicBoolean();
    private float lastX;
    private float lastY;

    private NoteUiGuard() {
        callbacks.start();
        deadlines = new Handler(callbacks.getLooper());
    }

    private final class Request {
        final Consumer<Snapshot> callback;
        final AtomicBoolean completed = new AtomicBoolean();
        final Runnable timeout = () -> complete(new Snapshot(true, revision));

        Request(Consumer<Snapshot> callback) { this.callback = callback; }

        void complete(Snapshot snapshot) {
            if (!completed.compareAndSet(false, true)) return;
            deadlines.removeCallbacks(timeout);
            callback.accept(snapshot);
        }
    }

    static void setActive(boolean enabled) {
        synchronized (LOCK) {
            if (!enabled) {
                shutdown();
                return;
            }
            active = true;
            if (instance == null) {
                instance = new NoteUiGuard();
                NoteUiGuard guard = instance;
                // Observe popup-open events before the first dismissing tap.
                guard.worker.execute(() -> guard.read(0, 0));
            }
        }
    }

    static void inspect(float x, float y, Consumer<Snapshot> callback) {
        synchronized (LOCK) {
            if (!active || instance == null) {
                callback.accept(new Snapshot(true, 0));
                return;
            }
            NoteUiGuard guard = instance;
            // One executing request and one waiting request bound both native
            // work and callbacks during rapid handwriting or a stalled binder.
            if (guard.requests.size() >= 2) {
                callback.accept(new Snapshot(true, guard.revision));
                return;
            }
            Request request = guard.new Request(callback);
            guard.requests.add(request);
            guard.deadlines.postDelayed(request.timeout, INSPECTION_TIMEOUT_MS);
            guard.worker.execute(() -> {
                try {
                    if (request.completed.get()) return;
                    guard.lastX = x;
                    guard.lastY = y;
                    request.complete(guard.read(x, y));
                } finally {
                    synchronized (LOCK) { guard.requests.remove(request); }
                }
            });
        }
    }

    static void shutdown() {
        synchronized (LOCK) {
            active = false;
            if (instance == null) return;
            NoteUiGuard guard = instance;
            instance = null;
            guard.closed = true;
            for (Request request : new ArrayList<>(guard.requests)) {
                request.complete(new Snapshot(true, guard.revision));
            }
            guard.worker.execute(() -> {
                guard.disconnect();
                guard.callbacks.quitSafely();
            });
            guard.worker.shutdown();
        }
    }

    private Snapshot read(float x, float y) {
        try {
            if (closed) return new Snapshot(true, revision);
            ensureConnected();
            AccessibilityNodeInfo root = automation.getRootInActiveWindow();
            NoteUiPolicy.Node tree;
            try {
                if (root == null || !NoteUiPolicy.PACKAGE.contentEquals(root.getPackageName())) {
                    throw new IllegalStateException("active window is not the note page");
                }
                List<AccessibilityNodeInfo> pages = root.findAccessibilityNodeInfosByViewId(
                        NoteUiPolicy.PREFIX + "noteInsidePages");
                try {
                    if (pages.size() != 1) throw new IllegalStateException("note page is unavailable");
                    Rect bounds = new Rect();
                    pages.get(0).getBoundsInScreen(bounds);
                    tree = copy(pages.get(0), new int[] {0}, 0, bounds);
                } finally {
                    for (AccessibilityNodeInfo page : pages) page.recycle();
                }
            } finally {
                if (root != null) root.recycle();
            }
            NoteUiPolicy.Result result = NoteUiPolicy.evaluate(tree, x, y);
            NoteUiPolicy.Decision decision = history.apply(result, SystemClock.uptimeMillis());
            revision = decision.revision;
            return new Snapshot(decision.blocked, revision);
        } catch (Exception error) {
            long now = SystemClock.uptimeMillis();
            if (now - lastWarning > 10000) {
                Log.w(TAG, "note UI inspection unavailable: " + error);
                lastWarning = now;
            }
            // An inaccessible or changing tree cannot prove that paper is
            // receiving this touch. Never fall back to the last armed links.
            disconnect();
            revision = history.invalidate();
            return new Snapshot(true, revision);
        }
    }

    private void ensureConnected() throws Exception {
        if (automation != null) return;
        Class<?> connectionType = Class.forName("android.app.IUiAutomationConnection");
        Class<?> implementation = Class.forName("android.app.UiAutomationConnection");
        connection = implementation.getDeclaredConstructor().newInstance();
        Constructor<?> constructor = UiAutomation.class.getDeclaredConstructor(Looper.class, connectionType);
        constructor.setAccessible(true);
        automation = (UiAutomation) constructor.newInstance(callbacks.getLooper(), connection);
        Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
        connect.setAccessible(true);
        // The host has system UID. Keep existing accessibility services active
        // and observe content changes so a fast dismissing UP cannot erase the
        // evidence that its DOWN landed on a popup. Released on teardown, or
        // when the active root leaves the note.
        connect.invoke(automation, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS |
                AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        automation.setServiceInfo(info);
        automation.setOnAccessibilityEventListener(event -> queueEventRefresh());
    }

    private void queueEventRefresh() {
        if (closed || !eventRefreshQueued.compareAndSet(false, true)) return;
        try {
            worker.execute(() -> {
                eventRefreshQueued.set(false);
                if (!closed && automation != null) read(lastX, lastY);
            });
        } catch (RejectedExecutionException ignored) {
            eventRefreshQueued.set(false);
        }
    }

    private void disconnect() {
        UiAutomation previous = automation;
        Object previousConnection = connection;
        automation = null;
        connection = null;
        if (previous == null && previousConnection == null) return;
        try {
            if (previous != null) {
                previous.setOnAccessibilityEventListener(null);
                Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
                disconnect.setAccessible(true);
                disconnect.invoke(previous);
            }
        } catch (Exception error) {
            // connect may have registered the service before its callback
            // timed out. Release the underlying connection in that case too.
            try {
                if (previousConnection != null) {
                    previousConnection.getClass().getMethod("disconnect").invoke(previousConnection);
                }
            } catch (Exception cleanupError) {
                Log.w(TAG, "note UI inspection disconnect failed: " + cleanupError);
            }
        }
    }

    private static NoteUiPolicy.Node copy(
            AccessibilityNodeInfo source, int[] count, int depth, Rect pageBounds) {
        if (source == null) throw new IllegalStateException("note UI root is unavailable");
        if (++count[0] > 2000 || depth > 50) {
            throw new IllegalStateException("note UI tree exceeds snapshot bounds");
        }
        Rect bounds = new Rect();
        source.getBoundsInScreen(bounds);
        NoteUiPolicy.Node result = new NoteUiPolicy.Node(source.getViewIdResourceName(),
                source.getPackageName() == null ? null : source.getPackageName().toString(),
                source.getClassName() == null ? null : source.getClassName().toString(),
                bounds.left, bounds.top, bounds.right, bounds.bottom, source.isVisibleToUser());
        // Partial branches are already complete blocked regions. Descending
        // into every toolbar icon adds many remote IPC round trips without
        // changing the decision. The drawing canvas itself needs no UI scan.
        if (!bounds.equals(pageBounds) || result.id.equals(NoteUiPolicy.PREFIX + "noteViewContainer")) {
            return result;
        }
        for (int index = 0; index < source.getChildCount(); index++) {
            AccessibilityNodeInfo child = source.getChild(index);
            try {
                result.children.add(copy(child, count, depth + 1, pageBounds));
            } finally {
                if (child != null) child.recycle();
            }
        }
        return result;
    }
}
