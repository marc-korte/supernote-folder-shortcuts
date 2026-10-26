package com.supernotefoldershortcuts;

import java.util.ArrayList;
import java.util.List;

/** Runs the production parser without Android, a device, or a Gradle download. */
public final class RawFingerInputHarness {
    private static final class Probe implements RawFingerInput.TapSink {
        final List<double[]> taps = new ArrayList<>();
        final List<double[]> downs = new ArrayList<>();
        final List<String> rejected = new ArrayList<>();
        final RawFingerInput input = new RawFingerInput(this);
        long now = 1000;

        public void onTap(double x, double y, long down, long up, int major) {
            taps.add(new double[] {x, y, down, up, major});
        }
        public void onDown(double x, double y, long downTime) {
            downs.add(new double[] {x, y, downTime});
        }
        public void onRejected(long down, long up, String reason) {
            rejected.add(down + ":" + up + ":" + reason);
        }
        void abs(int code, int value) { input.process(3, code, value, now); }
        void frame() { input.process(0, 0, 0, now); }
        void down(int id, int x, int y, int major, int tool) {
            abs(0x39, id);
            abs(0x35, x);
            abs(0x36, y);
            abs(0x30, major);
            abs(0x37, tool);
            frame();
        }
        void up() { now += 50; abs(0x39, -1); frame(); }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    public static void main(String[] args) {
        switch (args[0]) {
            case "panel-mapping": {
                check(RawFingerInput.supports("pt_mt", 1920, 2560, 0), "verified Manta rejected");
                check(!RawFingerInput.supports("fts_ts", 1920, 2560, 0), "other panel accepted");
                check(!RawFingerInput.supports("atmel_mxt_ts", 1920, 2560, 0), "Atmel accepted");
                check(!RawFingerInput.supports(null, 1920, 2560, 0), "unknown panel accepted");
                check(!RawFingerInput.supports("pt_mt", 1404, 1872, 0), "Nomad geometry accepted");
                check(!RawFingerInput.supports("pt_mt", 2560, 1920, 0), "landscape accepted");
                check(!RawFingerInput.supports("pt_mt", 1920, 2560, 1), "rotated panel accepted");
                Probe p = new Probe();
                p.down(1, 1280, 960, 100, 0);
                p.up();
                check(p.taps.size() == 1, "finger tap missing");
                check(Math.abs(p.taps.get(0)[0] - 1280 * 1920.0 / 2559) < 0.001,
                        "wrong raw X mapping");
                check(Math.abs(p.taps.get(0)[1] - 960 * 2560.0 / 1919) < 0.001,
                        "wrong raw Y mapping");
                break;
            }
            case "fingers": {
                Probe p = new Probe();
                for (int size : new int[] {94, 150, 255}) {
                    p.down(size, 500, 700, size, 0);
                    p.up();
                }
                check(p.taps.size() == 3, "ordinary fingertip rejected");
                check(p.rejected.isEmpty(), "ordinary finger emitted palm rejection");
                check(p.taps.get(0)[4] == 94, "peak size missing from tap metadata");
                check(p.taps.get(0)[3] - p.taps.get(0)[2] == 50, "tap times incoherent");
                break;
            }
            case "palm-size": {
                Probe p = new Probe();
                p.down(1, 500, 700, 447, 0);
                check(p.rejected.size() == 1, "SDK not warned before palm UP");
                check(p.rejected.get(0).equals("1000:1000:contact-size"), "wrong rejection interval");
                p.up();
                check(p.taps.isEmpty(), "447-unit palm opened a link");
                check(p.rejected.get(p.rejected.size() - 1).equals("1000:1050:contact-size"),
                        "rejection interval not extended through UP");
                // A previous palm must not poison the next finger's updated size.
                p.down(2, 500, 700, 110, 0);
                p.up();
                check(p.taps.size() == 1, "normal finger after palm rejected");
                break;
            }
            case "palm-shrinks": {
                Probe p = new Probe();
                p.down(1, 500, 700, 100, 0);
                p.abs(0x30, 447);
                p.abs(0x30, 100);
                p.frame();
                p.up();
                check(p.taps.isEmpty(), "palm regained eligibility after shrinking");
                check(!p.rejected.isEmpty(), "SDK never received palm rejection");
                break;
            }
            case "tool-types": {
                for (int tool : new int[] {1, 2, 9}) {
                    Probe p = new Probe();
                    p.down(1, 500, 700, 100, tool);
                    p.abs(0x37, 0);
                    p.frame();
                    p.up();
                    check(p.taps.isEmpty(), "nonfinger tool opened a link: " + tool);
                    check(!p.rejected.isEmpty(), "SDK not warned about nonfinger tool");
                }
                break;
            }
            case "monitor-health": {
                RawFingerInput.MonitorHealth health = new RawFingerInput.MonitorHealth();
                health.configure(false);
                check(health.allowsValidation(), "unsupported panel lost ordinary SDK input");
                health.configure(true);
                check(!health.allowsValidation(), "unopened supported reader armed SDK taps");
                health.opened();
                check(health.allowsValidation(), "opened reader did not arm SDK taps");
                health.stopped();
                check(!health.allowsValidation(), "failed reader left SDK palm filtering bypassed");
                health.opened();
                check(health.allowsValidation(), "reader retry failed to restore validation");
                break;
            }
            case "physical-down": {
                Probe p = new Probe();
                p.abs(0x39, 1);
                check(p.downs.isEmpty(), "DOWN emitted before axes known");
                p.abs(0x35, 500);
                p.abs(0x36, 700);
                p.frame();
                check(p.downs.size() == 1, "physical DOWN snapshot not requested before UP");
                check(p.taps.isEmpty(), "tap emitted before UP");
                p.now += 10;
                p.frame();
                check(p.downs.size() == 1, "physical DOWN resampled on MOVE frame");
                p.up();
                check(p.downs.get(0)[2] == 1000, "physical DOWN timestamp was replaced by release");
                check(p.taps.size() == 1, "snapshot hook swallowed ordinary tap");
                break;
            }
            case "rejection-history": {
                RawFingerInput.Rejections history = new RawFingerInput.Rejections();
                history.record(1000, 1000);
                check(history.contains(1000, 1050, 1100), "SDK release escaped early palm record");
                history.record(1000, 1300);
                check(history.contains(1100, 1300, 1350), "final palm interval not expanded");
                check(history.contains(980, 995, 1350), "callback timing margin missing");
                check(!history.contains(1500, 1550, 1550), "later real finger rejected");
                check(!history.contains(1000, 1050, 7000), "stale palm retained indefinitely");
                for (int i = 0; i < 40; i++) history.record(10000 + i * 100, 10050 + i * 100);
                check(history.contains(13900, 13950, 14000), "recent palm lost from bounded history");
                check(!history.contains(1000, 1050, 14000), "overwritten palm still active");
                break;
            }
            case "gesture-guards": {
                Probe drag = new Probe();
                drag.down(1, 500, 700, 100, 0);
                drag.abs(0x35, 700);
                drag.frame();
                drag.abs(0x35, 500);
                drag.frame();
                drag.up();
                check(drag.taps.isEmpty(), "drag returning to start accepted");
                for (int[] movement : new int[][] {{0, 20}, {34, 0}, {20, 15}}) {
                    Probe screenDrag = new Probe();
                    screenDrag.down(1, 500, 700, 100, 0);
                    screenDrag.abs(0x35, 500 + movement[0]);
                    screenDrag.abs(0x36, 700 + movement[1]);
                    screenDrag.frame();
                    screenDrag.up();
                    check(screenDrag.taps.isEmpty(),
                            "raw X/Y/diagonal movement beyond 25 screen pixels accepted");
                }
                for (int[] movement : new int[][] {{30, 0}, {0, 18}, {18, 14}}) {
                    Probe screenTap = new Probe();
                    screenTap.down(1, 500, 700, 100, 0);
                    screenTap.abs(0x35, 500 + movement[0]);
                    screenTap.abs(0x36, 700 + movement[1]);
                    screenTap.frame();
                    screenTap.up();
                    check(screenTap.taps.size() == 1,
                            "small X/Y/diagonal finger movement within 25 screen pixels rejected");
                }
                Probe hold = new Probe();
                hold.down(1, 500, 700, 100, 0);
                hold.now += 301;
                hold.up();
                check(hold.taps.isEmpty(), "long hold accepted");
                Probe multi = new Probe();
                multi.down(1, 500, 700, 100, 0);
                multi.abs(0x2f, 1);
                multi.down(2, 500, 700, 100, 0);
                multi.up();
                multi.abs(0x2f, 0);
                multi.up();
                check(multi.taps.isEmpty(), "multi-touch accepted");
                Probe invalid = new Probe();
                invalid.down(1, 2560, 700, 100, 0);
                invalid.up();
                check(invalid.taps.isEmpty(), "out-of-range coordinate accepted");
                Probe unsupportedSlot = new Probe();
                unsupportedSlot.down(1, 500, 700, 100, 0);
                unsupportedSlot.abs(0x2f, 99);
                unsupportedSlot.abs(0x39, -1);
                unsupportedSlot.frame();
                check(unsupportedSlot.taps.isEmpty(), "invalid slot redirected UP to valid finger");
                Probe lost = new Probe();
                lost.down(1, 500, 700, 100, 0);
                lost.input.process(0, 3, 0, lost.now);
                lost.up();
                check(lost.taps.isEmpty(), "desynchronized input accepted");
                break;
            }
            default: throw new AssertionError("Unknown case: " + args[0]);
        }
    }
}
