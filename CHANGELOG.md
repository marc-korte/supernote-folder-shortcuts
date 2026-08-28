# Changelog

## 0.3.1

- **Restores the folder picker and link taps on Chauvet 3.29.43.** The firmware
  now blocks shared-storage reads and writes until a plugin declares and
  requests them. Folder Shortcuts declares `FILE:READ` and `FILE:WRITE`, asks
  for both when the picker opens, and keeps folder browsing/link creation
  disabled with an actionable message until access is granted.
- **Missing permission no longer floods the native page reader.** Background
  scans stand down when read access is absent or error 1503 reports that it was
  revoked, then resume as soon as the picker receives authorization.
- **Large notes no longer discard a tap that overlaps their page scan.** The
  ordinary two-second stale-tap guard remains fixed, while a known in-flight
  scan uses that page's measured duration plus the same safety margin. Context,
  input, and picker-state checks still reject taps after the user moves on.
- **The package is built against `sn-plugin-lib` 0.1.65.** A clean dependency
  install is required before packaging so the bundle reports the SDK expected
  by the `.43` plugin host.

## 0.3.0

- **Links stay tappable through intermittent note/document handoffs.** The SDK
  can publish a new note path several seconds before its element cache changes
  pages. Note transitions now clear the stale element cache and keep a
  speculative listener through one bounded empty retry. PDF/EPUB excursions
  retain the last good note snapshot and the SDK listener handle; removing the
  final handle during a handoff was observed on hardware to produce UP-only
  input after re-registration.
- **A stranded SDK context request no longer blocks every later refresh for
  30–60 seconds.** Context reads now have a two-second deadline driven by an
  Android Handler, which still runs while Supernote pauses JavaScript timers.
  Context probes run independently of slow page reads, page reads are
  single-flight, and clean tap misses do not start another full-page scan.
- **Lasso moves wait for a complete committed page snapshot.** While a moved
  object remains selected, the Note app can repeatedly return the old link
  rectangle—or temporarily return fewer links. Drag refreshes now keep the page
  dirty until the rectangle actually changes, while preserving the old hit area
  if the move is cancelled. Dirty state survives a PDF/EPUB excursion, so the
  first tap after **Last Opened Note** uses the committed moved rectangle.
- **The first finger tap after a document handoff no longer disappears.** Manta
  firmware can suppress an unchanged raw touchscreen axis and deliver the SDK
  listener only an orphan `UP` after returning from a PDF or EPUB. A narrow
  read-only raw-input fallback retains the absolute axes across that handoff,
  accepts only single-finger taps, and feeds complete taps through the same
  context, scale, ownership, and hit-testing guards as SDK motion events.
- **The raw-input fallback releases its reader on a defined path.** The reader
  parked inside a blocking `read()`, and closing the stream from another thread
  is not guaranteed to unblock a read already in progress on a character device.
  It now waits in `poll()` on the device plus a wake pipe, and stopping it writes
  one byte to that pipe, so the thread unwinds and closes its descriptor
  deterministically. Verified on a Manta across repeated teardown cycles: one
  reader thread, never more.
- **Note handoffs wait for the native page, not only the reported path.** Live
  traces showed provisional empty element pages at 531 ms and 1026 ms, with the
  note finishing its load at 1525 ms. First reads now wait 2000 ms and reconfirm
  the note/page before touching the native element cache.
- **A tap queued behind one native page scan is no longer discarded at 800ms.**
  A 957ms collision was measured on a 125-element Manta page. Clean taps now
  have a two-second completion window, dirty drag geometry has four seconds,
  and the ordinary full-page recheck interval is 30 seconds.
- **Tap state and native element ownership are balanced on every exit path.**
  `PEN_UP` payloads are recycled in a `finally`, cancelled gestures clear their
  saved down event, and stamped tap claims can only be released by their owner,
  including when either input handler throws.
- **Page scale is not treated as measured until the SDK probe succeeds.** A
  note/page handoff clears the previous scale instead of installing a fake 1:1
  measurement, so the first tap on panels with different screen and page
  coordinate spaces performs a real probe.
- **The folder picker has an owner-stamped single-flight guard.** Rapid presses
  cannot create duplicate links, and delayed work from an old picker visit
  cannot clear or close a newer one. A rejected host close restores the
  picker's input-suppression state, an in-flight SDK link remains claimed across
  a close/reopen, and unmount cancels the delayed close callback.
- **The SDK is pinned to the current `sn-plugin-lib` 0.1.65 release.** Motion
  events use the pointer-array payload, lifecycle messages use the current
  registration API, and unknown or long `PEN_UP` strokes are not treated as
  taps.
- **Hot-deploy verification can no longer pass on stale log output.** If the
  device log cannot be cleared before a debug reload, deployment now stops
  before broadcasting the bundle path instead of accepting an earlier build
  stamp as proof that the new bundle loaded.

## 0.2.1

- **The folder picker can be used repeatedly.** Closing the picker does not
  unmount its React view, so a successful link could leave the button disabled
  and the closing message stuck on the next visit. Picker state now resets when
  it opens, refreshes its folder listing, and waits for the host close to finish
  before re-enabling the link button.
- **Picker UI no longer sends taps through to the note.** Opening either plugin
  button starts a two-minute idle suppression window; touches while browsing
  refresh that window, and closing leaves a short grace period for the close
  tap itself. A lost lasso now shows a retry message instead of raw error 904.
- **Folder links remain responsive after leaving and returning to a note.** A
  transient missing note context no longer disarms the motion listener or drops
  its measured page; only one minute without note context stands it down.

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
- A link removed in the last 30 seconds can still fire once, until the next
  periodic refresh.
- A very short deliberate mark inside a link's rectangle can still be read as a
  tap.

## 0.1.1

Folder picker reaches the Supernote root, show-hidden toggle, DPI-scaled
overlays.

## 0.1.0

Initial release.
