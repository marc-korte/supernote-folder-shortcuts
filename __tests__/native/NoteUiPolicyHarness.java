package com.supernotefoldershortcuts;

public final class NoteUiPolicyHarness {
    private static NoteUiPolicy.Node node(String id, int l, int t, int r, int b) {
        return new NoteUiPolicy.Node(id.isEmpty() ? "" : NoteUiPolicy.PREFIX + id,
                NoteUiPolicy.PACKAGE, "android.widget.RelativeLayout", l, t, r, b, true);
    }

    private static NoteUiPolicy.Node baseline() {
        // Shape captured from the Manta's accessibility hierarchy: empty
        // full-screen layers, a full-screen sidebar wrapper, an unnamed
        // 116-pixel vertical toolbar, and the named 116-pixel bottom pagebar.
        NoteUiPolicy.Node page = node("noteInsidePages", 0, 0, 1920, 2560);
        page.children.add(node("pluginContainer", 0, 0, 1920, 2560));
        page.children.add(node("noteTipContainer", 0, 0, 1920, 2560));
        page.children.add(node("noteTextContainer", 0, 0, 1920, 2560));
        page.children.add(node("noteViewContainer", 0, 0, 1920, 2560));
        page.children.add(node("rl_progress", 0, 0, 1920, 2560));
        NoteUiPolicy.Node sidebar = node("sidebarView", 0, 0, 1920, 2560);
        NoteUiPolicy.Node toolbar = node("", 1804, 0, 1920, 2560);
        toolbar.children.add(node("iv_button", 1830, 40, 1893, 103));
        sidebar.children.add(toolbar);
        sidebar.children.add(node("side_pageBar", 0, 2444, 1920, 2560));
        page.children.add(sidebar);
        return page;
    }

    private static NoteUiPolicy.Node sidebar(NoteUiPolicy.Node page) {
        return page.children.get(page.children.size() - 1);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        NoteUiPolicy.Node page = baseline();
        switch (args[0]) {
            case "paper":
                require(!NoteUiPolicy.evaluate(page, 500, 500).blocked,
                        "visible empty layers and inset toolbar icons must not disable paper");
                break;
            case "chrome":
                require(NoteUiPolicy.evaluate(page, 1850, 50).blocked, "toolbar tap leaked");
                require(NoteUiPolicy.evaluate(page, 1850, 900).blocked, "blank toolbar margin leaked");
                require(NoteUiPolicy.evaluate(page, 300, 2500).blocked, "pagebar tap leaked");
                break;
            case "popup":
                // Captured Settings popup on Manta, in the existing activity
                // window. Its blank margins are part of the popup too.
                sidebar(page).children.add(node("", 1083, 1584, 1749, 2416));
                require(NoteUiPolicy.evaluate(page, 1090, 1590).blocked, "popup margin leaked");
                require(NoteUiPolicy.evaluate(page, 500, 500).blocked, "dismissal tap leaked");
                require(NoteUiPolicy.evaluate(page, 500, 500).popupVisible, "popup not identified");
                break;
            case "edge-popup":
                sidebar(page).children.add(node("new_panel", 0, 300, 800, 1800));
                require(NoteUiPolicy.evaluate(page, 400, 500).blocked, "edge popup leaked");
                require(NoteUiPolicy.evaluate(page, 1400, 500).blocked,
                        "outside dismissal tap leaked behind edge popup");
                require(NoteUiPolicy.evaluate(page, 1400, 500).popupVisible,
                        "edge popup was mistaken for normal chrome");
                break;
            case "edge-popup-directions":
                int[][] panels = {
                    {0, 300, 800, 1800}, {1120, 300, 1920, 1800},
                    {300, 0, 1600, 800}, {300, 1760, 1600, 2560},
                    {0, 0, 800, 2560}, {0, 0, 1920, 800},
                    // An unknown named layer cannot impersonate the toolbar
                    // merely by having the same thin edge-strip geometry.
                    {0, 0, 116, 2560}, {0, 2444, 1920, 2560},
                };
                for (int panelIndex = 0; panelIndex < panels.length; panelIndex++) {
                    int[] rect = panels[panelIndex];
                    NoteUiPolicy.Node fixture = baseline();
                    sidebar(fixture).children.add(node(panelIndex < 6 ? "" : "new_panel",
                            rect[0], rect[1], rect[2], rect[3]));
                    require(NoteUiPolicy.evaluate(fixture, 960, 1280).popupVisible,
                            "edge panel did not block the whole gesture");
                }
                break;
            case "chrome-orientations":
                int[][] strips = {
                    {0, 0, 116, 2560}, {1804, 0, 1920, 2560},
                    {0, 0, 1920, 116}, {0, 2444, 1920, 2560},
                };
                for (int[] rect : strips) {
                    NoteUiPolicy.Node fixture = baseline();
                    sidebar(fixture).children.clear();
                    sidebar(fixture).children.add(node("", rect[0], rect[1], rect[2], rect[3]));
                    require(!NoteUiPolicy.evaluate(fixture, 960, 1280).blocked,
                            "normal edge toolbar orientation disabled paper");
                    require(NoteUiPolicy.evaluate(fixture,
                            (rect[0] + rect[2]) / 2f, (rect[1] + rect[3]) / 2f).blocked,
                            "normal toolbar touch leaked");
                }
                break;
            case "modal":
                page.children.get(1).children.add(node("dialog", 200, 200, 1700, 2000));
                require(NoteUiPolicy.evaluate(page, 500, 500).blocked, "modal overlay leaked");
                page.children.add(node("unknown_firmware_layer", 0, 0, 1920, 2560));
                require(NoteUiPolicy.evaluate(page, 500, 500).blocked, "unknown layer armed links");
                break;
            case "unknown":
                require(NoteUiPolicy.evaluate(null, 500, 500).blocked, "missing root armed links");
                require(NoteUiPolicy.evaluate(node("elsewhere", 0, 0, 1920, 2560), 500, 500).blocked,
                        "unknown layout armed links");
                NoteUiPolicy.Node other = new NoteUiPolicy.Node(page.id, "other.package",
                        page.className, 0, 0, 1920, 2560, true);
                other.children.addAll(page.children);
                require(NoteUiPolicy.evaluate(other, 500, 500).blocked, "different app armed links");
                require(NoteUiPolicy.evaluate(page, Float.NaN, 500).blocked, "invalid tap armed links");
                break;
            case "hidden":
                page.children.add(new NoteUiPolicy.Node(NoteUiPolicy.PREFIX + "dialog",
                        NoteUiPolicy.PACKAGE, "android.widget.RelativeLayout",
                        200, 200, 1700, 2000, false));
                require(!NoteUiPolicy.evaluate(page, 500, 500).blocked, "hidden dialog blocked paper");
                break;
            case "revision":
                int baseline = NoteUiPolicy.evaluate(page, 500, 500).signature;
                require(NoteUiPolicy.evaluate(page, 600, 600).signature == baseline,
                        "tap coordinates changed UI revision");
                sidebar(page).children.add(node("menu", 1083, 1584, 1749, 2416));
                require(NoteUiPolicy.evaluate(page, 500, 500).signature != baseline,
                        "popup did not change UI revision");
                break;
            case "dismiss-grace":
                NoteUiPolicy.History history = new NoteUiPolicy.History();
                NoteUiPolicy.Result paper = NoteUiPolicy.evaluate(page, 500, 500);
                require(!history.apply(paper, 0).blocked, "fresh paper blocked");
                sidebar(page).children.add(node("menu", 1083, 1584, 1749, 2416));
                NoteUiPolicy.Decision opened = history.apply(NoteUiPolicy.evaluate(page, 500, 500), 100);
                require(opened.blocked, "popup not blocked");
                NoteUiPolicy.Decision dismissed = history.apply(paper, 200);
                require(dismissed.blocked, "dismissing UP replayed after popup disappeared");
                require(opened.revision != dismissed.revision, "dismissal revision was unchanged");
                require(history.apply(paper, 1699).blocked, "grace ended early");
                require(!history.apply(paper, 1700).blocked, "paper never rearmed after grace");
                history.apply(NoteUiPolicy.evaluate(page, 500, 500), 2000);
                require(history.apply(paper, 10000).blocked,
                        "closing a long-held menu lost its dismissal grace");
                require(!history.apply(paper, 11500).blocked, "long-held menu grace never expired");
                break;
            default: throw new AssertionError("unknown scenario " + args[0]);
        }
    }
}
