const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  androidRepositoryHost,
  bootstrapAndroidCommandLineTools,
  pruneOldAndroidCommandLineTools,
} = require('../src/android-sdk');
const {
  cleanupSupersededAndroidAvds,
  prepareAndroidEnvironment,
} = require('../src/android');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-storage-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeTools(sdk, name) {
  const directory = path.join(sdk, 'cmdline-tools', name);
  const manager = path.join(directory, 'bin',
    process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
  fs.mkdirSync(path.dirname(manager), { recursive: true });
  fs.writeFileSync(manager, 'fixture');
  return manager;
}

function bootstrapFixture(sdk, overrides = {}) {
  const archive = Buffer.from('fixture archive');
  const checksum = crypto.createHash('sha1').update(archive).digest('hex');
  const xml = '<remotePackage path="cmdline-tools;latest">'
    + '<revision><major>23</major><minor>0</minor></revision>'
    + '<archives><archive><complete><size>15</size><checksum>' + checksum
    + '</checksum><url>tools.zip</url></complete><host-os>'
    + androidRepositoryHost() + '</host-os></archive></archives></remotePackage>';
  return {
    sdk,
    env: { PATH: '' },
    promptYesNo: async () => true,
    fetchFn: async () => ({ ok: true, text: async () => xml }),
    downloadFn: async (_url, destination) => fs.writeFileSync(destination, archive),
    extractFn: (_archive, extracted) => {
      const directory = path.join(extracted, 'cmdline-tools', 'bin');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory,
        process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'), 'fixture');
    },
    captureFn: () => ({ status: 0, stdout: '23.0', stderr: '' }),
    log: () => {},
    ...overrides,
  };
}

test('prunes only older OnRamp tools after the replacement validates', async t => {
  const sdk = temporaryDirectory(t);
  const old = makeTools(sdk, 'onramp-22.0');
  const retained = ['latest', '22.0', 'onramp-custom', 'onramp-24.0', 'onramp-23.0-2']
    .map(name => makeTools(sdk, name));
  const external = path.join(sdk, 'outside');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep'), 'keep');
  fs.symlinkSync(external, path.join(sdk, 'cmdline-tools', 'onramp-21.0'), 'junction');
  const manager = await bootstrapAndroidCommandLineTools(bootstrapFixture(sdk, {
    captureFn: () => {
      assert.equal(fs.existsSync(old), true, 'cleanup must wait for validation');
      return { status: 0, stdout: '23.0', stderr: '' };
    },
  }));
  assert.equal(fs.existsSync(manager), true);
  assert.equal(fs.existsSync(old), false);
  for (const file of retained) assert.equal(fs.existsSync(file), true);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(sdk, 'cmdline-tools', 'onramp-21.0')).isSymbolicLink(), true);
});

test('cleans older tools when a validated existing replacement is reused', async t => {
  const sdk = temporaryDirectory(t);
  const old = makeTools(sdk, 'onramp-22.0-2');
  const current = makeTools(sdk, 'onramp-23.0');
  const manager = await bootstrapAndroidCommandLineTools(bootstrapFixture(sdk));
  assert.equal(manager, current);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(current), true);
});

test('keeps old tools when the download or replacement validation fails', async t => {
  for (const failure of ['checksum', 'validation']) {
    const sdk = path.join(temporaryDirectory(t), failure);
    const old = makeTools(sdk, 'onramp-22.0');
    const overrides = failure === 'checksum'
      ? { downloadFn: async (_url, destination) => fs.writeFileSync(destination, 'bad') }
      : { captureFn: () => ({ status: 1, stdout: '', stderr: 'broken' }) };
    await assert.rejects(
      bootstrapAndroidCommandLineTools(bootstrapFixture(sdk, overrides)),
      /checksum verification|could not be started/
    );
    assert.equal(fs.existsSync(old), true);
  }
});

test('refuses tool cleanup when the replacement redirects to an older install', t => {
  const sdk = temporaryDirectory(t);
  const old = makeTools(sdk, 'onramp-22.0');
  const current = makeTools(sdk, 'onramp-23.0');
  fs.rmSync(current);
  fs.symlinkSync(old, current);
  pruneOldAndroidCommandLineTools(sdk, current, { log: () => {} });
  assert.equal(fs.existsSync(old), true);
});

test('reports tool cleanup failures without invalidating the current installation', t => {
  const sdk = temporaryDirectory(t);
  const old = makeTools(sdk, 'onramp-22.0');
  const current = makeTools(sdk, 'onramp-23.0');
  const logs = [];
  assert.doesNotThrow(() => pruneOldAndroidCommandLineTools(sdk, current, {
    log: message => logs.push(message),
    removeDirectory: () => { throw new Error('permission denied'); },
  }));
  assert.equal(fs.existsSync(old), true);
  assert.equal(fs.existsSync(current), true);
  assert.match(logs.join('\n'), /permission denied.*current tools remain available/);
});

function avdFixture(t) {
  const directory = temporaryDirectory(t);
  const sdk = path.join(directory, 'sdk');
  const avdHome = path.join(directory, 'avd');
  const env = { ANDROID_AVD_HOME: avdHome };
  const avds = [];
  const deletions = [];
  const prompts = [];
  const logs = [];
  const active = new Map();
  function makeAvd(name, api = '37.1', sharp = true) {
    const avdDirectory = path.join(avdHome, name + '.avd');
    const architecture = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
    const image = path.join('system-images', 'android-' + api, 'google_apis', architecture);
    fs.mkdirSync(avdDirectory, { recursive: true });
    fs.mkdirSync(path.join(sdk, image), { recursive: true });
    fs.writeFileSync(path.join(sdk, image, 'system.img'), 'fixture image');
    fs.writeFileSync(path.join(avdHome, name + '.ini'), 'path=' + avdDirectory + '\n');
    fs.writeFileSync(path.join(avdDirectory, 'config.ini'),
      'image.sysdir.1=' + image + '\n'
      + 'hw.lcd.width=' + (sharp ? 1080 : 320) + '\n'
      + 'hw.lcd.height=' + (sharp ? 2400 : 640) + '\n'
      + 'hw.lcd.density=' + (sharp ? 420 : 160) + '\n');
    fs.writeFileSync(path.join(avdDirectory, 'user-data'), 'preserve unless approved');
    avds.push(name);
    return avdDirectory;
  }
  const replacement = 'OnRamp_API_37_1_2';
  makeAvd(replacement);
  function captureFn(command, args) {
    if (command === 'adb' && args[0] === 'devices') {
      return { status: 0, stdout: 'List of devices attached\n'
        + [...active].map(([serial]) => serial + '\tdevice').join('\n') };
    }
    if (command === 'adb' && args[2] === 'emu') {
      return { status: 0, stdout: active.get(args[1]) + '\nOK\n' };
    }
    if (command === 'avdmanager' && args[0] === 'delete') {
      const name = args[3];
      deletions.push(name);
      fs.rmSync(path.join(avdHome, name + '.avd'), { recursive: true });
      fs.rmSync(path.join(avdHome, name + '.ini'));
      return { status: 0, stdout: '' };
    }
    throw new Error('Unexpected command ' + command + ' ' + args.join(' '));
  }
  return {
    avdHome, sdk, makeAvd, deletions, prompts, logs, active, captureFn,
    options: {
      avdManager: 'avdmanager', replacement, avds,
      environment: { sdk, env, adb: 'adb' }, captureFn,
      promptYesNo: async question => { prompts.push(question); return true; },
      log: message => logs.push(message),
    },
  };
}

test('offers exact older OnRamp AVDs, deletes approved data, and keeps shared images', async t => {
  const fixture = avdFixture(t);
  fixture.makeAvd('OnRamp_API_36', '36');
  fixture.makeAvd('OnRamp_API_37_1', '37.1', false);
  const preserved = [
    fixture.makeAvd('My_Test_Phone', '35'),
    fixture.makeAvd('OnRamp_API_38', '38'),
    fixture.makeAvd('OnRamp_API_37_1_3'),
  ];
  const removed = await cleanupSupersededAndroidAvds(fixture.options);
  assert.deepEqual(removed, ['OnRamp_API_36', 'OnRamp_API_37_1']);
  assert.deepEqual(fixture.deletions, removed);
  assert.match(fixture.prompts[0], /OnRamp_API_36, OnRamp_API_37_1\? This permanently deletes.*app data/);
  for (const directory of preserved) assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(path.join(fixture.sdk, 'system-images', 'android-36')), true);
  assert.equal(fs.existsSync(path.join(fixture.avdHome, fixture.options.replacement + '.avd')), true);
});

test('preserves device data when cleanup is declined or replacement is invalid', async t => {
  for (const scenario of ['declined', 'missing', 'blurry']) {
    const fixture = avdFixture(t);
    const old = fixture.makeAvd('OnRamp_API_36', '36');
    if (scenario === 'declined') fixture.options.promptYesNo = async () => false;
    if (scenario === 'missing') {
      fs.rmSync(path.join(fixture.avdHome, fixture.options.replacement + '.avd'), { recursive: true });
    }
    if (scenario === 'blurry') fixture.makeAvd(fixture.options.replacement, '37.1', false);
    assert.deepEqual(await cleanupSupersededAndroidAvds(fixture.options), []);
    assert.equal(fs.existsSync(path.join(old, 'user-data')), true);
    assert.deepEqual(fixture.deletions, []);
  }
});

test('new AVD config with a missing, empty, or linked system image never permits cleanup', async t => {
  for (const scenario of ['missing', 'empty', 'linked-file', 'linked-directory']) {
    const fixture = avdFixture(t);
    const old = fixture.makeAvd('OnRamp_API_36', '36');
    const architecture = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
    const image = path.join(fixture.sdk, 'system-images', 'android-37.1', 'google_apis', architecture);
    const systemImage = path.join(image, 'system.img');
    if (scenario === 'missing') fs.rmSync(systemImage);
    if (scenario === 'empty') fs.writeFileSync(systemImage, '');
    if (scenario === 'linked-file') {
      const other = path.join(fixture.sdk, 'external-system.img');
      fs.writeFileSync(other, 'fixture image');
      fs.rmSync(systemImage);
      fs.symlinkSync(other, systemImage);
    }
    if (scenario === 'linked-directory') {
      const other = path.join(fixture.sdk, 'external-image');
      fs.renameSync(image, other);
      fs.symlinkSync(other, image, 'junction');
    }
    assert.deepEqual(await cleanupSupersededAndroidAvds(fixture.options), []);
    assert.deepEqual(fixture.prompts, []);
    assert.deepEqual(fixture.deletions, []);
    assert.equal(fs.existsSync(path.join(old, 'user-data')), true);
  }
});

test('protects active, locked, redirected, and uninspectable Android devices', async t => {
  const fixture = avdFixture(t);
  fixture.makeAvd('OnRamp_API_36', '36');
  fixture.active.set('emulator-5554', 'OnRamp_API_36');
  const locked = fixture.makeAvd('OnRamp_API_35', '35');
  fs.mkdirSync(path.join(locked, 'hardware-qemu.ini.lock'));
  const redirected = fixture.makeAvd('OnRamp_API_34', '34');
  const outside = path.join(fixture.avdHome, 'elsewhere.avd');
  fs.renameSync(redirected, outside);
  fs.symlinkSync(outside, redirected, 'junction');
  assert.deepEqual(await cleanupSupersededAndroidAvds(fixture.options), []);
  assert.deepEqual(fixture.prompts, []);

  fixture.active.clear();
  fixture.options.captureFn = () => ({ status: 0, stdout: 'List of devices attached\nemulator-5554\toffline\n' });
  assert.deepEqual(await cleanupSupersededAndroidAvds(fixture.options), []);
  assert.match(fixture.logs.join('\n'), /offline or still starting/);
  assert.deepEqual(fixture.deletions, []);
});

test('rechecks activity, locks, and device configuration after cleanup approval', async t => {
  for (const scenario of ['running', 'locked', 'config', 'replacement']) {
    const fixture = avdFixture(t);
    const old = fixture.makeAvd('OnRamp_API_36', '36');
    fixture.options.promptYesNo = async () => {
      if (scenario === 'running') fixture.active.set('emulator-5554', 'OnRamp_API_36');
      if (scenario === 'locked') fs.writeFileSync(path.join(old, 'hardware-qemu.ini.lock'), 'busy');
      if (scenario === 'config') fs.appendFileSync(path.join(old, 'config.ini'), 'changed=yes\n');
      if (scenario === 'replacement') {
        fs.rmSync(path.join(fixture.avdHome, fixture.options.replacement + '.avd'), { recursive: true });
      }
      return true;
    };
    assert.deepEqual(await cleanupSupersededAndroidAvds(fixture.options), []);
    assert.deepEqual(fixture.deletions, []);
    assert.equal(fs.existsSync(path.join(old, 'user-data')), true);
  }
});

test('failed Android device deletion remains nonfatal and is reported', async t => {
  const fixture = avdFixture(t);
  const old = fixture.makeAvd('OnRamp_API_36', '36');
  fixture.options.captureFn = (command, args) => command === 'avdmanager'
    ? { status: 1, stdout: '', stderr: 'busy' }
    : fixture.captureFn(command, args);
  assert.deepEqual(await cleanupSupersededAndroidAvds(fixture.options), []);
  assert.equal(fs.existsSync(old), true);
  assert.match(fixture.logs.join('\n'), /could not delete.*Continuing with the replacement/);
});

test('Android preparation reaches cleanup only after a successful replacement creation', async t => {
  for (const fails of [true, false]) {
    const fixture = avdFixture(t);
    const { replacement } = fixture.options;
    fs.rmSync(path.join(fixture.avdHome, replacement + '.avd'), { recursive: true });
    fs.rmSync(path.join(fixture.avdHome, replacement + '.ini'));
    const old = fixture.makeAvd('OnRamp_API_37_1', '37.1', false);
    const manager = makeTools(fixture.sdk, 'latest');
    const commandSuffix = process.platform === 'win32' ? '.bat' : '';
    const executableSuffix = process.platform === 'win32' ? '.exe' : '';
    const avdManager = path.join(path.dirname(manager), 'avdmanager' + commandSuffix);
    const emulator = path.join(fixture.sdk, 'emulator', 'emulator' + executableSuffix);
    const adb = path.join(fixture.sdk, 'platform-tools', 'adb' + executableSuffix);
    const javaHome = path.join(fixture.sdk, 'jdk');
    for (const file of [avdManager, emulator, adb, path.join(javaHome, 'bin', 'java' + executableSuffix)]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture');
    }
    const architecture = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
    const imagePackage = 'system-images;android-37.1;google_apis;' + architecture;
    const packages = new Map([
      ['emulator', { path: 'emulator', installedVersion: '37.1.11' }],
      ['platform-tools', { path: 'platform-tools', installedVersion: '37.0.1' }],
      [imagePackage, { path: imagePackage, installedVersion: '10' }],
    ]);
    let inventoryCalls = 0;
    const options = {
      sdk: fixture.sdk, javaHome,
      env: { ...fixture.options.environment.env, PATH: '' },
      // This test exercises AVD cleanup only. An empty subsequent SDK inventory
      // skips image cleanup before it can inspect the host's actual AVD roots.
      listPackages: () => inventoryCalls++ === 0 ? packages : new Map(),
      emulatorArchitectureMismatch: () => null,
      promptYesNo: fixture.options.promptYesNo,
      log: fixture.options.log,
      captureFn: (command, args) => {
        if (command === manager) return { status: 0, stdout: '23.0' };
        if (command === emulator && args[0] === '-version') {
          return { status: 0, stdout: 'Android emulator version 37.1.11.0' };
        }
        if (command === emulator && args[0] === '-list-avds') {
          return { status: 0, stdout: fs.readdirSync(fixture.avdHome)
            .filter(name => name.endsWith('.ini')).map(name => name.slice(0, -4)).join('\n') };
        }
        if (command === avdManager && args[0] === 'list') {
          return { status: 0, stdout: 'id: 57 or "pixel_10"\n    Name: Pixel 10' };
        }
        if (command === avdManager && args[0] === 'create') {
          if (fails) throw new Error('fixture creation failure');
          assert.equal(args[args.indexOf('--name') + 1], replacement);
          fixture.makeAvd(replacement);
          return { status: 0, stdout: '' };
        }
        if (command === avdManager) return fixture.captureFn('avdmanager', args);
        if (command === adb) return fixture.captureFn('adb', args);
        throw new Error('Unexpected native command ' + command);
      },
    };
    if (fails) {
      await assert.rejects(prepareAndroidEnvironment(options), /fixture creation failure/);
      assert.equal(fs.existsSync(old), true);
      assert.equal(fixture.prompts.length, 1);
      assert.deepEqual(fixture.deletions, []);
    } else {
      const environment = await prepareAndroidEnvironment(options);
      assert.equal(environment.avd, replacement);
      assert.equal(fixture.prompts.length, 2);
      assert.match(fixture.prompts[1], /This permanently deletes/);
      assert.deepEqual(fixture.deletions, ['OnRamp_API_37_1']);
      assert.equal(fs.existsSync(old), false);
    }
  }
});
