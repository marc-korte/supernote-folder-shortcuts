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

adb shell am broadcast \
    -n com.ratta.supernote.pluginhost/.receiver.PluginReceiver \
    -a com.ratta.supernote.plugin.action.DEBUG \
    --es bundle_path "$DEVICE_BUNDLE" \
    --es plugin_id "$PLUGIN_ID" >/dev/null

echo "Reloaded. Confirm which build is live:"
sleep 3
adb logcat -d | grep -a "folder-link] build" | tail -1 | sed 's/^/  /' \
    || echo "  (no build stamp — did the reload take?)"
