const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareAndroidEnvironment } = require('../src/android');

function fixture(t, { latestApi = 35, imageRevision = false, noAvd = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-force-android-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk');
  const javaHome = path.join(root, 'jdk');
  const avdHome = path.join(root, 'avds');
  const executable = process.platform === 'win32' ? '.exe' : '';
  const script = process.platform === 'win32' ? '.bat' : '';
  const sdkManager = path.join(sdk, 'cmdline-tools/latest/bin', 'sdkmanager' + script);
  const avdManager = path.join(path.dirname(sdkManager), 'avdmanager' + script);
  const emulator = path.join(sdk, 'emulator', 'emulator' + executable);
  const adb = path.join(sdk, 'platform-tools', 'adb' + executable);
  const arch = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const image = api => `system-images;android-${api};google_apis;${arch}`;
  const avds = [];
  const prompts = [];
  const installs = [];
  const logs = [];
  for (const file of [sdkManager, avdManager, emulator, adb,
    path.join(javaHome, 'bin', 'java' + executable)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
  fs.mkdirSync(avdHome, { recursive: true });
  const writeImage = packagePath => {
    const directory = path.join(sdk, packagePath.replaceAll(';', path.sep));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'system.img'), 'fixture image');
  };
  writeImage(image(35));
  const writeAvd = (name, packagePath) => {
    const directory = path.join(avdHome, name + '.avd');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(avdHome, name + '.ini'), `path=${directory}\n`);
    fs.writeFileSync(path.join(directory, 'config.ini'),
      `image.sysdir.1=${packagePath.replaceAll(';', path.sep)}${path.sep}\n`
      + 'hw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\n');
    fs.writeFileSync(path.join(directory, 'user-data-marker'), 'preserve');
    avds.push(name);
  };
  if (!noAvd) writeAvd('OnRamp_API_35', image(35));
  const packages = new Map([
    ['emulator', { path: 'emulator', installedVersion: '36.2.1', availableVersion: '37.1.11' }],
    ['platform-tools', { path: 'platform-tools', installedVersion: '37.0.0' }],
    [image(35), { path: image(35), installedVersion: '10', availableVersion: imageRevision ? '11' : '10' }],
  ]);
  if (latestApi !== 35) {
    packages.set(image(latestApi), { path: image(latestApi), availableVersion: '1' });
  }
  const options = {
    sdk, javaHome,
    env: { ANDROID_AVD_HOME: avdHome, PATH: '' },
    emulatorArchitectureMismatch: () => null,
    listPackages: () => packages,
    log: message => logs.push(message),
    promptYesNo: async question => { prompts.push(question); return false; },
    installPackages: async (_manager, _sdk, _env, selected) => {
      installs.push(selected);
      for (const name of selected) {
        packages.get(name).installedVersion = packages.get(name).availableVersion;
        if (name.startsWith('system-images;')) {
          writeImage(name);
        }
      }
    },
    captureFn: (command, args) => {
      let stdout = '';
      if (command === sdkManager && args[0] === '--version') stdout = '23.0\n';
      else if (command === emulator && args[0] === '-version') {
        stdout = `Android emulator version ${packages.get('emulator').installedVersion}.0\n`;
      } else if (command === emulator && args[0] === '-list-avds') stdout = avds.join('\n');
      else if (command === avdManager && args[0] === 'list') stdout = 'id: 57 or "pixel_10"\n    Name: Pixel 10\n';
      else if (command === avdManager && args[0] === 'create') {
        writeAvd(args[args.indexOf('--name') + 1], args[args.indexOf('--package') + 1]);
      } else if (command === adb && args[0] === 'devices') stdout = 'List of devices attached\n';
      else assert.fail(`Unexpected SDK command: ${command} ${args.join(' ')}`);
      return { status: 0, stdout, stderr: '' };
    },
  };
  return { options, prompts, installs, logs, packages, image, avdHome, emulator, adb };
}

test('force updates Android Emulator without prompting, even with a declining input handler', async t => {
  const f = fixture(t);
  await prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.installs, [['emulator']]);
  assert.ok(f.logs.some(line => /--force:.*37\.1\.11/.test(line)));
});

test('Android updates remain opt-in without force', async t => {
  const f = fixture(t);
  await prepareAndroidEnvironment(f.options);
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /Upgrade now/);
  assert.deepEqual(f.installs, []);
});

test('force updates an installed Android system image revision without prompting', async t => {
  const f = fixture(t, { imageRevision: true });
  await prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.installs, [['emulator'], [f.image(35)]]);
});

test('force updates to a newer Android API but still asks before deleting the old AVD', async t => {
  const f = fixture(t, { latestApi: 36 });
  const result = await prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true });
  assert.deepEqual(f.installs, [['emulator'], [f.image(36)]]);
  assert.equal(result.avd, 'OnRamp_API_36');
  assert.ok(f.prompts.length > 0);
  assert.ok(f.prompts.every(question => /delete|remove/i.test(question)));
  assert.equal(fs.readFileSync(path.join(f.avdHome, 'OnRamp_API_35.avd/user-data-marker'), 'utf8'), 'preserve');
});

test('force does not consent to installing a missing Android Emulator', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.emulator);
  await assert.rejects(
    prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true }),
    /Emulator is not installed/
  );
  assert.match(f.prompts[0], /not installed.*Install/);
  assert.deepEqual(f.installs, []);
});

test('force does not consent to creating a first Android virtual device', async t => {
  const f = fixture(t, { noAvd: true });
  f.packages.get('emulator').availableVersion = '36.2.1';
  await assert.rejects(
    prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true }),
    /no usable virtual device/
  );
  assert.match(f.prompts[0], /No usable Android virtual device/);
  assert.deepEqual(f.installs, []);
});

test('force does not consent to removing and replacing a wrong-architecture emulator', async t => {
  const f = fixture(t);
  await assert.rejects(prepareAndroidEnvironment({
    ...f.options,
    forceEmulatorUpdates: true,
    emulatorArchitectureMismatch: () => ({ expected: 'arm64', installed: ['x86_64'] }),
  }), /cannot run this Mac/);
  assert.match(f.prompts[0], /Reinstall/);
  assert.deepEqual(f.installs, []);
});

test('force still asks before replacing a low-resolution-only Android device', async t => {
  const f = fixture(t);
  f.packages.get('emulator').availableVersion = '36.2.1';
  const config = path.join(f.avdHome, 'OnRamp_API_35.avd/config.ini');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8')
    .replace('width=1080', 'width=320')
    .replace('height=2400', 'height=640')
    .replace('density=420', 'density=160'));
  const result = await prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true });
  assert.equal(result.avd, 'OnRamp_API_35');
  assert.match(f.prompts[0], /Create a sharper Pixel-class device/);
  assert.deepEqual(f.installs, []);
});

test('force still asks before installing missing Android Platform-Tools', async t => {
  const f = fixture(t);
  fs.unlinkSync(f.adb);
  await assert.rejects(
    prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates: true }),
    /SDK Platform-Tools are required/
  );
  assert.match(f.prompts[0], /Platform-Tools are missing/);
  assert.deepEqual(f.installs, []);
});

test('force never suppresses an Android package installation failure', async t => {
  const f = fixture(t);
  await assert.rejects(prepareAndroidEnvironment({
    ...f.options,
    forceEmulatorUpdates: true,
    installPackages: async () => { throw new Error('Package checksum mismatch'); },
  }), /checksum mismatch/);
  assert.deepEqual(f.prompts, []);
});
