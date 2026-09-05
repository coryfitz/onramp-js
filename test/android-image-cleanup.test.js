const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupSupersededAndroidSystemImages,
} = require('../src/android-image-cleanup');

const OLD = 'system-images;android-35;google_apis;arm64-v8a';
const NEW = 'system-images;android-37.1;google_apis;arm64-v8a';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-image-cleanup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk');
  const homedir = path.join(root, 'home');
  const avdRoot = path.join(homedir, '.android', 'avd');
  fs.mkdirSync(sdk);
  fs.mkdirSync(avdRoot, { recursive: true });
  const packages = new Map();
  const calls = [];
  const questions = [];
  const logs = [];
  function install(packagePath, extra = {}) {
    const directory = path.join(sdk, ...packagePath.split(';'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'system.img'), 'fake system image');
    fs.writeFileSync(path.join(directory, 'source.properties'), 'AndroidVersion.CodeName=REL\n');
    packages.set(packagePath, { path: packagePath, installedVersion: '1', ...extra });
    return directory;
  }
  function avd(name, image = OLD, options = {}) {
    const locatorRoot = options.root || avdRoot;
    const directory = options.directory || path.join(locatorRoot, name + '.avd');
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(locatorRoot, { recursive: true });
    fs.writeFileSync(path.join(locatorRoot, name + '.ini'), options.relative
      ? 'path.rel=' + path.relative(path.dirname(locatorRoot), directory) + '\n'
      : 'path=' + directory + '\n');
    fs.writeFileSync(path.join(directory, 'config.ini'), 'image.sysdir.1='
      + (options.absolute ? path.join(sdk, ...image.split(';')) : image.replaceAll(';', '/'))
      + '\n' + (options.extra || ''));
    return directory;
  }
  install(NEW);
  install(OLD);
  const options = {
    sdkManager: '/fake/sdkmanager', sdk, env: {}, homedir,
    replacementPackagePath: NEW, packages,
    promptYesNo: async question => { questions.push(question); return true; },
    listPackagesFn: () => packages,
    removePackagesFn: async (...args) => {
      calls.push(args);
      for (const packagePath of args[3]) {
        packages.delete(packagePath);
        fs.rmSync(path.join(sdk, ...packagePath.split(';')), { recursive: true });
      }
    },
    log: message => logs.push(message),
  };
  return { root, sdk, avdRoot, avd, install, packages, options, calls, questions, logs };
}

test('offers only unused strictly older images of the same vendor and ABI', async t => {
  const f = fixture(t);
  const preserved = [
    'system-images;android-35;google_apis_playstore;arm64-v8a',
    'system-images;android-35;google_apis;x86_64',
    'system-images;android-UpsideDownCake;google_apis;arm64-v8a',
    'system-images;android-37.1-ext1;google_apis;arm64-v8a',
    'system-images;android-38;google_apis;arm64-v8a',
  ];
  preserved.forEach(packagePath => f.install(packagePath));
  const removed = await cleanupSupersededAndroidSystemImages(f.options);
  assert.deepEqual(removed, [OLD]);
  assert.equal(f.questions.length, 1);
  assert.match(f.questions[0], /shared SDK.*about/);
  assert.match(f.questions[0], /\(y\/N\)/);
  assert.ok(f.questions[0].includes(OLD));
  preserved.forEach(packagePath => assert.ok(!f.questions[0].includes(packagePath)));
  assert.deepEqual(f.calls, [['/fake/sdkmanager', f.sdk, {}, [OLD]]]);
  assert.ok(!fs.existsSync(path.join(f.sdk, ...OLD.split(';'), 'system.img')));
});

test('declining the package list preserves every image', async t => {
  const f = fixture(t);
  f.options.promptYesNo = async () => false;
  assert.deepEqual(await cleanupSupersededAndroidSystemImages(f.options), []);
  assert.deepEqual(f.calls, []);
});

test('protects non-OnRamp AVDs in custom locations and relative image paths', async t => {
  const f = fixture(t);
  f.avd('My_Android_Studio_Device', OLD, { directory: path.join(f.root, 'custom-device') });
  await cleanupSupersededAndroidSystemImages(f.options);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.questions, []);
});

test('protects absolute image paths and relative AVD locators', async t => {
  const f = fixture(t);
  f.avd('User_Phone', OLD, { absolute: true, relative: true });
  await cleanupSupersededAndroidSystemImages(f.options);
  assert.deepEqual(f.calls, []);
});

test('inspects direct AVD directories missing from emulator locator listings', async t => {
  const f = fixture(t);
  f.avd('Orphaned_Phone');
  fs.unlinkSync(path.join(f.avdRoot, 'Orphaned_Phone.ini'));
  await cleanupSupersededAndroidSystemImages(f.options);
  assert.deepEqual(f.calls, []);
});

test('checks default, user, emulator and legacy AVD roots despite overrides', async t => {
  for (const [variable, suffix] of [
    ['ANDROID_USER_HOME', 'avd'],
    ['ANDROID_EMULATOR_HOME', 'avd'],
    ['ANDROID_SDK_HOME', '.android/avd'],
    ['HOME', '.android/avd'],
  ]) {
    await t.test(variable, async st => {
      const f = fixture(st);
      const custom = path.join(f.root, 'custom');
      f.options.env = { ANDROID_AVD_HOME: path.join(f.root, 'override'), [variable]: custom };
      f.avd('Other_Project', OLD, { root: path.join(custom, suffix) });
      await cleanupSupersededAndroidSystemImages(f.options);
      assert.deepEqual(f.calls, []);
    });
  }
});

test('fails closed for broken, ambiguous or unreadable AVD metadata', async t => {
  for (const state of ['missing-config', 'missing-image', 'duplicate-key', 'relative-locator', 'unreadable-root']) {
    await t.test(state, async st => {
      const f = fixture(st);
      const directory = f.avd('Broken_Phone', NEW);
      const config = path.join(directory, 'config.ini');
      if (state === 'missing-config') fs.unlinkSync(config);
      if (state === 'missing-image') fs.writeFileSync(config, 'hw.lcd.width=1080\n');
      if (state === 'duplicate-key') fs.appendFileSync(config, 'image.sysdir.1=' + OLD.replaceAll(';', '/') + '\n');
      if (state === 'relative-locator') fs.writeFileSync(path.join(f.avdRoot, 'Broken_Phone.ini'), 'path=somewhere\n');
      if (state === 'unreadable-root') {
        const fakeRoot = path.join(f.root, 'not-a-directory');
        fs.writeFileSync(fakeRoot, 'unreadable');
        f.options.env.ANDROID_AVD_HOME = fakeRoot;
      }
      await cleanupSupersededAndroidSystemImages(f.options);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.questions, []);
      assert.match(f.logs[0], /cleanup skipped/);
    });
  }
});

test('protects secondary system image and explicit disk image references', async t => {
  for (const extra of [
    'image.sysdir.2=' + OLD.replaceAll(';', '/') + '\n',
    'disk.systemPartition.initPath=' + OLD.replaceAll(';', '/') + '/system.img\n',
  ]) {
    const f = fixture(t);
    f.avd('Mixed_Phone', NEW, { extra });
    await cleanupSupersededAndroidSystemImages(f.options);
    assert.deepEqual(f.calls, []);
  }
});

test('does not treat numeric preview packages as superseded stable images', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.sdk, ...OLD.split(';'), 'source.properties'), 'AndroidVersion.CodeName=Preview\n');
  await cleanupSupersededAndroidSystemImages(f.options);
  assert.deepEqual(f.questions, []);
  assert.deepEqual(f.calls, []);
});

test('rejects malformed package path segments before inspecting SDK directories', async t => {
  for (const [tag, abi] of [
    ['.', 'arm64-v8a'],
    ['..', 'arm64-v8a'],
    ['google_apis', '.'],
    ['google_apis', '..'],
    ['google_apis/../../outside', 'arm64-v8a'],
    ['google_apis', 'arm64-v8a/../../outside'],
  ]) {
    await t.test(tag + ';' + abi, async st => {
      const f = fixture(st);
      const replacement = 'system-images;android-37.1;' + tag + ';' + abi;
      const old = 'system-images;android-35;' + tag + ';' + abi;
      f.packages.set(replacement, { path: replacement, installedVersion: '1' });
      f.packages.set(old, { path: old, installedVersion: '1' });
      f.options.replacementPackagePath = replacement;
      assert.deepEqual(await cleanupSupersededAndroidSystemImages(f.options), []);
      assert.deepEqual(f.questions, []);
      assert.deepEqual(f.calls, []);
      // No inspection error: malformed segments were rejected before filesystem access.
      assert.deepEqual(f.logs, []);
      assert.ok(fs.existsSync(path.join(f.sdk, ...OLD.split(';'), 'system.img')));
    });
  }
});

test('requires a present and installed verified replacement', async t => {
  for (const state of ['not-installed', 'missing-files', 'preview']) {
    await t.test(state, async st => {
      const f = fixture(st);
      if (state === 'not-installed') f.packages.get(NEW).installedVersion = undefined;
      if (state === 'missing-files') fs.unlinkSync(path.join(f.sdk, ...NEW.split(';'), 'system.img'));
      if (state === 'preview') f.packages.get(NEW).installedVersion = '1 rc1';
      await cleanupSupersededAndroidSystemImages(f.options);
      assert.deepEqual(f.questions, []);
      assert.deepEqual(f.calls, []);
    });
  }
});

test('rechecks references, image identity and installed versions after consent', async t => {
  for (const change of ['new-avd', 'new-reference', 'candidate-version', 'replacement-version', 'replacement-file', 'candidate-file']) {
    await t.test(change, async st => {
      const f = fixture(st);
      const directory = f.avd('Existing_Phone', NEW);
      f.options.promptYesNo = async () => {
        if (change === 'new-avd') f.avd('New_User_Phone');
        if (change === 'new-reference') fs.writeFileSync(path.join(directory, 'config.ini'), 'image.sysdir.1=' + OLD.replaceAll(';', '/') + '\n');
        if (change === 'candidate-version') f.packages.get(OLD).installedVersion = '2';
        if (change === 'replacement-version') f.packages.get(NEW).installedVersion = '2';
        if (change === 'replacement-file') fs.unlinkSync(path.join(f.sdk, ...NEW.split(';'), 'system.img'));
        if (change === 'candidate-file') fs.appendFileSync(path.join(f.sdk, ...OLD.split(';'), 'system.img'), 'changed');
        return true;
      };
      await cleanupSupersededAndroidSystemImages(f.options);
      assert.deepEqual(f.calls, []);
      assert.match(f.logs[0], /cleanup skipped/);
    });
  }
});

test('rechecks before every removal and stops when a new reference appears', async t => {
  const f = fixture(t);
  const older = 'system-images;android-34;google_apis;arm64-v8a';
  f.install(older);
  const remove = f.options.removePackagesFn;
  f.options.removePackagesFn = async (...args) => {
    await remove(...args);
    f.avd('Created_During_Cleanup', OLD);
  };
  assert.deepEqual(await cleanupSupersededAndroidSystemImages(f.options), [older]);
  assert.equal(f.calls.length, 1);
});

test('does not report a successful no-op uninstall as removed storage', async t => {
  for (const state of ['unchanged', 'directory-only', 'inventory-only', 'nonzero-status']) {
    await t.test(state, async st => {
      const f = fixture(st);
      f.options.removePackagesFn = async () => {
        if (state === 'directory-only') fs.rmSync(path.join(f.sdk, ...OLD.split(';')), { recursive: true });
        if (state === 'inventory-only') f.packages.delete(OLD);
        return { status: state === 'nonzero-status' ? 1 : 0 };
      };
      assert.deepEqual(await cleanupSupersededAndroidSystemImages(f.options), []);
      assert.match(f.logs.at(-1), /cleanup skipped.*removal/);
      assert.ok(f.logs.every(message => !message.startsWith('Removed ')));
    });
  }
});

test('SDK inventory and uninstall errors are nonfatal', async t => {
  const f = fixture(t);
  f.options.removePackagesFn = async () => { throw new Error('SDK is busy'); };
  assert.deepEqual(await cleanupSupersededAndroidSystemImages(f.options), []);
  assert.match(f.logs.at(-1), /SDK is busy/);
  f.options.listPackagesFn = () => { throw new Error('Cannot list packages'); };
  assert.deepEqual(await cleanupSupersededAndroidSystemImages(f.options), []);
  assert.match(f.logs.at(-1), /Cannot list packages/);
});
