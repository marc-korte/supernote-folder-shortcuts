import fs from 'fs';
import os from 'os';
import path from 'path';
import {spawn} from 'child_process';

const repo = path.resolve(__dirname, '..');
let temporary;
let project;
let bin;

const write = (relative, content, executable = false) => {
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content, {mode: executable ? 0o755 : 0o644});
};

const fake = (name, content) => {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`, {mode: 0o755});
};

const run = (script, extraEnv = {}) => {
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FIXTURE: project,
    RELOAD_TIMEOUT_S: '1',
    ...extraEnv,
  };
  delete env.ANDROID_HOME;
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(project, script)], {cwd: project, env});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({status, stdout, stderr}));
  });
};

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-link-scripts-'));
  project = path.join(temporary, 'project');
  bin = path.join(temporary, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  write('package.json', JSON.stringify({name: 'FixturePlugin', version: '1.0.0'}));
  write('PluginConfig.json', JSON.stringify({pluginID: 'fixture', iconPath: ''}));
  write('index.js', "const BUILD_ID = 'fixture-build';\n");
  write('buildPlugin.sh', fs.readFileSync(path.join(repo, 'buildPlugin.sh'), 'utf8'));
  write('scripts/deploy-bundle.sh', fs.readFileSync(path.join(repo, 'scripts/deploy-bundle.sh'), 'utf8'));
  fake('java', 'echo \'openjdk version "21"\' >&2');
  fake('npx', `
while (( $# )); do
  if [[ "$1" == --bundle-output ]]; then
    shift
    printf fresh-js > "$1"
    exit 0
  fi
  shift
done
exit 1`);
  // No need to wait a real second for the adb fixture to publish its logs.
  fake('sleep', ':');
});

afterEach(() => {
  fs.rmSync(temporary, {recursive: true, force: true});
});

const nativeFixture = (mode, manualPackage = true) => {
  write('android/app/src/main/java/Native.java', 'class Native {}');
  if (manualPackage) {
    write('android/app/src/main/java/MainApplication.kt', 'package fixture\nfun packages() { add(FixturePackage()) }');
  }
  write('build/generated/app.npk', 'stale-native');
  write('build/outputs/FixturePlugin.snplg', 'stale-package');
  write('android/app/build/outputs/apk/release/app-release-custom.apk', 'stale-release');
  write('android/app/build/outputs/apk/debug/app-debug-custom.apk', 'stale-debug');
  write('android/gradlew', `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == buildCustomApkDebug ]]
# Required even when Gradle fails: no previous payload can be reused.
test ! -e "$FIXTURE/build/generated/app.npk"
test ! -e "$FIXTURE/android/app/build/outputs/apk/debug/app-debug-custom.apk"
printf '%s' "\${ANDROID_HOME:-}" > "$FIXTURE/sdk-used"
${mode === 'fail' ? 'exit 9' : ''}
${mode === 'success' ? 'mkdir -p app/build/outputs/apk/debug; printf fresh-native > app/build/outputs/apk/debug/app-debug-custom.apk' : ''}
`, true);
};

test('#19 a failed native build cannot package an old native payload or leave an installable output', async () => {
  nativeFixture('fail');
  const result = await run('buildPlugin.sh');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('APK build failed');
  expect(result.stderr).not.toContain('Plugin package created');
  expect(fs.existsSync(path.join(project, 'build/generated/app.npk'))).toBe(false);
  expect(fs.existsSync(path.join(project, 'build/outputs/FixturePlugin.snplg'))).toBe(false);
});

test('#19 success without the expected new custom debug APK cannot fall back to a stale release APK', async () => {
  nativeFixture('no-output');
  const result = await run('buildPlugin.sh');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('Generated custom debug APK not found');
  expect(fs.existsSync(path.join(project, 'build/outputs/FixturePlugin.snplg'))).toBe(false);
});

test('#19 native sources require a build even without manually registered React packages', async () => {
  nativeFixture('success', false);
  const result = await run('buildPlugin.sh');
  expect(result.status).toBe(0);
  expect(fs.readFileSync(path.join(project, 'build/generated/app.npk'), 'utf8')).toBe('fresh-native');
  expect(fs.existsSync(path.join(project, 'build/outputs/FixturePlugin.snplg'))).toBe(true);
  const config = JSON.parse(fs.readFileSync(path.join(project, 'build/generated/PluginConfig.json'), 'utf8'));
  expect(config.nativeCodePackage).toBe('/app.npk');
  // On a host with a conventional SDK location, an unset ANDROID_HOME finds it.
  const candidates = ['Library/Android/sdk', 'Android/Sdk'].map(relative => path.join(os.homedir(), relative));
  const expectedSdk = candidates.find(candidate => fs.existsSync(candidate));
  if (expectedSdk) {
    expect(fs.readFileSync(path.join(project, 'sdk-used'), 'utf8')).toBe(expectedSdk);
  }
});

const deployFixture = mode => {
  fake('adb', `
printf '%s\\n' "$*" >> "$FIXTURE/adb-calls"
case "$1" in
  get-state) echo device ;;
  push) [[ "$3" == /data/local/tmp/FixturePlugin.bundle ]] ;;
  shell)
    if [[ "$2" == log ]]; then
      printf 'I/FolderLinkDeploy: %s\\n' "$5" >> "$FIXTURE/device-log"
    elif [[ "$2 $3 $4" == 'am broadcast -n' ]]; then
      touch "$FIXTURE/broadcast"
      ${mode === 'success' ? 'echo "I/ReactNativeJS: [folder-link] build fixture-build starting" >> "$FIXTURE/device-log"' : ''}
      ${mode === 'wrong-build' ? 'echo "I/ReactNativeJS: [folder-link] build other-build starting" >> "$FIXTURE/device-log"' : ''}
      ${mode === 'prefix-build' ? 'echo "I/ReactNativeJS: [folder-link] build fixture-build-old starting" >> "$FIXTURE/device-log"' : ''}
    else
      exit 1
    fi ;;
  logcat)
    if [[ "$2" == -c ]]; then echo "failed to clear the kernel log" >&2; exit 1; fi
    [[ "$*" == 'logcat -b main -d -v brief' ]]
    cat "$FIXTURE/device-log" ;;
  *) exit 1 ;;
esac`);
  write('device-log', 'I/ReactNativeJS: [folder-link] build fixture-build starting\n');
};

test('#10 an old matching build stamp cannot confirm a no-op DEBUG broadcast', async () => {
  deployFixture('no-op');
  const result = await run('scripts/deploy-bundle.sh');
  expect(result.status).toBe(1);
  expect(fs.existsSync(path.join(project, 'broadcast'))).toBe(true);
  expect(result.stderr).toContain('2609111001 disables DEBUG hot-loading');
  expect(result.stderr).toContain('install the .snplg');
  expect(result.stdout).not.toContain('Reloaded.');
});

test('#10 a fresh expected stamp confirms reload without clearing the inaccessible kernel log', async () => {
  deployFixture('success');
  const result = await run('scripts/deploy-bundle.sh');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Reloaded. Live build:');
  const calls = fs.readFileSync(path.join(project, 'adb-calls'), 'utf8');
  expect(calls).toContain('push ');
  expect(calls).toContain('/data/local/tmp/FixturePlugin.bundle');
  expect(calls).not.toContain('MyStyle');
  expect(calls).not.toContain('logcat -c');
});

test.each(['wrong-build', 'prefix-build'])('#10 a fresh %s stamp cannot confirm the bundled build', async mode => {
  deployFixture(mode);
  const result = await run('scripts/deploy-bundle.sh');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('different build');
});
