const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensurePreferredIosSimulatorRuntime } = require('../src/ios');
const { prepareAndroidEnvironment } = require('../src/android');
const { cleanupSupersededAndroidSystemImages } = require('../src/android-image-cleanup');

function iosFixture() {
  const previous = {
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
    version: '18.6', build: '22G86',
  };
  const replacement = {
    identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    version: '26.5', build: '23F77',
  };
  const runtimes = [previous, replacement];
  const oldId = '11111111-1111-1111-1111-111111111111';
  let images = runtimes.map((runtime, index) => ({
    identifier: index ? '22222222-2222-2222-2222-222222222222' : oldId,
    runtimeIdentifier: runtime.identifier, version: runtime.version, build: runtime.build,
    platformIdentifier: 'com.apple.platform.iphonesimulator',
    deletable: true, state: 'Ready',
  }));
  const prompts = [];
  const removed = [];
  const options = {
    architectureVariant: 'arm64', runtimeDownloadCachePath: null,
    preferredRuntime: () => replacement,
    inspectRuntimes: () => runtimes.filter(runtime => images.some(image => (
      image.runtimeIdentifier === runtime.identifier
    ))),
    inspectStorage: () => ({
      images,
      runtimes: runtimes.map(runtime => ({
        ...runtime, buildversion: runtime.build, isAvailable: true,
      })),
      devices: { [previous.identifier]: [{ state: 'Shutdown', udid: 'old-device' }] },
    }),
    promptYesNo: async question => { prompts.push(question); return false; },
    runCommand: () => assert.fail('Reused iOS runtime must not be downloaded'),
    captureFn: (_command, args) => {
      assert.deepEqual(args, ['simctl', 'runtime', 'delete', oldId]);
      removed.push(oldId);
      images = images.filter(image => image.identifier !== oldId);
      return { status: 0 };
    },
    log: () => {},
  };
  return { options, prompts, removed, runtimes, replacement };
}

for (const forceEmulatorUpdates of [false, true]) {
  test(`reused latest iOS runtime offers cleanup once; decline is respected (force=${forceEmulatorUpdates})`, async () => {
    const f = iosFixture();
    const result = await ensurePreferredIosSimulatorRuntime({ xcrun: 'fixture', env: {} }, {
      ...f.options, forceEmulatorUpdates,
    });
    assert.equal(result.changed, false);
    assert.deepEqual(result.installed, f.runtimes);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /Remove these older idle runtimes/);
    assert.match(f.prompts[0], /devices and app data will be kept/);
    assert.deepEqual(f.removed, []);
  });
}

test('reused iOS runtime cleanup refreshes installed inventory only after explicit approval', async () => {
  const f = iosFixture();
  const result = await ensurePreferredIosSimulatorRuntime({ xcrun: 'fixture', env: {} }, {
    ...f.options,
    promptYesNo: async question => { f.prompts.push(question); return true; },
  });
  assert.equal(f.prompts.length, 1);
  assert.equal(f.removed.length, 1);
  assert.deepEqual(result.installed, [f.replacement]);
});

test('reused iOS runtime cleanup skips ambiguous storage inventory', async () => {
  const f = iosFixture();
  await ensurePreferredIosSimulatorRuntime({ xcrun: 'fixture', env: {} }, {
    ...f.options, inspectStorage: () => { throw new Error('unreadable inventory'); },
  });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.removed, []);
});

function androidFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-cleanup-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk');
  const avdHome = path.join(root, 'avds');
  const javaHome = path.join(root, 'jdk');
  const script = process.platform === 'win32' ? '.bat' : '';
  const binary = process.platform === 'win32' ? '.exe' : '';
  const manager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager' + script);
  const avdManager = path.join(path.dirname(manager), 'avdmanager' + script);
  const emulator = path.join(sdk, 'emulator', 'emulator' + binary);
  const adb = path.join(sdk, 'platform-tools', 'adb' + binary);
  for (const file of [manager, avdManager, emulator, adb, path.join(javaHome, 'bin', 'java' + binary)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const architecture = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const image = api => `system-images;android-${api};google_apis;${architecture}`;
  const packages = new Map([
    ['emulator', { path: 'emulator', installedVersion: '37.1.11' }],
    ['platform-tools', { path: 'platform-tools', installedVersion: '37.0.1' }],
  ]);
  for (const api of [33, 34, 35]) {
    const directory = path.join(sdk, ...image(api).split(';'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'system.img'), 'fixture system image');
    packages.set(image(api), { path: image(api), installedVersion: '1' });
  }
  for (const api of [34, 35]) {
    const name = `OnRamp_API_${api}`;
    const directory = path.join(avdHome, name + '.avd');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(avdHome, name + '.ini'), `path=${directory}\n`);
    fs.writeFileSync(path.join(directory, 'config.ini'),
      `image.sysdir.1=${image(api).replaceAll(';', path.sep)}\n`
      + 'hw.lcd.width=1080\nhw.lcd.height=2400\nhw.lcd.density=420\n');
    fs.writeFileSync(path.join(directory, 'user-data'), 'preserve unless approved');
  }
  const prompts = [];
  const removedDevices = [];
  const removedImages = [];
  const options = {
    sdk, javaHome, env: { ANDROID_AVD_HOME: avdHome, HOME: root, PATH: '' },
    listPackages: () => packages,
    emulatorArchitectureMismatch: () => null,
    promptYesNo: async question => { prompts.push(question); return false; },
    installPackages: () => assert.fail('Reused Android packages must not be installed'),
    cleanupSystemImages: options => cleanupSupersededAndroidSystemImages({ ...options, homedir: root }),
    removePackages: (_manager, _sdk, _env, selected) => {
      for (const name of selected) {
        removedImages.push(name);
        fs.rmSync(path.join(sdk, ...name.split(';')), { recursive: true });
        packages.delete(name);
      }
    },
    log: () => {},
    captureFn: (command, args) => {
      let stdout = '';
      if (command === manager && args[0] === '--version') stdout = '23.0';
      else if (command === emulator && args[0] === '-version') stdout = 'Android emulator version 37.1.11.0';
      else if (command === emulator && args[0] === '-list-avds') {
        stdout = fs.readdirSync(avdHome).filter(name => name.endsWith('.ini'))
          .map(name => name.slice(0, -4)).join('\n');
      } else if (command === adb && args[0] === 'devices') stdout = 'List of devices attached\n';
      else if (command === avdManager && args[0] === 'delete') {
        const name = args[args.indexOf('--name') + 1];
        removedDevices.push(name);
        fs.rmSync(path.join(avdHome, name + '.avd'), { recursive: true });
        fs.rmSync(path.join(avdHome, name + '.ini'));
      } else assert.fail(`Unexpected command: ${command} ${args.join(' ')}`);
      return { status: 0, stdout, stderr: '' };
    },
  };
  return { options, prompts, removedDevices, removedImages, avdHome, packages, image };
}

for (const forceEmulatorUpdates of [false, true]) {
  test(`reused latest Android image/device offers separate cleanup and honors declines (force=${forceEmulatorUpdates})`, async t => {
    const f = androidFixture(t);
    const result = await prepareAndroidEnvironment({ ...f.options, forceEmulatorUpdates });
    assert.equal(result.avd, 'OnRamp_API_35');
    assert.equal(f.prompts.length, 2);
    assert.match(f.prompts[0], /Delete these older OnRamp devices: OnRamp_API_34/);
    assert.match(f.prompts[0], /permanently deletes.*app data/);
    assert.match(f.prompts[1], /Remove these older system images/);
    assert.ok(f.prompts[1].includes(f.image(33)));
    assert.ok(!f.prompts[1].includes(f.image(34)), 'declined device still references its image');
    assert.deepEqual(f.removedDevices, []);
    assert.deepEqual(f.removedImages, []);
    assert.equal(fs.readFileSync(path.join(f.avdHome, 'OnRamp_API_34.avd/user-data'), 'utf8'), 'preserve unless approved');
  });
}

test('reused Android replacement cleans only explicitly approved older devices and then unreferenced images', async t => {
  const f = androidFixture(t);
  const result = await prepareAndroidEnvironment({
    ...f.options, promptYesNo: async question => { f.prompts.push(question); return true; },
  });
  assert.equal(result.avd, 'OnRamp_API_35');
  assert.equal(f.prompts.length, 2);
  assert.deepEqual(f.removedDevices, ['OnRamp_API_34']);
  assert.deepEqual(f.removedImages, [f.image(33), f.image(34)]);
  assert.equal(fs.readFileSync(path.join(f.avdHome, 'OnRamp_API_35.avd/user-data'), 'utf8'), 'preserve unless approved');
  assert.ok(f.packages.has(f.image(35)));
});

test('declining a newer Android image does not offer cleanup against an uninstalled replacement', async t => {
  const f = androidFixture(t);
  f.packages.set(f.image(36), { path: f.image(36), availableVersion: '1' });
  const result = await prepareAndroidEnvironment(f.options);
  assert.equal(result.avd, 'OnRamp_API_35');
  assert.equal(f.prompts.length, 1);
  assert.match(f.prompts[0], /Install the latest image/);
  assert.deepEqual(f.removedDevices, []);
  assert.deepEqual(f.removedImages, []);
});

test('unreadable Android package inventory does not trigger cleanup', async t => {
  const f = androidFixture(t);
  await prepareAndroidEnvironment({ ...f.options, listPackages: () => { throw new Error('unreadable'); } });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.removedDevices, []);
  assert.deepEqual(f.removedImages, []);
});
