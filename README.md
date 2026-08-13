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

## Requirements

Firmware with the 3-argument plugin API — **Chauvet 3.28.42 or later**.
Older firmware passes `registerEventListener` two arguments, and this
plugin builds against `sn-plugin-lib@0.1.43`, which sends three. Use
0.1.1 on those devices.

## How it works

The SDK can set a native link on lassoed strokes (`setLassoStrokeLink`)
but supports only linkTypes 0..4 (page / note file / document / image /
URL) — **there is no "folder" linkType**. So the plugin writes a
`linkType: 2` link pointing at a directory, which gives the word its
native underline, and then handles the tap itself. The note app resolves
such a link, finds a directory where it expects a file, and does nothing,
which leaves the behaviour to us.

**The note is the only record.** Every refresh reads the open page with
`getElements` and keeps the links whose target is a directory — the note
app maintains those rects, so a link that is removed disappears, and one
that is moved or resized reports its new rectangle. There is no separate
store to go stale. (0.1.1 kept a sidecar directory of records, and that
was the cause of [#2](../../issues/2).)

**Taps arrive through the motion listener.** `registerMotionListener`
reports both finger (`toolType` 1) and stylus (`toolType` 2) touches, and
it sees a stylus tap that the note app's own link handling would
otherwise consume. A touch that looks like a tap — under 300 ms, under
25 px of travel — is converted from screen pixels to page coordinates and
hit-tested against the links from the most recent read. The listener is
registered only while the open page actually has a link, so writing
elsewhere costs nothing.

**`PEN_UP` still runs**, but only to clean up: a pen tap on blank paper
inside a link's rect leaves an ink dot, and this is the only path that
knows which element that dot is. Both paths agree on an owner so one
touch cannot navigate twice.

**The heartbeat is native.** React Native suspends JS timers whenever the
plugin view is closed, which is all of normal note-taking, so the refresh
is driven by a `Handler` in the native module that emits an event to JS.

## Limitations

- **The plugin must be installed and enabled.** Without it, tapping a
  linked word does nothing — the note app cannot open a folder.
- **Tested only on a Supernote Manta (A5X2), 1920×2560.** Page
  coordinates happen to be 1:1 with screen pixels there, so the plugin's
  scaling path has never actually had to scale anything. `scaleProbe`
  derives the ratio from display metrics and the SDK's page size for
  other panels, but no other model has been tested and **zoom is not
  handled at all** — tapping a link on a zoomed page will hit-test
  against the wrong point.

  Note when testing: this firmware reports `ro.product.model` as
  "Supernote Nomad" on a Manta as well — the image is shared, and the
  Manta's name is in `ro.mtp.model2`. Go by screen resolution instead
  (Manta 1920×2560, Nomad 1404×1872).
- **A link removed in the last few seconds can still fire once.** Taps
  hit-test against the cached read, which is at most `LINK_RECHECK_MS`
  (6 s) old. Re-reading on every tap costs seconds, and that latency was
  itself the cause of a navigation loop.
- **A very short deliberate mark can be read as a tap** — under 300 ms
  and 25 px, or a stroke of ≤10 sample points on the `PEN_UP` path
  (`TAP_MAX_POINTS`). Lassoes and ordinary writing are well clear of
  both thresholds.
- **A tap resolved more than 800 ms late is discarded** (`TAP_MAX_AGE_MS`)
  to stop a stale touch acting on a screen the user has moved on from. On
  a device slower than the one this was tuned on, a genuine tap could be
  rejected; the log says `tap resolved NNNms late` when it happens.
- **The plugin logs one line per refresh** (~every 6 s while a note is
  open). That is deliberate — `npm run check:device` uses it to prove the
  heartbeat is alive.

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

## Checks after changing anything

Most of what has broken this plugin was invisible in the source and silent at
runtime: the host consuming pen taps before the plugin sees them, JS timers
being suspended so nothing refreshed, and the native element cache filling until
`getElements` refuses to run. None of it shows up as an error the user can see —
the plugin simply stops responding to taps. Run both layers after any change to
`index.js`, `links.ts` or `FolderLinkModule.java`.

```sh
npm test              # link parsing, cache recycling, pending expiry
npm run deploy:bundle # JS-only change: hot-swap into the running plugin
npm run check:device  # then tap a link while it watches
```

`check:device` needs a note open on a page that **has a folder link**, and
wants you to tap that link while it runs — otherwise it cannot tell a working
build from a broken one. It reports which build is live and checks that:

- the native heartbeat is still driving page reads, since a JS timer alone
  stops firing whenever the plugin view is closed;
- no element-cache errors (206) are occurring;
- the motion listener is registered for the linked page — both finger and
  stylus taps arrive through it, so without it no tap can be handled;
- **no overlay windows are in use**. Earlier versions laid invisible windows
  over each link to catch finger taps; those swallow finger events, which stops
  a linked object from being dragged or resized, so any `setOverlays` call is a
  regression.

It also prints which tap paths fired.

Native changes are not covered by `deploy:bundle`; build the `.snplg` and
install it through the device UI, then run `check:device`.

`BUILD_ID` in `index.js` is stamped into the log at startup. Bump it whenever
handing a build to a device — the host may be running either an installed
package or a hot-swapped debug bundle, and without the stamp there is no way to
tell which fix is actually under test.



