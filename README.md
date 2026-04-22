# Supernote Folder Shortcuts

A plugin for the Supernote A5X/A6X/Nomad/Manta that lets you turn any
handwritten or typed word into a one-tap shortcut to a folder.

Lasso a word, pick a folder from the plugin's file browser, and a native
link is attached to the word. Tapping the underlined word with the pen
navigates the Supernote file manager straight into that folder.

![icon](assets/icon.png)

## How it works

The Supernote plugin SDK can set a native link on lassoed strokes
(`setLassoStrokeLink`) but only supports linkTypes 0..4 (page / note
file / document / image / URL) — **there is no "folder" linkType**, so
tapping the native link does nothing on its own.

This plugin works around that by:

1. Calling `setLassoStrokeLink(linkType: 2)` so the word gets the native
   underline.
2. Persisting a sidecar record of `{notePath, page, rect, folderPath}`
   inside the plugin's own data directory. Each shortcut is stored as
   an empty directory whose hex-encoded name carries all the fields —
   the SDK exposes `makeDir` / `listFiles` / `deleteDir` but no generic
   file-write primitive.
3. Listening for `PEN_UP` events globally. When the user taps inside a
   saved rect on the current page, the plugin deletes the tap's ink
   stroke and calls `FileUtils.openFilePath(folderPath)`, which opens
   the Supernote file manager in that folder.

A size gate ensures only small (tap-like) strokes activate the
shortcut; lassoes and writing pass through untouched, so you can still
use the native 3-dots menu on a linked word to edit or remove the
link.

## Limitations

- **Pen-only activation.** The Supernote routes finger touches to a
  separate input subsystem (`pt_mt`); the plugin SDK only exposes
  Wacom-pen events (`event_pen_up`). Finger taps on the note canvas are
  not delivered to plugins.
- **Native link handler ignores folder paths.** Without this plugin
  running, tapping a linked word is a no-op. The plugin must be
  installed and enabled.
- The shortcut's rect is anchored to the original lasso rectangle. If
  a user erases or drastically rearranges the underlying strokes, the
  sidecar entry will be stale.

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

## Usage

1. In a note, lasso a word.
2. Tap the 3-dots menu on the lasso toolbar → **Folder Shortcuts**.
3. Navigate to the target folder in the picker, then tap
   **Link lasso → this folder**.
4. The word is underlined. Tap the underlined word with the pen to
   open the folder.

To remove a link, lasso the word again and use the native 3-dots
menu → **Remove Link** (the plugin's size gate lets the lasso pass
through without opening the folder).

## License

TBD.
