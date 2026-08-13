# Changelog

## 0.2.0

Fixes both open issues, and replaces how links are stored and how taps are
caught. Anyone on 0.1.1 should upgrade — on current firmware 0.1.1 does not work
at all.

### Requires firmware with the 3-argument plugin API

Chauvet 3.28.42 or later. On that firmware the host's
`NativePluginAPI.registerEventListener` takes `(id, event, registerType)`, while
`sn-plugin-lib@0.1.34` called it with two arguments — the resulting exception
aborted JS init, so the plugin loaded, showed its buttons, and did nothing at
all. This release moves to `sn-plugin-lib@0.1.43`, which matches the current
contract. Older firmware on the 2-argument API is no longer supported; stay on
0.1.1 for those devices. ([#1](../../issues/1))

### Links live in the note, not beside it

0.1.1 kept a sidecar directory of shortcut records and treated it as the source
of truth. Nothing ever deleted from it, so removing a link left the shortcut
firing, and a record from one note stayed live while a different note was open.
Links are now read back out of the note itself, which the note app maintains, so
removing a link removes the shortcut and a link belongs to exactly one page.
([#2](../../issues/2))

### Linked objects can be moved and resized again

The finger path used invisible `SYSTEM_ALERT_WINDOW` rectangles laid over each
linked word. Those swallow every finger event inside them, so a linked object
could not be dragged, and their geometry came from the last refresh, so the
tappable area lagged behind an object that had moved. They are gone: both finger
and stylus taps arrive through the plugin's motion listener, and a tap is
hit-tested against the link's own rectangle, which follows the object.

### Other fixes

- **Tapping a link no longer loops.** A touch could be resolved seconds after
  the fact and applied to a screen the user had since navigated away from and
  back to, which turned "open the folder, come back to the note" into an endless
  round trip. Taps now hit-test against the most recent read rather than
  re-reading the page, and a touch older than 800ms is discarded.
- **The plugin no longer goes blind after sustained use.** Reading a page caches
  trail data natively and the cache does not drain by itself; once full,
  `getElements` fails with error 206 and no link is ever found again. Elements
  are now handed back after each read, with a cache clear and one retry as
  recovery.
- **Link state no longer goes stale while you work.** The refresh that keeps it
  current ran on a JS timer, and React Native suspends those whenever the plugin
  view is closed — which is all of normal note-taking. It is now driven from the
  native side.
- **A folder created after its link now starts working without a restart.** The
  folder-vs-file answer for a link's destination was cached forever, so a
  destination probed before the folder existed stayed dead until the plugin
  restarted (and a deleted folder stayed "live"). The cache now expires after a
  minute.
- **Pressing "Link lasso → this folder" twice no longer writes two links.** On
  e-ink the screen lags the tap, so the button could be pressed again before the
  first link finished; the button is now disabled while a link is in flight.

### Known limitations

- Tested only on a Supernote Manta (A5X2). Page coordinates happen to be 1:1
  with screen pixels there; the scale is derived for other panels but untested,
  and zoom is not handled.
- A link removed in the last few seconds can still fire once, until the next
  refresh.
- A very short deliberate mark inside a link's rectangle can still be read as a
  tap.

## 0.1.1

Folder picker reaches the Supernote root, show-hidden toggle, DPI-scaled
overlays.

## 0.1.0

Initial release.
