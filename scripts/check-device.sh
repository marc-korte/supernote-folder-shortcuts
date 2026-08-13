#!/usr/bin/env bash
#
# On-device smoke check for the folder-link plugin.
#
# Every fault this looks for reached a device and silently disabled the plugin
# while the code read as correct, so this is worth running after any change to
# index.js, links.ts or FolderLinkModule.java — none of it can be caught by the
# unit tests, which cannot see the host, the element cache or the JS timers.
#
# Preconditions, all of them required for a meaningful result:
#   1. Supernote connected over USB with adb authorised.
#   2. The build under test deployed (npm run deploy:bundle, or install the
#      .snplg for native changes).
#   3. A note open on screen, on a page holding at least one folder link.
#
# Usage: scripts/check-device.sh [seconds]   (default 30)

set -uo pipefail

DURATION="${1:-30}"
LOG="$(mktemp -t folder-link-check.XXXXXX)"
trap 'rm -f "$LOG"' EXIT

pass=0
fail=0

check() { # check <description> <condition-result> [detail]
    if [[ "$2" == "ok" ]]; then
        printf '  \033[32mPASS\033[0m  %s\n' "$1"
        pass=$((pass + 1))
    else
        printf '  \033[31mFAIL\033[0m  %s\n' "$1"
        [[ -n "${3:-}" ]] && printf '        %s\n' "$3"
        fail=$((fail + 1))
    fi
}

if ! adb get-state >/dev/null 2>&1; then
    echo "No device: connect the Supernote and enable USB debugging." >&2
    exit 2
fi

echo "Which build is live (from the existing log buffer):"
adb logcat -d 2>/dev/null | grep -a "folder-link] build" | tail -1 | sed 's/^/  /' \
    || echo "  (no build stamp seen — deploy a build that logs BUILD_ID)"

echo
echo "Watching the device for ${DURATION}s. Tap a folder link now, with finger and stylus."

# macOS ships no timeout(1); coreutils provides it as gtimeout. Fall back to
# running the capture in the background and stopping it here, which needs
# nothing beyond the shell.
if command -v timeout >/dev/null 2>&1; then
    timeout "$DURATION" adb logcat -v time > "$LOG" 2>/dev/null
elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$DURATION" adb logcat -v time > "$LOG" 2>/dev/null
else
    adb logcat -v time > "$LOG" 2>/dev/null &
    logcat_pid=$!
    sleep "$DURATION"
    kill "$logcat_pid" 2>/dev/null
    wait "$logcat_pid" 2>/dev/null
fi

plugin_lines=$(grep -a -c "folder-link" "$LOG")
reads=$(grep -a -c "folder-link] page " "$LOG")
cache_errors=$(grep -a -c "code=206" "$LOG")
listener=$(grep -a -c "motion listener on" "$LOG")
no_context=$(grep -a -c "refresh: no note context" "$LOG")
opens=$(grep -a -c -- "-tap openFolder\|pen_up openFolder" "$LOG")
links_present=$(grep -a "folder-link] page " "$LOG" | grep -a -vc ", 0 folder links")

echo
echo "Results over ${DURATION}s:"

# The heartbeat is what keeps overlays in step with the open page. JS timers are
# suspended while the plugin view is closed, so a JS-only interval goes quiet
# during ordinary note-taking and the tap targets silently go stale.
if [[ "$reads" -ge 2 ]]; then
    check "heartbeat drives repeated page reads ($reads)" ok
elif [[ "$no_context" -gt 0 ]]; then
    check "heartbeat drives repeated page reads" bad \
        "Refreshes ran but found no note context. Is a note actually open?"
else
    check "heartbeat drives repeated page reads" bad \
        "Only $reads read(s). Refresh is not being driven — check the native tick."
fi

# Reading page elements caches trail data natively; without handing them back
# the cache fills and getElements starts failing, which blinds the plugin.
if [[ "$cache_errors" -eq 0 ]]; then
    check "no element-cache exhaustion (error 206)" ok
else
    check "no element-cache exhaustion (error 206)" bad \
        "$cache_errors failures. Elements are not being recycled after a read."
fi

# Both finger and stylus taps arrive through the motion listener, and it is only
# registered while the open page has a link — so on a page that has one, its
# absence means no tap can be handled at all.
if [[ "$listener" -ge 1 ]] || grep -aq "motion listener on" <(adb logcat -d 2>/dev/null); then
    check "motion listener armed for the linked page" ok
else
    check "motion listener armed for the linked page" bad \
        "Never registered; neither finger nor stylus taps can be handled."
fi

# A leftover from the versions that laid invisible windows over each link: those
# swallow finger events, which stops a linked object being dragged or resized.
if [[ "$(grep -a -c "setOverlays" "$LOG")" -eq 0 ]]; then
    check "no overlay windows in use" ok
else
    check "no overlay windows in use" bad \
        "setOverlays is still being called; finger drags on a link will be blocked."
fi

if [[ "$links_present" -ge 1 ]]; then
    check "a folder link was found on the open page" ok
else
    check "a folder link was found on the open page" bad \
        "Every read reported 0 links. Open a page that has one, or the check proves nothing."
fi

# Taps are optional: the check is still useful without them, but this is the
# only part that exercises the paths end to end.
echo
if [[ "$opens" -ge 1 ]]; then
    printf '  \033[32mTAPS\033[0m  %s navigation(s) fired:\n' "$opens"
    grep -a -- "-tap openFolder\|pen_up openFolder" "$LOG" | sed 's/^/        /'
else
    printf '  \033[33mTAPS\033[0m  none seen — tap a link during the window to cover the tap paths.\n'
    grep -a "folder-link] pen: " "$LOG" | tail -5 | sed 's/^/        /'
fi

if [[ "$plugin_lines" -eq 0 ]]; then
    echo
    echo "No plugin output at all. Is it enabled, and is the build deployed?" >&2
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
