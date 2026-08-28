# Supernote Folder Shortcuts

A plugin for the Supernote Manta that turns a lassoed handwritten, typed, or
sticker object into a one-tap shortcut to a folder.

The Supernote note stores the link and draws its normal paperclip/underline
marker. With the plugin enabled, tapping the linked object with either a finger
or the pen opens the target folder.

![icon](assets/icon.png)

## Usage

1. In a note, lasso the object to link.
2. Open the lasso toolbar's three-dot menu and tap **Link to folder**.
3. On Chauvet 3.29.43 or later, grant file read and write access when prompted.
   **Always allow** keeps existing shortcuts active after the plugin UI closes.
4. Navigate to the target folder, then tap **Link lasso → this folder**.
5. Tap the linked object with a finger or the pen to open the folder.

The picker starts in `Note/` and can navigate up to the Supernote storage root.
The `Hidden` checkbox shows names beginning with a dot.

To remove a shortcut, lasso the linked object and use Supernote's native
**Remove Link** action. The plugin keeps no sidecar shortcut database, so the
removed link disappears from the plugin's next note-page snapshot as well.

## How it works

- **Native note link.** The picker calls the SDK's `setLassoStrokeLink` with
  link type 2 and the folder as its destination. Supernote owns the link's
  paperclip/underline marker and keeps its rectangle attached when the lassoed
  object moves.
- **Note as source of truth.** The plugin reads link elements from the open
  `.note` page and treats type-2 destinations that can be listed as directories
  as folder shortcuts. There is no separate on-disk shortcut record to become
  detached from the note.
- **Finger and pen input.** Supernote's motion listener supplies both finger and
  stylus events. A press and release within 300 ms and 25 screen pixels is
  hit-tested against the cached native link rectangles. A single-finger raw
  input fallback covers the firmware's orphan first `UP` after a PDF/EPUB
  handoff; it uses the same guarded hit-testing path. `PEN_UP` also provides the
  pen fallback and lets the plugin erase the small tap mark before opening the
  folder.
- **Moving linked objects.** A drag that begins on a linked rectangle marks its
  geometry dirty. The plugin waits for Supernote to commit the lasso move and
  rejects both incomplete snapshots and repeated pre-move rectangles before
  publishing the native link's new rectangle.
- **Navigation handoffs.** A native 500 ms heartbeat checks which note, page,
  PDF, or EPUB is active even while React Native timers are paused. The last
  good note links and listener remain available during a document excursion so
  they are ready when **Last Opened Note** returns to the note.
- **Bounded native work.** Context requests have a two-second native deadline,
  page reads are single-flight, and stale reads cannot publish after a context
  change. Page elements and `PEN_UP` elements are recycled so the SDK's native
  element cache does not fill with error 206.
- **Folder navigation.** The Android module opens Supernote's file manager with
  the folder supplied as `folder_path`. This avoids the root-folder behavior
  seen when the SDK's generic file-opening helper is given a directory.

No transparent input or drawing overlays are used. The underline/paperclip is
Supernote's own link marker, and moving, resizing, writing over, and lassoing a
linked object continue to reach the note app normally.

## Limitations

- The plugin must be installed and enabled for a folder destination to open.
- Link rectangles are normally re-read every 30 seconds. Removing a link can
  therefore leave its previous tap rectangle active until the next read.
- Directory classification is cached for 60 seconds. Creating or deleting a
  destination folder can take up to that long to affect an existing link.
- A very short deliberate pen mark inside a link can look like a tap. The plugin
  may erase that mark and open the folder.
- Screen-to-page scaling is measured from the display and SDK page size, but
  zoomed note pages are not handled.
- Release validation has been performed on a Supernote Manta (A5 X2). Its
  Android model string reports `Supernote_Nomad`; that string does not identify
  the physical model correctly. Other Supernote models remain unverified.
- The implementation depends on SDK and firmware behavior around note-element
  caching, motion listeners, and Supernote's internal file-manager activity.
  Major firmware updates should be tested on hardware before upgrading.

## Build

### Prerequisites

- Node.js 18 or newer
- Java 21
- Android SDK with build-tools installed

```sh
npm install
bash buildPlugin.sh
```

On macOS, `buildPlugin.sh` selects Zulu 21 when the default Java is too new and
uses `~/Library/Android/sdk` when `ANDROID_HOME` is unset. The package is written
to `build/outputs/SupernoteFolderShortcuts.snplg`.

## Install

Copy the package to the device's `/MyStyle/` folder, then install or update it
from Supernote's plugin manager. Version 0.3.1 must be installed as a full
`.snplg` update because its Chauvet 3.29.43 file permissions live in
`PluginConfig.json`; hot-deploying only the JavaScript bundle cannot add them.

```sh
adb push build/outputs/SupernoteFolderShortcuts.snplg /sdcard/MyStyle/
```

## Development and validation

The automated suites cover the runtime scheduler and gesture decisions, note
link reading/cache ownership, and picker lifecycle ownership:

```sh
npm test -- --runInBand
npm run lint
npx tsc --noEmit
```

For JavaScript-only iteration on a connected development device, hot-deploy the
bundle and require the fresh build stamp to appear in the device log:

```sh
npm run deploy:bundle
```

Native changes require rebuilding and installing the `.snplg`. With a linked
note page open, the device smoke check watches the live heartbeat, page reads,
listener registration, error 206, and real finger/pen navigation logs:

```sh
npm run check:device -- 30
```
