const assert = require('node:assert/strict');
const test = require('node:test');
const {launchPreparedIos} = require('../src/ios');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fixture(overrides = {}) {
  const events = [];
  const application = {kind: 'simulator'};
  const prepared = {
    bundleIdentifier: 'com.example.speed',
    environment: {env: {}},
    outputDir: '/unused/ios-speed-fixture',
    simulator: {id: 'sim-one', name: 'Test iPhone'},
    simulatorApplication: application,
    hostKeyboard: {application},
  };
  const metro = {port: 8089, stop: signal => events.push(['stop', signal])};
  const cache = {
    fingerprint: 'native-contents',
    bundleIdentifier: prepared.bundleIdentifier,
    simulatorId: prepared.simulator.id,
  };
  const dependencies = {
    bootSimulator: () => events.push('boot'),
    openSimulator: () => events.push('show'),
    startMetro: async () => metro,
    warmMetroBundle: async () => events.push('bundle'),
    nativeBuildFingerprint: () => 'native-contents',
    cachedNativeBuild: () => null,
    isInstalled: () => true,
    runCommand: async (...args) => events.push(['build', ...args]),
    launchApp: (...args) => events.push(['launch', ...args]),
    recordNativeBuild: (...args) => events.push(['record', ...args]),
    activateSimulator: () => events.push('activate'),
    ...overrides,
  };
  return {cache, dependencies, events, metro, prepared};
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const eventType = event => Array.isArray(event) ? event[0] : event;

test('iOS overlaps its first Metro bundle and native compilation, then launches and records', async () => {
  const bundle = deferred();
  const native = deferred();
  const started = [];
  const setup = fixture({
    warmMetroBundle: async args => {
      started.push(['bundle', args]);
      await bundle.promise;
    },
    runCommand: async (...args) => {
      started.push(['build', ...args]);
      await native.promise;
    },
  });
  const session = launchPreparedIos(setup.prepared, {metroInteractive: false}, setup.dependencies);
  await tick();
  assert.deepEqual(started.map(eventType), ['bundle', 'build']);
  assert.deepEqual(started[0][1], {port: 8089, platform: 'ios'});
  assert.deepEqual(started[1][2], [
    'react-native', 'run-ios', '--udid', 'sim-one', '--port', '8089', '--no-packager',
  ]);
  assert.equal(started[1][5].inheritInput, false);
  native.resolve();
  await tick();
  assert.equal(setup.events.some(event => ['launch', 'record'].includes(eventType(event))), false);
  bundle.resolve();
  assert.equal(await session, setup.metro);
  assert.deepEqual(setup.events.map(eventType), ['boot', 'show', 'launch', 'record', 'activate']);
  assert.equal(setup.events.find(event => eventType(event) === 'record')[4], 'native-contents');
});

for (const failing of ['bundle', 'build']) {
  test(`an iOS ${failing} failure waits for the other preparation and stops Metro without recording`, async () => {
    const bundle = deferred();
    const native = deferred();
    const setup = fixture({
      warmMetroBundle: () => bundle.promise,
      runCommand: () => native.promise,
    });
    let finished = false;
    const session = launchPreparedIos(setup.prepared, {}, setup.dependencies);
    const checked = assert.rejects(session, new RegExp(`${failing} failed`))
      .then(() => { finished = true; });
    await tick();
    const failed = failing === 'bundle' ? bundle : native;
    const pending = failing === 'bundle' ? native : bundle;
    failed.reject(new Error(`${failing} failed`));
    await tick();
    assert.equal(finished, false);
    assert.deepEqual(setup.events.map(eventType), ['boot', 'show']);
    pending.resolve();
    await checked;
    assert.deepEqual(setup.events, ['boot', 'show', ['stop', 'SIGTERM']]);
  });
}

test('unchanged iOS native inputs still wait for Metro and reuse the exact installed simulator app', async () => {
  const bundle = deferred();
  const setup = fixture({warmMetroBundle: () => bundle.promise});
  setup.dependencies.cachedNativeBuild = () => setup.cache;
  const session = launchPreparedIos(setup.prepared, {}, setup.dependencies);
  await tick();
  assert.deepEqual(setup.events, ['boot', 'show']);
  bundle.resolve();
  await session;
  assert.deepEqual(setup.events.map(eventType), ['boot', 'show', 'launch', 'activate']);
});

test('iOS rechecks cached native inputs after waiting for its Metro bundle', async () => {
  const bundle = deferred();
  let fingerprint = 'native-contents';
  const setup = fixture({
    warmMetroBundle: () => bundle.promise,
    nativeBuildFingerprint: () => fingerprint,
  });
  setup.dependencies.cachedNativeBuild = () => setup.cache;
  const session = launchPreparedIos(setup.prepared, {}, setup.dependencies);
  await tick();
  fingerprint = 'edited-native-contents';
  bundle.resolve();
  await session;
  assert.deepEqual(setup.events.map(eventType), ['boot', 'show', 'build', 'launch', 'record', 'activate']);
  assert.equal(setup.events.find(event => eventType(event) === 'record')[4], fingerprint);
});

test('iOS supplies the prebuild fingerprint when recording a build after input edits', async () => {
  const native = deferred();
  let fingerprint = 'native-contents';
  const setup = fixture({
    runCommand: () => native.promise,
    nativeBuildFingerprint: () => fingerprint,
  });
  const session = launchPreparedIos(setup.prepared, {}, setup.dependencies);
  await tick();
  fingerprint = 'edited-native-contents';
  native.resolve();
  await session;
  assert.equal(setup.events.find(event => eventType(event) === 'record')[4], 'native-contents');
});

for (const condition of ['rebuild', 'missing app', 'different simulator', 'different bundle', 'changed inputs']) {
  test(`iOS rebuilds for ${condition} despite cached state`, async () => {
    const setup = fixture();
    setup.dependencies.cachedNativeBuild = () => setup.cache;
    if (condition === 'missing app') setup.dependencies.isInstalled = () => false;
    if (condition === 'different simulator') setup.cache.simulatorId = 'sim-two';
    if (condition === 'different bundle') setup.cache.bundleIdentifier = 'com.example.other';
    if (condition === 'changed inputs') setup.cache.fingerprint = 'older-contents';
    await launchPreparedIos(setup.prepared, {rebuild: condition === 'rebuild'}, setup.dependencies);
    assert.equal(setup.events.filter(event => eventType(event) === 'build').length, 1);
    assert.equal(setup.events.filter(event => eventType(event) === 'record').length, 1);
  });
}
