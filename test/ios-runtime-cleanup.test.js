const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectIosRuntimeStorage,
  offerIosRuntimeCleanup,
} = require('../src/ios-runtime-cleanup');
const {
  ensureEligibleIosSimulator,
  ensurePreferredIosSimulatorRuntime,
} = require('../src/ios');

const environment = { env: {}, xcrun: 'fake-xcrun', xcodebuild: 'fake-xcodebuild' };
const oldId = '11111111-1111-1111-1111-111111111111';
const newId = '22222222-2222-2222-2222-222222222222';
const oldRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-18-6';
const replacement = {
  identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  version: '26.5',
  build: '23F77',
};

function inventory() {
  return {
    images: [
      {
        identifier: oldId, runtimeIdentifier: oldRuntime, version: '18.6',
        build: '22G86', platformIdentifier: 'com.apple.platform.iphonesimulator',
        deletable: true, state: 'Ready', sizeBytes: 8 * 1024 ** 3,
      },
      {
        identifier: newId, runtimeIdentifier: replacement.identifier,
        version: replacement.version, build: replacement.build,
        platformIdentifier: 'com.apple.platform.iphonesimulator',
        deletable: true, state: 'Ready',
      },
    ],
    runtimes: [
      { identifier: oldRuntime, version: '18.6', buildversion: '22G86', isAvailable: true },
      { ...replacement, buildversion: replacement.build, isAvailable: true },
    ],
    devices: {
      [oldRuntime]: [{ udid: 'old-device', state: 'Shutdown' }],
      [replacement.identifier]: [{ udid: 'new-device', state: 'Booted' }],
    },
  };
}

function harness(storage = inventory()) {
  const calls = [];
  const prompts = [];
  const logs = [];
  const options = {
    replacement,
    inspectStorage: () => structuredClone(storage),
    promptYesNo: async question => { prompts.push(question); return true; },
    log: message => logs.push(message),
    captureFn: (command, args) => {
      calls.push({ command, args });
      assert.deepEqual(args.slice(0, 3), ['simctl', 'runtime', 'delete']);
      assert.equal(args[3], oldId);
      storage.images = storage.images.filter(image => image.identifier !== args[3]);
      return { status: 0 };
    },
  };
  return { calls, prompts, logs, options, storage };
}

test('removes only the approved older runtime UUID and preserves device data', async () => {
  const h = harness();
  assert.deepEqual(await offerIosRuntimeCleanup(environment, h.options), [oldId]);
  assert.equal(h.calls.length, 1);
  assert.match(h.prompts[0], /18\.6 build 22G86, approximately 8\.0 GiB/);
  assert.match(h.prompts[0], /shared by all projects and Mac users/);
  assert.match(h.prompts[0], /devices and app data will be kept/);
  assert.match(h.prompts[0], /downloaded again before use/);
  assert.equal(h.storage.devices[oldRuntime].length, 1);
});

test('does not remove runtimes when cleanup is declined', async () => {
  const h = harness();
  h.options.promptYesNo = async () => false;
  assert.deepEqual(await offerIosRuntimeCleanup(environment, h.options), []);
  assert.equal(h.calls.length, 0);
});

test('requires explicit provider confirmation of replacement availability', async () => {
  for (const isAvailable of [false, 'false', 'true', 1, undefined]) {
    const h = harness();
    h.storage.runtimes[1].isAvailable = isAvailable;
    await offerIosRuntimeCleanup(environment, h.options);
    assert.equal(h.calls.length, 0);
    assert.equal(h.prompts.length, 0);
  }
});

for (const state of ['Booted', 'Booting', 'Shutting Down', undefined]) {
  test(`preserves a runtime with device state ${state}, even if unavailable`, async () => {
    const h = harness();
    Object.assign(h.storage.devices[oldRuntime][0], { state, isAvailable: false });
    await offerIosRuntimeCleanup(environment, h.options);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.calls.length, 0);
  });
}

for (const changes of [
  { version: '26.5', build: '23F70' },
  { version: '27.0' },
  { version: 'unknown 18.6' },
  { identifier: 'all' },
  { platformIdentifier: 'com.apple.platform.appletvsimulator' },
  { deletable: false },
  { state: 'Installing' },
]) {
  test(`preserves excluded runtime ${JSON.stringify(changes)}`, async () => {
    const h = harness();
    Object.assign(h.storage.images[0], changes);
    await offerIosRuntimeCleanup(environment, h.options);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.calls.length, 0);
  });
}

test('rechecks activity after consent and never deletes a newly booted runtime', async () => {
  const h = harness();
  h.options.promptYesNo = async () => {
    h.storage.devices[oldRuntime][0].state = 'Booted';
    return true;
  };
  await offerIosRuntimeCleanup(environment, h.options);
  assert.equal(h.calls.length, 0);
});

test('rechecks replacement availability and candidate identity after consent', async () => {
  for (const mutate of [
    h => { h.storage.runtimes[1].isAvailable = false; },
    h => { h.storage.images[0].build = 'different'; },
    h => { h.unreadable = true; },
  ]) {
    const h = harness();
    h.options.promptYesNo = async () => { mutate(h); return true; };
    const original = h.options.inspectStorage;
    h.options.inspectStorage = () => {
      if (h.unreadable) throw new Error('unreadable');
      return original();
    };
    await offerIosRuntimeCleanup(environment, h.options);
    assert.equal(h.calls.length, 0);
  }
});

test('does not mistake reordered existing builds for a successful new download', async () => {
  const a = { ...replacement, build: '23F70' };
  const b = { ...replacement, build: '23F71' };
  let inspections = 0;
  let cleanups = 0;
  const result = await ensurePreferredIosSimulatorRuntime(environment, {
    runtimeDownloadCachePath: null,
    inspectRuntimes: () => ++inspections === 1 ? [a, b] : [b, a],
    preferredRuntime: () => replacement,
    promptYesNo: async () => true,
    runCommand: () => {},
    cleanupRuntimes: async () => { cleanups += 1; },
    log: () => {},
  });
  assert.equal(result.changed, false);
  assert.equal(cleanups, 0);
});

test('cleanup errors do not fail launch or falsely report reclaimed storage', async () => {
  for (const response of [{ status: 1 }, { status: 0 }]) {
    const h = harness();
    h.options.captureFn = () => response;
    assert.deepEqual(await offerIosRuntimeCleanup(environment, h.options), []);
    assert.ok(!h.logs.some(message => message.startsWith('✓')));
  }
});

test('resolves the verified replacement from a selected eligible simulator', async () => {
  const h = harness();
  delete h.options.replacement;
  h.options.simulatorId = 'new-device';
  assert.deepEqual(await offerIosRuntimeCleanup(environment, h.options), [oldId]);
});

test('runtime inventory fails closed on provider errors and malformed schemas', () => {
  const storage = inventory();
  const images = Object.fromEntries(storage.images.map(image => [image.identifier, image]));
  for (const values of [
    [[], { runtimes: storage.runtimes }, { devices: storage.devices }],
    [images, {}, { devices: storage.devices }],
    [images, { runtimes: storage.runtimes }, {}],
    [{ bad: storage.images[0] }, { runtimes: storage.runtimes }, { devices: {} }],
    [images, { runtimes: storage.runtimes }, { devices: { [oldRuntime]: null } }],
  ]) {
    let call = 0;
    assert.throws(() => inspectIosRuntimeStorage(environment, () => ({
      status: 0, stdout: JSON.stringify(values[call++]),
    })));
  }
  assert.throws(() => inspectIosRuntimeStorage(environment, () => ({ status: 1 })));
  assert.throws(() => inspectIosRuntimeStorage(environment, () => ({ status: 0, stdout: '{' })));
});

test('only newly verified downloads trigger runtime cleanup, including fallback', async () => {
  const old = { identifier: oldRuntime, build: '22G86', version: '18.6' };
  for (const scenario of ['new', 'fallback', 'alternative', 'failed', 'unchanged', 'unknown', 'declined', 'already']) {
    const calls = [];
    let inspection = 0;
    let downloads = 0;
    const actual = scenario === 'alternative'
      ? { ...replacement, build: '23F76' } : replacement;
    const result = await ensurePreferredIosSimulatorRuntime(environment, {
      architectureVariant: 'arm64', runtimeDownloadCachePath: null,
      preferredRuntime: () => replacement,
      inspectRuntimes: () => {
        inspection += 1;
        if (scenario === 'already') return [old, replacement];
        if (inspection === 1 || ['failed', 'unchanged', 'declined'].includes(scenario)) return [old];
        if (scenario === 'unknown') return null;
        return [old, actual];
      },
      promptYesNo: async () => scenario !== 'declined',
      runCommand: () => {
        downloads += 1;
        if (scenario === 'failed' || (scenario === 'fallback' && downloads === 1)) {
          throw new Error('download failed');
        }
      },
      cleanupRuntimes: async (_environment, options) => { calls.push(options.replacement); return []; },
      log: () => {},
    });
    const changed = ['new', 'fallback', 'alternative'].includes(scenario);
    assert.equal(result.changed, changed, scenario);
    assert.deepEqual(calls, changed ? [actual] : [], scenario);
  }
});

test('eligible simulator recovery offers cleanup only for a newly available version', async () => {
  for (const before of [[], ['26.5'], null]) {
    let queries = 0;
    const cleanups = [];
    await ensureEligibleIosSimulator('/fake/ios', 'Example', environment, {
      inspectRuntimes: () => before,
      queryWithRetry: async () => ++queries === 1
        ? { status: 1, destinations: [], output: 'iOS 26.5 is not installed' }
        : { status: 0, destinations: [{ id: 'new-device', name: 'iPhone', os: '26.5' }], output: '' },
      promptYesNo: async () => true,
      runCommand: () => {},
      selectSimulator: destinations => destinations[0],
      cleanupRuntimes: async (_environment, options) => cleanups.push(options.simulatorId),
    });
    assert.deepEqual(cleanups, before && before.length === 0 ? ['new-device'] : []);
  }
});
