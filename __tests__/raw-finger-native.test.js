/** @jest-environment node */
const {execFileSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let classes;
beforeAll(() => {
  classes = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-link-raw-test-'));
  execFileSync('javac', [
    '-d', classes,
    path.join(__dirname, '../android/app/src/main/java/com/supernotefoldershortcuts/RawFingerInput.java'),
    path.join(__dirname, 'native/RawFingerInputHarness.java'),
  ], {stdio: 'inherit'});
});
afterAll(() => {
  if (classes) {fs.rmSync(classes, {recursive: true, force: true});}
});

test.each([
  ['panel-mapping', 'enables only the measured Manta panel, geometry, and orientation'],
  ['fingers', 'accepts normal fingers and preserves contact metadata'],
  ['palm-size', 'rejects a palm and warns the SDK before release'],
  ['palm-shrinks', 'keeps a palm rejected after its contact size shrinks'],
  ['tool-types', 'rejects pen, palm, and unknown tool types for the whole gesture'],
  ['monitor-health', 'fails closed while a supported raw reader is unavailable'],
  ['physical-down', 'captures raw foreground and UI state at physical DOWN rather than release'],
  ['rejection-history', 'keeps bounded native palm intervals independent of JS event ordering'],
  ['gesture-guards', 'continues to reject drags, holds, multitouch, and invalid input'],
])('%s: %s', testCase => {
  execFileSync('java', ['-cp', classes, 'com.supernotefoldershortcuts.RawFingerInputHarness', testCase],
    {stdio: 'inherit'});
});
