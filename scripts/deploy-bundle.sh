#!/usr/bin/env bash
#
# Bundles the JS and hot-swaps it into the running plugin, without reinstalling.
#
# Some firmware accepts a debug broadcast carrying a bundle path. Chauvet beta
# 2609111001 ignores it: on that firmware build/install the full .snplg instead.
# Native changes always require a full package install through the Supernote UI.
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
# MyStyle is cloud-synced. The system-UID host can read this temporary location.
DEVICE_DIR=/data/local/tmp
DEVICE_BUNDLE="$DEVICE_DIR/$NAME.bundle"
# Matched against the stamp the reloaded bundle logs on load.
BUILD_ID=$(sed -n "s/^const BUILD_ID = '\([^']*\)'.*/\1/p" index.js | head -1)
if [[ -z "$BUILD_ID" ]]; then
    echo "Cannot find the bundle's build stamp in index.js; reload confirmation is unavailable." >&2
    exit 1
fi
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

# A unique device-side marker gives the log a fresh boundary without clearing
# any buffers (logcat -c fails on beta firmware's inaccessible kernel buffer).
# Reading main only also keeps unrelated buffers out of the confirmation.
RELOAD_MARKER="folder-link-reload-$(date +%s)-$$-$RANDOM"
adb shell log -t FolderLinkDeploy "$RELOAD_MARKER"

adb shell am broadcast \
    -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
    -a com.ratta.supernote.plugin.action.DEBUG \
    --es bundle_path "$DEVICE_BUNDLE" \
    --es plugin_id "$PLUGIN_ID" >/dev/null

echo "Waiting up to ${RELOAD_TIMEOUT_S}s for the reloaded bundle to announce itself…"
stamp=""
for _ in $(seq 1 "$RELOAD_TIMEOUT_S"); do
    sleep 1
    stamp=$(adb logcat -b main -d -v brief 2>/dev/null | awk -v marker="$RELOAD_MARKER" '
        index($0, marker) { fresh = 1; next }
        fresh && index($0, "folder-link] build ") { stamp = $0 }
        END { print stamp }
    ') || stamp=""
    [[ -n "$stamp" ]] && break
done

if [[ -z "$stamp" ]]; then
    echo "Reload not confirmed: nothing announced a build after the broadcast." >&2
    echo "Chauvet beta 2609111001 disables DEBUG hot-loading; an accepted broadcast does not confirm a reload." >&2
    echo "Build with bash buildPlugin.sh and install the .snplg through the plugin manager." >&2
    echo "On other firmware, check that the plugin is enabled and the bundle can load." >&2
    exit 1
fi

if [[ "$stamp" != *"[folder-link] build $BUILD_ID starting"* ]]; then
    echo "Reload announced a different build than the one just bundled (expected $BUILD_ID):" >&2
    echo "  $stamp" >&2
    exit 1
fi

echo "Reloaded. Live build:"
echo "  $stamp"

