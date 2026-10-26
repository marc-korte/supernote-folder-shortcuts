# Nomad v0.3.2 beta validation

**Status: pending a test on a physical Nomad (A6 X2).** The completed Manta
checks do not establish Nomad compatibility. Confirm the physical product from
its label or purchase information: the tested Manta reports
`Supernote_Nomad` to Android, so that model string is not proof.

Use the full [v0.3.2 release package](https://github.com/marc-korte/supernote-folder-shortcuts/releases/tag/v0.3.2),
`SupernoteFolderShortcuts.snplg`. The tested package has SHA-256
`bbc1bf8315ea3ac9c87edc99db336e9e26abe473a87dd37d1ec18f4b36606233`
and logs build `0.3.2-issues-10-19-r2`.

## Setup

1. Copy the `.snplg` to `/MyStyle/`, install it through the plugin manager, and
   confirm version **0.3.2** is enabled. A JavaScript-only hot reload cannot
   install these native changes.
2. Open **Link to folder** and grant file read/write access with **Always allow**.
3. Use a disposable note and folders named `Parent`, `Parent/Child`, `Empty`,
   and `Palm`. Leave `Empty` empty. Link matching words in different parts of
   the page, including near the toolbar. Include a typed or sticker link if used
   in normal note-taking.
4. Record firmware, plugin version, orientation, toolbar position, page-turn
   touch settings, and any page zoom. Begin at normal page scale in portrait;
   repeat the input/menu cases in other orientations you use.

The raw fallback is deliberately limited to the verified Manta panel and
orientation. An **unverified raw fallback** message on a Nomad is expected;
normal finger and pen operation must work through the SDK. Do not enable the
Manta coordinate mapping to make a Nomad test pass.

## Physical checks

Use real fingers, pen, and palm contacts. Android `adb input tap` bypasses the
raw input path and is not a substitute. Mark a case failed if it opens an
unexpected folder, opens twice, or loses a valid tap.

| Case | Action and expected result |
| --- | --- |
| Normal input | Tap each linked word with a finger and then a pen, returning after each open. Each opens its own folder once. Blank paper, toolbar buttons, and page controls never open folders. |
| File manager | After opening `Parent/Child`, use breadcrumbs and unrelated folders. Navigation follows the selected item, without jumps to note links. |
| Document return | Open a PDF, return with **Last Opened Note**, then immediately test finger and pen links. Repeat with an EPUB and with another note. No first tap is lost or misdirected. |
| Empty destination | Tap `Empty`, return, wait at least **130 seconds**, and tap it again. Restart the plugin and reopen the note; the stored link still opens the empty folder. The picker can also browse into and link that empty folder. |
| Menu dismissal | Open an in-note Settings or lasso menu, then tap a linked word behind it to dismiss the menu. Stay in the note. Repeat with the status/sidebar overlay and the plugin picker. After closing, wait **2 seconds** and verify a normal link tap works. |
| Overlapping links | Put `Parent` and `Child` words on adjacent lines so their hit areas overlap. Tap the center of each word and near the gap. Each word selects its own destination; near-gap taps favor the closest rectangle rather than the first-created link. |
| Pending geometry | Create one new link at a time, close the picker, and let the note save. Once a stored-page scan sees it, each link is counted once, and the earlier lasso box does not remain an extra tap target. |
| Palm | Briefly rest the side of a hand on `Palm`, including while holding the pen nearby. Stay in the note. A subsequent deliberate finger tap still opens `Palm` once. |
| Move/unlink | Move a linked word with the lasso and deselect it. The new position works and the old position stops working after geometry refresh. Remove its link; after **35 seconds**, the former location no longer opens a folder. |

If any case fails, record the exact steps, tap location, expected/actual folder,
and whether the failure repeats. Keep Nomad compatibility unverified until the
report is reviewed; a failing case is useful evidence, not a reason to omit it.

## Optional ADB evidence

Record the firmware and display size:

```sh
adb shell getprop ro.build.display.id
adb shell wm size
```

Capture plugin logs while running the checks, then stop with Ctrl+C:

```sh
adb logcat -b main -v time -T 1 -s ReactNativeJS:I '[folder-link-native]:V' > nomad-v0.3.2.log
```

Note the time of each failed action in the report. Look for the build stamp,
single `openFolder` attempts, ignored menu/foreground taps, listener renewal,
and page scans. Leave the note before using a separate `uiautomator` session;
the plugin uses that connection while note links are armed.

## Tester report

```text
Physical device and how identified:
Firmware:
Plugin version / build stamp / package SHA-256:
Orientation(s), toolbar position, page-turn settings, zoom:
Test date:

[ ] Normal finger and pen input
[ ] File-manager navigation
[ ] PDF / EPUB / note returns
[ ] Empty folder after 130 seconds and plugin restart
[ ] In-note menu / status-sidebar / picker dismissal
[ ] Overlapping-link selection
[ ] Pending-link count and geometry
[ ] Palm rejection followed by deliberate finger tap
[ ] Move and unlink

For each unchecked or failing case:
- Steps and timestamp:
- Expected result:
- Actual result / destination:
- Repeatable? Finger, pen, or palm?
- Relevant log excerpt or attachment:
```
