# Supernote Folder Shortcuts

A plugin for the Supernote A5X/A6X/Nomad/Manta that lets you turn any
handwritten or typed word into a one-tap shortcut to a folder.

Lasso a word, pick a folder from the plugin's file browser, and a native
link is attached to the word. Tapping the underlined word, with the pen
or with a finger, navigates the Supernote file manager straight into
that folder.

![icon](assets/icon.png)

## Usage

1. In a note, lasso a word.
2. Tap the 3-dots menu on the lasso toolbar → **Folder Shortcuts**.
3. Navigate to the target folder in the picker, then tap
   **Link lasso → this folder**.
4. The word is underlined. Tap the underlined word with the pen or
   with your finger to open the folder.

To remove a link, lasso the word again and use the native 3-dots
menu → **Remove Link** (the plugin's size gate lets the lasso pass
through without opening the folder).

## How it works

The Supernote plugin SDK can set a native link on lassoed strokes
(`setLassoStrokeLink`) but only supports linkTypes 0..4 (page / note
file / document / image / URL), and **there is no "folder" linkType**,
so tapping the native link does nothing on its own.

This plugin works around that by:

1. Calling `setLassoStrokeLink(linkType: 2)` so the word gets the native
   underline.
2. Persisting a sidecar record of `{notePath, page, rect, folderPath}`
   inside the plugin's own data directory. Each shortcut is stored as
   an empty directory whose hex-encoded name carries all the fields,
   since the SDK exposes `makeDir` / `listFiles` / `deleteDir` but no
   generic file-write primitive.
3. **Pen path:** listening for `PEN_UP` events globally. When a tap-sized
   stroke (≤10 sample points) lands inside a saved rect on the current
   page, the plugin deletes the tap's ink stroke and calls
   `FileUtils.openFilePath(folderPath)`.
4. **Finger path:** a native Android module installs a transparent
   `SYSTEM_ALERT_WINDOW` overlay over each linked word's on-screen
   rectangle. The overlay consumes finger (`TOOL_TYPE_FINGER`) taps and
   passes stylus events straight through, so writing/lassoing over the
   linked region still works. Overlays are refreshed on a 1.5 s context
   poll so navigating between pages/notes re-installs the right set.

A stroke-point discriminator lets lassoes pass through the pen path
untouched, so you can still use the native 3-dots menu on a linked
word to edit or remove the link.

## Limitations

- **Native link handler ignores folder paths.** Without this plugin
  running, tapping a linked word is a no-op. The plugin must be
  installed and enabled.
- **Finger path depends on `SYSTEM_ALERT_WINDOW` being granted to the
  plugin host** (`com.ratta.supernote.pluginhost`). On the tested
  firmware it is granted at install time; other firmware revisions may
  behave differently.
- **Finger tap delay of up to 1.5 s when switching pages/notes.** The
  Finger path uses a 1.5 s context poll to re-install
  `SYSTEM_ALERT_WINDOW` overlays after navigation, so a freshly
  entered page can ignore finger taps for up to one poll interval.
  Mitigation: replace the polling loop with an event-driven refresh
  (e.g., subscribe to page/note change events from the SDK) so
  overlays re-install immediately on navigation.
- **False activation risk on small deliberate strokes.** The pen path
  treats any stroke of ≤10 sample points as a tap (see
  `TAP_MAX_POINTS`), so a very short intentional mark that lands
  inside a saved rect can be consumed and trigger the shortcut.
- **Tool type detection assumes reliable `TOOL_TYPE_FINGER` vs. stylus
  classification.** The `SYSTEM_ALERT_WINDOW` overlay only swallows
  events where `getToolType(0) == TOOL_TYPE_FINGER` and passes
  everything else through. Devices or firmware that misreport tool
  type (e.g., stylus events arriving as finger, or vice-versa) will
  either break writing over a linked word or stop finger taps from
  opening the folder.
- The shortcut's rect is anchored to the original lasso rectangle in
  page coords. If a user erases or drastically rearranges the
  underlying strokes, the sidecar entry will be stale.
- **Important: page coords are assumed 1:1 with screen pixels.**
  Verified only on a Supernote Manta. This assumption is fragile
  across devices: other Supernote models (A5X, A6X, Nomad, future
  revisions) may use different panel resolutions, DPIs, or zoom
  levels, and the overlay rectangles will land in the wrong place on
  screen. Action items for integrators: test on every target
  Supernote model before relying on the plugin, and implement a
  dynamic scale factor: derive it from device DPI / current zoom and
  convert page coords to screen coords with that factor instead of
  using the raw values.

## Build

### Prerequisites

- Node 18+
- Java 21 (Gradle 8.13 does not support Java 24+)
- Android SDK with build-tools installed

```sh
npm install
bash buildPlugin.sh
```

`buildPlugin.sh` auto-selects Zulu 21 on macOS when the system `java`
is too new, and auto-sets `ANDROID_HOME` to
`~/Library/Android/sdk` if unset. The output is
`build/outputs/SupernoteFolderShortcuts.snplg`.

## Install

Plugins must live in `/MyStyle/` on the device storage. Copy
`SupernoteFolderShortcuts.snplg` to `MyStyle/` via USB (or with `adb
push`) and install it from the plugin manager on the device.

```sh
adb push build/outputs/SupernoteFolderShortcuts.snplg /sdcard/MyStyle/
```



