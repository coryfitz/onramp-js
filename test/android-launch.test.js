const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function launchHarness({ cached = false, rebuild = false } = {}) {
  const bundle = deferred();
  const build = deferred();
  const events = [];
  const recorded = [];
  let fingerprint = 'fingerprint';
  const applicationId = 'com.example.app';
  const avd = 'Fixture_Pixel';
  const metro = { port: 8081, stop: signal => events.push(`stop:${signal}`) };
  const sourceFile = path.join(__dirname, '..', 'src', 'android.js');
  const requireSource = createRequire(sourceFile);
  const modules = {
    './metro': {
      startMetro: async () => metro,
      warmMetroBundle: () => { events.push('bundle'); return bundle.promise; },
    },
    './native-build-cache': {
      nativeBuildFingerprint: () => fingerprint,
      cachedNativeBuild: () => cached ? {
        fingerprint: 'fingerprint', applicationId, avd, metroPort: 8081,
      } : null,
      recordNativeBuild: (...args) => { events.push('record'); recorded.push(args); },
    },
    './process': {
      ...requireSource('./process'),
      runAsync: () => { events.push('build'); return build.promise; },
      capture: (_command, args) => {
        let stdout = '';
        if (args[0] === 'devices') {
          stdout = 'List of devices attached\nemulator-5554\tdevice\n';
        } else if (args.includes('avd')) stdout = avd + '\nOK\n';
        else if (args.includes('sys.boot_completed')) stdout = '1\n';
        else if (args.includes('path')) stdout = 'package:/data/app/base.apk\n';
        else if (args.includes('resolve-activity')) stdout = `${applicationId}/.MainActivity\n`;
        else if (args.includes('start')) events.push('open');
        return { status: 0, stdout, stderr: '' };
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourceFile, 'utf8'), {
    require: name => modules[name] || requireSource(name),
    module,
    process,
    console: { log() {}, warn() {} },
    setTimeout,
    clearTimeout,
    Buffer,
    __dirname: path.dirname(sourceFile),
  }, { filename: sourceFile });
  const launch = module.exports.launchPreparedAndroid({
    applicationId,
    environment: { adb: '/fixture/adb', avd, env: {} },
    outputDir: '/fixture/build',
  }, { activateEmulator: () => true, platform: 'linux', rebuild });
  return {
    build, bundle, events, launch, metro, recorded,
    changeNativeInputs: () => { fingerprint = 'edited-during-launch'; },
  };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('Android builds while its first Metro bundle is still being prepared', async () => {
  const h = launchHarness();
  await nextTurn();
  assert.deepEqual(h.events, ['bundle', 'build']);
  h.build.resolve();
  await nextTurn();
  assert.equal(h.events.includes('record'), false);
  h.bundle.resolve();
  assert.equal(await h.launch, h.metro);
  assert.deepEqual(h.events, ['bundle', 'build', 'record']);
});

test('Android bundle failure waits for the native build and never records success', async () => {
  const h = launchHarness();
  const error = new Error('bundle failed');
  const rejection = assert.rejects(h.launch, value => value === error);
  await nextTurn();
  h.bundle.reject(error);
  await nextTurn();
  assert.deepEqual(h.events, ['bundle', 'build']);
  h.build.resolve();
  await rejection;
  assert.deepEqual(h.events, ['bundle', 'build', 'stop:SIGTERM']);
});

test('Android native build failure waits for the bundle and stops Metro', async () => {
  const h = launchHarness();
  const error = new Error('Gradle failed');
  const rejection = assert.rejects(h.launch, value => value === error);
  await nextTurn();
  h.build.reject(error);
  await nextTurn();
  assert.deepEqual(h.events, ['bundle', 'build']);
  h.bundle.resolve();
  await rejection;
  assert.deepEqual(h.events, ['bundle', 'build', 'stop:SIGTERM']);
});

test('an unchanged installed Android app waits for the bundle without running Gradle', async () => {
  const h = launchHarness({ cached: true });
  await nextTurn();
  assert.deepEqual(h.events, ['bundle']);
  h.bundle.resolve();
  assert.equal(await h.launch, h.metro);
  assert.deepEqual(h.events, ['bundle', 'open']);
});

test('Android rebuild bypasses the installed-app cache and overlaps bundling', async () => {
  const h = launchHarness({ cached: true, rebuild: true });
  await nextTurn();
  assert.deepEqual(h.events, ['bundle', 'build']);
  h.bundle.resolve();
  h.build.resolve();
  await h.launch;
  assert.deepEqual(h.events, ['bundle', 'build', 'record']);
});

test('Android passes the original build snapshot when inputs change during compilation', async () => {
  const h = launchHarness();
  await nextTurn();
  h.changeNativeInputs();
  h.bundle.resolve();
  h.build.resolve();
  await h.launch;
  assert.equal(h.recorded[0][3], 'fingerprint');
});

test('Android rebuilds when native inputs change while warming an installed app', async () => {
  const h = launchHarness({ cached: true });
  await nextTurn();
  assert.deepEqual(h.events, ['bundle']);
  h.changeNativeInputs();
  h.bundle.resolve();
  await nextTurn();
  assert.deepEqual(h.events, ['bundle', 'build']);
  h.build.resolve();
  await h.launch;
  assert.deepEqual(h.events, ['bundle', 'build', 'record']);
  assert.equal(h.recorded[0][3], 'edited-during-launch');
});
