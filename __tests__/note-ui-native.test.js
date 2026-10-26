/** @jest-environment node */
const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let classes;
beforeAll(() => {
  classes = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-link-note-ui-'));
  execFileSync('javac', [
    '-d', classes,
    path.join(__dirname, '../android/app/src/main/java/com/supernotefoldershortcuts/NoteUiPolicy.java'),
    path.join(__dirname, 'native/NoteUiPolicyHarness.java'),
  ], {stdio: 'inherit'});
});
afterAll(() => {
  if (classes) {fs.rmSync(classes, {recursive: true, force: true});}
});

test.each([
  ['paper', 'allows the note canvas with the normal toolbar visible'],
  ['chrome', 'rejects toolbar, blank toolbar margins, and pagebar touches'],
  ['popup', 'blocks a same-window Settings popup and its dismissing tap'],
  ['edge-popup', 'rejects menu regions attached to a screen edge'],
  ['edge-popup-directions', 'blocks outside dismissal taps for edge panels in every direction'],
  ['chrome-orientations', 'preserves paper taps with normal narrow toolbars on each screen edge'],
  ['modal', 'blocks nonempty modal layers and unknown firmware layers'],
  ['unknown', 'fails closed for missing roots, other apps, and invalid coordinates'],
  ['hidden', 'ignores invisible dialogs'],
  ['revision', 'changes the UI revision for popups, independently of tap coordinates'],
  ['dismiss-grace', 'retains a bounded grace period when a popup disappears before tap handling'],
])('%s: %s', scenario => {
  execFileSync('java', ['-cp', classes, 'com.supernotefoldershortcuts.NoteUiPolicyHarness', scenario],
    {stdio: 'inherit'});
});
