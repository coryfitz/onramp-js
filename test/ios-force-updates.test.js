const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensurePreferredIosSimulatorRuntime } = require('../src/ios');

const environment = {
  env: {},
  version: { display: 'Xcode 26.6' },
  xcodebuild: 'fake-xcodebuild',
  xcrun: 'fake-xcrun',
};
const previous = {
  identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
  build: '22G86',
  version: '18.6',
};
const preferred = {
  identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
  build: '23F81a',
  version: '26.5',
};

function harness(current = previous) {
  const commands = [];
  const prompts = [];
  const logs = [];
  let downloaded = false;
  const options = {
    architectureVariant: 'arm64',
    runtimeDownloadCachePath: null,
    forceEmulatorUpdates: true,
    inspectRuntimes: () => downloaded ? [current, preferred] : [current],
    preferredRuntime: () => preferred,
    cleanupRuntimes: async () => [],
    promptYesNo: async question => { prompts.push(question); return false; },
    runCommand: (...args) => { commands.push(args); downloaded = true; },
    log: message => logs.push(message),
  };
  return { commands, prompts, logs, options };
}

for (const [description, current] of [
  ['newer version', previous],
  ['preferred build of the same version', { ...preferred, build: '23F77' }],
]) {
  test(`--force approves an iOS ${description} update without prompting`, async () => {
    const h = harness(current);
    const result = await ensurePreferredIosSimulatorRuntime(environment, h.options);

    assert.equal(result.changed, true);
    assert.deepEqual(h.prompts, []);
    assert.equal(h.commands.length, 1);
    assert.deepEqual(h.commands[0].slice(0, 2), [
      'fake-xcodebuild',
      ['-downloadPlatform', 'iOS', '-buildVersion', '23F81a', '-architectureVariant', 'arm64'],
    ]);
    assert.match(h.logs.join('\n'), /Automatically approving.*--force.*several GB/);
  });
}

test('iOS runtime updates still ask for approval by default', async () => {
  const h = harness();
  delete h.options.forceEmulatorUpdates;
  const result = await ensurePreferredIosSimulatorRuntime(environment, h.options);

  assert.equal(result.changed, false);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /Download and install the newer runtime/);
  assert.equal(h.commands.length, 0);
  assert.ok(!h.logs.some(message => message.includes('Automatically approving')));
});

test('--force still requires permission for the first iOS runtime installation', async () => {
  const h = harness();
  h.options.inspectRuntimes = () => [];
  await assert.rejects(
    ensurePreferredIosSimulatorRuntime(environment, h.options),
    /iOS launch cancelled; no Simulator runtime is installed/
  );

  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /No iOS Simulator runtime is installed/);
  assert.equal(h.commands.length, 0);
});

test('--force does not download when the preferred iOS runtime is already installed', async () => {
  const h = harness(preferred);
  const result = await ensurePreferredIosSimulatorRuntime(environment, h.options);

  assert.equal(result.changed, false);
  assert.equal(h.commands.length, 0);
  assert.equal(h.prompts.length, 0);
});

test('--force preserves failed iOS download fallback and the retry cooldown', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-force-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const h = harness();
  let now = 1_000;
  Object.assign(h.options, {
    runtimeDownloadCachePath: path.join(temporary, 'download.json'),
    runtimeDownloadRetryMs: 1_000,
    now: () => now,
    runCommand: (...args) => {
      h.commands.push(args);
      throw new Error('Xcode rejected the runtime');
    },
  });

  const first = await ensurePreferredIosSimulatorRuntime(environment, h.options);
  assert.equal(first.changed, false);
  assert.deepEqual(first.installed, [previous]);
  assert.equal(h.commands.length, 2);
  assert.deepEqual(h.commands[1][1], [
    '-downloadPlatform', 'iOS', '-architectureVariant', 'arm64',
  ]);
  const deferred = await ensurePreferredIosSimulatorRuntime(environment, h.options);
  assert.equal(deferred.changed, false);
  assert.equal(h.commands.length, 2);
  assert.match(h.logs.join('\n'), /recently reported.*could not be downloaded/);

  now += 1_001;
  await ensurePreferredIosSimulatorRuntime(environment, h.options);
  assert.equal(h.commands.length, 4);
  assert.equal(h.prompts.length, 0);
});

test('--force does not assume availability when iOS compatibility or inventory is unknown', async () => {
  for (const overrides of [
    { preferredRuntime: () => null },
    { inspectRuntimes: () => null },
  ]) {
    const h = harness();
    Object.assign(h.options, overrides);
    const result = await ensurePreferredIosSimulatorRuntime(environment, h.options);
    assert.equal(result.changed, false);
    assert.equal(h.commands.length, 0);
    assert.equal(h.prompts.length, 0);
  }
});

test('--force updates do not autoapprove removing a shared older iOS runtime', async () => {
  const h = harness();
  const oldId = '11111111-1111-1111-1111-111111111111';
  const newId = '22222222-2222-2222-2222-222222222222';
  const removed = [];
  // Exercise the real cleanup helper after the mocked download succeeds.
  delete h.options.cleanupRuntimes;
  h.options.inspectStorage = () => ({
    images: [previous, preferred].map((runtime, index) => ({
      identifier: index === 0 ? oldId : newId,
      runtimeIdentifier: runtime.identifier,
      version: runtime.version,
      build: runtime.build,
      platformIdentifier: 'com.apple.platform.iphonesimulator',
      deletable: true,
      state: 'Ready',
    })),
    runtimes: [previous, preferred].map(runtime => ({
      ...runtime,
      buildversion: runtime.build,
      isAvailable: true,
    })),
    devices: {
      [previous.identifier]: [{ udid: 'old-device', state: 'Shutdown' }],
      [preferred.identifier]: [{ udid: 'new-device', state: 'Booted' }],
    },
  });
  h.options.captureFn = (...args) => { removed.push(args); return { status: 0 }; };
  const result = await ensurePreferredIosSimulatorRuntime(environment, h.options);

  assert.equal(result.changed, true);
  assert.equal(h.commands.length, 1);
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0], /shared by all projects and Mac users/);
  assert.match(h.prompts[0], /Remove.*18\.6/);
  assert.deepEqual(removed, []);
});
