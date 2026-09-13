const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { offerIosRuntimeCleanup } = require('../src/ios-runtime-cleanup');
const { ensurePreferredIosSimulatorRuntime } = require('../src/ios');

const environment = { xcrun: 'fixture-xcrun', env: {} };
const runtimeId = version => `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll('.', '-')}`;
const uuid = number => `${String(number).padStart(8, '0')}-1111-1111-1111-111111111111`;
const oldRuntime = runtimeId('18.6');
const absentRuntime = runtimeId('16.2');
const replacement = { identifier: runtimeId('26.5'), version: '26.5', build: '23F77' };

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-cleanup-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const deviceRoot = path.join(root, 'Devices');
  const device = (number, available, state = 'Shutdown') => {
    const dataPath = path.join(deviceRoot, uuid(number), 'data');
    fs.mkdirSync(dataPath, { recursive: true });
    return { udid: uuid(number), name: `Phone ${number}`, state, isAvailable: available, dataPath };
  };
  const old = { identifier: oldRuntime, version: '18.6', build: '22G86' };
  const storage = {
    images: [old, replacement].map((runtime, index) => {
      const imagePath = path.join(root, `runtime-${index}.dmg`);
      fs.writeFileSync(imagePath, 'fixture image');
      return {
        identifier: uuid(index + 1), runtimeIdentifier: runtime.identifier,
        version: runtime.version, build: runtime.build, path: imagePath,
        platformIdentifier: 'com.apple.platform.iphonesimulator',
        deletable: true, state: 'Ready',
      };
    }),
    runtimes: [old, replacement].map(runtime => ({
      ...runtime, buildversion: runtime.build, isAvailable: true,
    })),
    devices: {
      [oldRuntime]: [device(3, true), device(4, true)],
      [replacement.identifier]: [device(5, true, 'Booted')],
      [absentRuntime]: [device(6, false)],
    },
  };
  const calls = [];
  const logs = [];
  const options = {
    cleanupObsolete: true, replacement, deviceRoot,
    inspectStorage: () => structuredClone(storage),
    promptYesNo: async () => assert.fail('mobile --force cleanup must not prompt'),
    captureFn: (_command, args) => {
      calls.push(args);
      if (args[1] === 'delete') {
        for (const group of Object.keys(storage.devices)) {
          storage.devices[group] = storage.devices[group].filter(device => device.udid !== args[2]);
        }
      } else {
        assert.deepEqual(args.slice(0, 3), ['simctl', 'runtime', 'delete']);
        const image = storage.images.find(image => image.identifier === args[3]);
        storage.images = storage.images.filter(image => image.identifier !== args[3]);
        storage.runtimes = storage.runtimes.filter(runtime => runtime.identifier !== image.runtimeIdentifier);
      }
      return { status: 0 };
    },
    log: message => logs.push(message),
  };
  return { root, storage, calls, logs, options, device };
}

test('mobile forced iOS cleanup deletes old idle devices and absent-runtime data before their runtime', async t => {
  const f = fixture(t);
  assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), [uuid(3), uuid(4), uuid(6), uuid(1)]);
  assert.deepEqual(f.calls, [
    ['simctl', 'delete', uuid(3)], ['simctl', 'delete', uuid(4)],
    ['simctl', 'delete', uuid(6)], ['simctl', 'runtime', 'delete', uuid(1)],
  ]);
  assert.equal(f.storage.devices[replacement.identifier].length, 1);
  assert.equal(f.storage.images[0].runtimeIdentifier, replacement.identifier);
  assert.match(f.logs.join('\n'), /lose their saved apps and data/);
});

test('ordinary ios --force still asks and removes only an approved runtime, not simulator data', async t => {
  const f = fixture(t);
  let questions = 0;
  delete f.options.cleanupObsolete;
  Object.assign(f.options, {
    forceEmulatorUpdates: true,
    promptYesNo: async question => {
      questions += 1;
      assert.match(question, /devices and app data will be kept/);
      return true;
    },
  });
  assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), [uuid(1)]);
  assert.equal(questions, 1);
  assert.equal(f.storage.devices[oldRuntime].length, 2);
  assert.equal(f.storage.devices[absentRuntime].length, 1);
});

for (const state of ['Booted', 'Booting', 'Shutting Down', 'unknown']) {
  test(`forced cleanup preserves old runtime and all its devices when one device is ${state}`, async t => {
    const f = fixture(t);
    f.storage.devices[oldRuntime][0].state = state;
    await offerIosRuntimeCleanup(environment, f.options);
    assert.deepEqual(f.calls, [['simctl', 'delete', uuid(6)]]);
  });
}

test('forced cleanup preserves current/newer and non-iOS unavailable devices', async t => {
  const f = fixture(t);
  f.storage.devices[runtimeId('27.0')] = [f.device(7, false)];
  f.storage.devices['com.apple.CoreSimulator.SimRuntime.tvOS-16-2'] = [f.device(8, false)];
  f.storage.devices[replacement.identifier].push(f.device(9, false));
  await offerIosRuntimeCleanup(environment, f.options);
  assert.ok(f.calls.every(args => ![uuid(5), uuid(7), uuid(8), uuid(9)].includes(args[2])));
});

test('unavailable-device cleanup requires an actually absent runtime and explicit unavailability', async t => {
  for (const mutate of [
    f => { f.storage.devices[absentRuntime][0].isAvailable = true; },
    f => { delete f.storage.devices[absentRuntime][0].isAvailable; },
    f => { f.storage.runtimes.push({ identifier: absentRuntime, version: '16.2', isAvailable: false }); },
    f => { f.storage.images.push({ ...f.storage.images[0], identifier: uuid(7), runtimeIdentifier: absentRuntime, state: 'Installing' }); },
  ]) {
    const f = fixture(t);
    mutate(f);
    await offerIosRuntimeCleanup(environment, f.options);
    assert.ok(!f.calls.some(args => args[2] === uuid(6)));
  }
});

test('forced cleanup preserves unknown, external, missing and symlinked device storage', async t => {
  for (const kind of ['unknown', 'external', 'missing', 'symlink']) {
    const f = fixture(t);
    const device = f.storage.devices[oldRuntime][0];
    if (kind === 'unknown') delete device.dataPath;
    if (kind === 'external') device.dataPath = f.root;
    if (kind === 'missing') fs.rmdirSync(device.dataPath);
    if (kind === 'symlink') {
      fs.rmdirSync(device.dataPath);
      fs.symlinkSync(f.root, device.dataPath, 'dir');
    }
    await offerIosRuntimeCleanup(environment, f.options);
    assert.deepEqual(f.calls, [['simctl', 'delete', uuid(6)]], kind);
  }
});

test('forced cleanup preserves unknown or symlinked runtime image paths', async t => {
  for (const kind of ['missing', 'symlink']) {
    const f = fixture(t);
    if (kind === 'missing') delete f.storage.images[0].path;
    else {
      const image = f.storage.images[0].path;
      fs.unlinkSync(image);
      fs.symlinkSync(f.storage.images[1].path, image);
    }
    await offerIosRuntimeCleanup(environment, f.options);
    assert.deepEqual(f.calls, [['simctl', 'delete', uuid(6)]], kind);
  }
});

test('forced cleanup revalidates state and replacement immediately before each device deletion', async t => {
  for (const mutate of [
    f => { f.storage.devices[oldRuntime][1].state = 'Booted'; },
    f => { f.storage.runtimes[1].isAvailable = false; },
    f => { f.storage.devices[oldRuntime][1].dataPath = f.root; },
  ]) {
    const f = fixture(t);
    const capture = f.options.captureFn;
    f.options.captureFn = (...args) => { const result = capture(...args); mutate(f); return result; };
    await offerIosRuntimeCleanup(environment, f.options);
    assert.equal(f.calls[0][2], uuid(3));
    assert.ok(!f.calls.some(args => args[2] === uuid(4) || args[1] === 'runtime'));
  }
});

test('forced cleanup fails closed on ambiguous inventories or missing replacement', async t => {
  for (const mutate of [
    f => { f.storage.runtimes[1].isAvailable = false; },
    f => { f.storage.devices[oldRuntime] = null; },
    f => { f.storage.devices[oldRuntime][0].udid = 'all'; },
    f => { f.storage.devices[absentRuntime].push(f.storage.devices[oldRuntime][0]); },
    f => { f.storage.runtimes.push(f.storage.runtimes[1]); },
    f => { f.storage.images.push(f.storage.images[1]); },
    f => { delete f.storage.images[0].runtimeIdentifier; },
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), []);
    assert.deepEqual(f.calls, []);
  }
});

test('forced cleanup does not delete a runtime after device removal fails or is not confirmed', async t => {
  for (const result of [{ status: 1 }, { status: 0 }]) {
    const f = fixture(t);
    f.options.captureFn = (_command, args) => { f.calls.push(args); return result; };
    assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), []);
    assert.ok(!f.calls.some(args => args[1] === 'runtime'));
    assert.ok(!f.logs.some(message => message.startsWith('✓')));
  }
});

test('forced cleanup rechecks an empty old runtime immediately before removing its image', async t => {
  const f = fixture(t);
  const capture = f.options.captureFn;
  f.options.captureFn = (...args) => {
    const result = capture(...args);
    if (args[1][2] === uuid(6)) f.storage.devices[oldRuntime].push(f.device(7, true, 'Booted'));
    return result;
  };
  await offerIosRuntimeCleanup(environment, f.options);
  assert.ok(!f.calls.some(args => args[1] === 'runtime'));
});

test('successful asynchronous runtime deletion reports pending without claiming failure or reclaimed storage', async t => {
  const f = fixture(t);
  const capture = f.options.captureFn;
  f.options.captureFn = (...args) => args[1][1] === 'runtime' ? { status: 0 } : capture(...args);
  assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), [uuid(3), uuid(4), uuid(6)]);
  assert.match(f.logs.join('\n'), /Removal requested for iOS 18\.6; Xcode still lists it, so completion is pending/);
  assert.ok(!f.logs.some(message => /Could not confirm removal|Removed obsolete iOS 18/.test(message)));
});

test('successful asynchronous device deletion reports pending and retains its runtime', async t => {
  const f = fixture(t);
  f.options.captureFn = (_command, args) => { f.calls.push(args); return { status: 0 }; };
  assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), []);
  assert.ok(f.logs.some(message => message.includes('completion is pending')));
  assert.ok(!f.logs.some(message => /Could not confirm removal|✓/.test(message)));
  assert.ok(!f.calls.some(args => args[1] === 'runtime'));
});

test('confirmed runtime removal warns when Apple retains the physical downloaded asset', async t => {
  for (const kind of ['Cryptex Disk Image', 'Patchable Cryptex Disk Image']) {
    const f = fixture(t);
    const image = f.storage.images[0];
    image.kind = kind;
    if (kind === 'Cryptex Disk Image') {
      image.parentImagePath = path.join(f.root, 'retained-asset.dmg');
      fs.writeFileSync(image.parentImagePath, 'fixture asset');
    }
    await offerIosRuntimeCleanup(environment, f.options);
    assert.match(f.logs.join('\n'), /Apple retained the downloaded iOS 18\.6 runtime asset/);
    assert.match(f.logs.join('\n'), /disk space is not reported as reclaimed/);
  }
});

test('runtime removal does not claim Apple retained a removed or symlinked asset', async t => {
  for (const kind of ['removed', 'symlink']) {
    const f = fixture(t);
    const image = f.storage.images[0];
    image.parentImagePath = path.join(f.root, 'asset.dmg');
    if (kind === 'symlink') fs.symlinkSync(image.path, image.parentImagePath);
    await offerIosRuntimeCleanup(environment, f.options);
    assert.ok(!f.logs.some(message => message.includes('Apple retained')));
  }
});

test('ordinary approved runtime cleanup also reports retained downloaded assets', async t => {
  const f = fixture(t);
  f.storage.images[0].parentImagePath = f.storage.images[0].path;
  f.options.cleanupObsolete = false;
  f.options.promptYesNo = async () => true;
  await offerIosRuntimeCleanup(environment, f.options);
  assert.match(f.logs.join('\n'), /Apple retained the downloaded iOS 18\.6 runtime asset/);
});

test('forced cleanup failure remains nonfatal and does not claim removed files', async t => {
  const f = fixture(t);
  f.options.captureFn = () => { throw new Error('Xcode unavailable'); };
  assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), []);
  assert.ok(!f.logs.some(message => message.startsWith('✓')));
  assert.match(f.logs.join('\n'), /continuing with installed runtimes/);
});

test('forced cleanup preserves the record of completed removals if a later inventory fails', async t => {
  const f = fixture(t);
  const inspect = f.options.inspectStorage;
  let inspections = 0;
  f.options.inspectStorage = () => {
    if (++inspections === 4) throw new Error('inventory unavailable');
    return inspect();
  };
  assert.deepEqual(await offerIosRuntimeCleanup(environment, f.options), [uuid(3)]);
  assert.deepEqual(f.calls, [['simctl', 'delete', uuid(3)]]);
});

test('preferred runtime cleanup receives explicit mobile cleanup authorization independently of updates', async () => {
  for (const cleanupObsolete of [false, true]) {
    const cleanups = [];
    await ensurePreferredIosSimulatorRuntime(environment, {
      forceEmulatorUpdates: true, cleanupObsolete, runtimeDownloadCachePath: null,
      inspectRuntimes: () => [replacement], preferredRuntime: () => replacement,
      cleanupRuntimes: async (_env, options) => { cleanups.push(options.cleanupObsolete); return []; },
      log: () => {},
    });
    assert.deepEqual(cleanups, [cleanupObsolete]);
  }
});
