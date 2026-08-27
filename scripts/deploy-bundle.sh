#!/usr/bin/env bash
#
# Bundles the JS and hot-swaps it into the running plugin, without reinstalling.
#
# The plugin host accepts a debug broadcast carrying a bundle path, which makes
# JS-only changes a few seconds to try instead of a full package install. Native
# changes (FolderLinkModule.java) are not covered — build the .snplg and install it
# through the Supernote UI for those.
#
# Note the broadcast must name the receiver explicitly: as an implicit broadcast
# it is dropped with "Background execution not allowed" whenever the host has no
# foreground process.
#
# Usage: scripts/deploy-bundle.sh

set -euo pipefail

cd "$(dirname "$0")/.."

PLUGIN_ID=$(node -p "require('./PluginConfig.json').pluginID")
NAME=$(node -p "require('./package.json').name")
DEVICE_DIR=/storage/emulated/0/MyStyle
DEVICE_BUNDLE="$DEVICE_DIR/$NAME.bundle"
# Matched against the stamp the reloaded bundle logs on load.
BUILD_ID=$(sed -n "s/^const BUILD_ID = '\([^']*\)'.*/\1/p" index.js | head -1)
RELOAD_TIMEOUT_S="${RELOAD_TIMEOUT_S:-15}"
OUT=$(mktemp -d -t folder-link-bundle.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

if ! adb get-state >/dev/null 2>&1; then
    echo "No device: connect the Supernote and enable USB debugging." >&2
    exit 2
fi

echo "Bundling…"
npx react-native bundle \
    --entry-file index.js \
    --bundle-output "$OUT/$NAME.bundle" \
    --platform android \
    --assets-dest "$OUT" \
    --dev false >/dev/null

adb push "$OUT/$NAME.bundle" "$DEVICE_BUNDLE" >/dev/null
echo "Pushed to $DEVICE_BUNDLE"

# The host acknowledges nothing, so the only proof the swap took is the bundle
# announcing itself on load. The stamp carries a version, not a bundle path, and
# that version rarely changes between reloads, so a stamp left in the buffer by
# the previous reload is indistinguishable from a fresh one. Clearing first is
# what makes a later hit mean "this reload". A failed clear is fatal: the
# confirmation below would otherwise read the old buffer and call a reload that
# never happened a success.
if ! adb logcat -c; then
    echo "Could not clear the log buffer, so a reload cannot be confirmed." >&2
    echo "$DEVICE_BUNDLE is pushed but was not loaded. Fix adb, then re-run." >&2
    exit 1
fi

adb shell am broadcast \
    -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
    -a com.ratta.supernote.plugin.action.DEBUG \
    --es bundle_path "$DEVICE_BUNDLE" \
    --es plugin_id "$PLUGIN_ID" >/dev/null

echo "Waiting up to ${RELOAD_TIMEOUT_S}s for the reloaded bundle to announce itself…"
stamp=""
for _ in $(seq 1 "$RELOAD_TIMEOUT_S"); do
    sleep 1
    stamp=$(adb logcat -d 2>/dev/null | grep -a "folder-link] build" | tail -1) || stamp=""
    [[ -n "$stamp" ]] && break
done

if [[ -z "$stamp" ]]; then
    echo "Reload not confirmed: nothing announced a build after the broadcast." >&2
    echo "The host may have dropped it (is the plugin enabled?), or $DEVICE_BUNDLE failed to load." >&2
    exit 1
fi

if [[ -n "$BUILD_ID" && "$stamp" != *"build $BUILD_ID"* ]]; then
    echo "Reload announced a different build than the one just bundled (expected $BUILD_ID):" >&2
    echo "  $stamp" >&2
    exit 1
fi

echo "Reloaded. Live build:"
echo "  $stamp"

