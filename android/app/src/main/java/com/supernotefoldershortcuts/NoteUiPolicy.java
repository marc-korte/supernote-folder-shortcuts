package com.supernotefoldershortcuts;

import java.util.ArrayList;
import java.util.List;

/** Plain snapshot policy, kept independent of Android for regression tests. */
final class NoteUiPolicy {
    static final String PACKAGE = "com.ratta.supernote.note";
    static final String PREFIX = PACKAGE + ":id/";

    static final class Node {
        final String id;
        final String packageName;
        final String className;
        final int left, top, right, bottom;
        final boolean visible;
        final List<Node> children = new ArrayList<>();

        Node(String id, String packageName, String className,
                int left, int top, int right, int bottom, boolean visible) {
            this.id = id == null ? "" : id;
            this.packageName = packageName;
            this.className = className == null ? "" : className;
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
            this.visible = visible;
        }

        boolean contains(float x, float y) {
            return x >= left && x < right && y >= top && y < bottom;
        }

        boolean empty() { return right <= left || bottom <= top; }
    }

    static final class Result {
        final boolean blocked;
        final boolean popupVisible;
        final int signature;

        Result(boolean blocked, boolean popupVisible, int signature) {
            this.blocked = blocked;
            this.popupVisible = popupVisible;
            this.signature = signature;
        }
    }

    static final class History {
        private boolean hasSignature;
        private int signature;
        private int revision;
        private long popupUntil;
        private boolean popupWasVisible;

        int invalidate() {
            hasSignature = false;
            return ++revision;
        }

        Decision apply(Result result, long now) {
            if (!hasSignature || signature != result.signature) {
                revision++;
                signature = result.signature;
                hasSignature = true;
            }
            if (result.popupVisible || popupWasVisible) popupUntil = now + 1500;
            popupWasVisible = result.popupVisible;
            return new Decision(result.blocked || now < popupUntil, revision);
        }
    }

    static final class Decision {
        final boolean blocked;
        final int revision;

        Decision(boolean blocked, int revision) {
            this.blocked = blocked;
            this.revision = revision;
        }
    }

    private NoteUiPolicy() {}

    static Result evaluate(Node root, float x, float y) {
        int signature = signature(root);
        if (root == null || !PACKAGE.equals(root.packageName) ||
                Float.isNaN(x) || Float.isNaN(y) || Float.isInfinite(x) || Float.isInfinite(y)) {
            return new Result(true, true, signature);
        }
        Node page = find(root, PREFIX + "noteInsidePages");
        Node canvas = page == null ? null : find(page, PREFIX + "noteViewContainer");
        if (canvas == null || canvas.empty() || !canvas.contains(x, y)) {
            return new Result(true, true, signature);
        }
        boolean blocked = false;
        boolean popup = false;
        boolean sawCanvas = false;
        for (Node child : page.children) {
            if (!child.visible || child.empty()) continue;
            if (child == canvas) {
                sawCanvas = true;
                continue;
            }
            if (child.id.equals(PREFIX + "sidebarView")) {
                Result sidebar = sidebar(child, canvas, x, y, false);
                blocked |= sidebar.blocked;
                popup |= sidebar.popupVisible;
            } else if (isEmptyLayer(child)) {
                // The stock note keeps these full-screen containers visible
                // even when empty. Any child means an editor/dialog/overlay.
                if (hasVisibleChildren(child)) popup = true;
            } else {
                // A new firmware layer must be classified before its touches
                // can be treated as taps on the paper beneath it.
                popup = true;
            }
        }
        return new Result(!sawCanvas || blocked || popup, popup, signature);
    }

    private static boolean isEmptyLayer(Node node) {
        return node.id.equals(PREFIX + "pluginContainer") ||
                node.id.equals(PREFIX + "noteTipContainer") ||
                node.id.equals(PREFIX + "noteTextContainer") ||
                node.id.equals(PREFIX + "rl_progress");
    }

    private static boolean hasVisibleChildren(Node node) {
        for (Node child : node.children) {
            if (child.visible && !child.empty()) return true;
        }
        return false;
    }

    private static Result sidebar(Node node, Node canvas, float x, float y, boolean chrome) {
        if (!node.visible || node.empty()) return new Result(false, false, 0);
        boolean full = node.left == canvas.left && node.top == canvas.top &&
                node.right == canvas.right && node.bottom == canvas.bottom;
        boolean normalChrome = !full && isChromeStrip(node, canvas);
        boolean popup = !full && !chrome && !normalChrome;
        boolean blocked = !full && node.contains(x, y);
        // An edge alone does not identify chrome: menus may also touch it.
        // Only the stock narrow toolbar/pagebar strips exempt their inset
        // icon children. Other branches block even outside dismissal taps.
        boolean childChrome = chrome || normalChrome;
        if (full && !node.className.endsWith("Layout")) popup = true;
        for (Node child : node.children) {
            Result result = sidebar(child, canvas, x, y, childChrome);
            blocked |= result.blocked;
            popup |= result.popupVisible;
        }
        return new Result(blocked || popup, popup, 0);
    }

    private static boolean isChromeStrip(Node node, Node canvas) {
        // The toolbar's accessibility container has no resource ID. The
        // pagebar does. Unknown named panels must not impersonate either.
        if ((!node.id.isEmpty() && !node.id.equals(PREFIX + "side_pageBar")) ||
                !node.className.endsWith("Layout")) return false;
        long width = (long) node.right - node.left;
        long height = (long) node.bottom - node.top;
        long pageWidth = (long) canvas.right - canvas.left;
        long pageHeight = (long) canvas.bottom - canvas.top;
        boolean vertical = node.top == canvas.top && node.bottom == canvas.bottom &&
                (node.left == canvas.left || node.right == canvas.right) && width * 8 <= pageWidth;
        boolean horizontal = node.left == canvas.left && node.right == canvas.right &&
                (node.top == canvas.top || node.bottom == canvas.bottom) && height * 8 <= pageHeight;
        return vertical || horizontal;
    }

    private static Node find(Node root, String id) {
        if (root == null || !root.visible) return null;
        if (root.id.equals(id)) return root;
        for (Node child : root.children) {
            Node match = find(child, id);
            if (match != null) return match;
        }
        return null;
    }

    private static int signature(Node node) {
        if (node == null || !node.visible) return 0;
        int hash = node.id.hashCode();
        hash = hash * 31 + node.left;
        hash = hash * 31 + node.top;
        hash = hash * 31 + node.right;
        hash = hash * 31 + node.bottom;
        for (Node child : node.children) hash = hash * 31 + signature(child);
        return hash;
    }
}
