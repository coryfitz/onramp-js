const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  launchPreparedIosProduction,
  productionIosRunArgs,
  runIos,
  waitForIosProductionPasteboardSync,
} = require('../src/ios');
const { runFrontend } = require('../src/run');

test('the production iOS command selects Release without starting Metro', () => {
  assert.deepEqual(productionIosRunArgs('sim-123', 'Example'), [
    'react-native', 'run-ios', '--udid', 'sim-123',
    '--scheme', 'Example', '--mode', 'Release', '--no-packager',
  ]);
});

test('a production iOS run opens Device Hub and keeps clipboard sharing active', async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-release-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  fs.writeFileSync(path.join(output, 'app.json'), '{"name":"Example"}\n');
  const calls = [];
  const environment = { env: { PATH: 'test' } };
  const simulator = { id: 'sim-123', name: 'iPhone 18 Pro' };
  const application = { kind: 'device-hub' };
  const pasteboardSync = { child: new EventEmitter(), stop: () => {} };
  await launchPreparedIosProduction({
    bundleIdentifier: 'com.example.app',
    environment,
    hostKeyboard: { application, connectionVerified: true },
    outputDir: output,
    simulator,
    simulatorApplication: application,
  }, {
    runCommand: async (...args) => calls.push(['run', ...args]),
    isInstalled: (...args) => {
      calls.push(['installed', ...args]);
      return true;
    },
    openSimulator: (...args) => calls.push(['open', ...args]),
    startPasteboardSync: (...args) => {
      calls.push(['sync', ...args]);
      return pasteboardSync;
    },
    waitForPasteboardSync: async (...args) => calls.push(['wait', ...args]),
  });
  assert.deepEqual(calls[0].slice(0, 6), [
    'run', 'npx',
    ['react-native', 'run-ios', '--udid', 'sim-123', '--scheme', 'Example', '--mode', 'Release', '--no-packager'],
    output,
    environment.env,
    { activityLabel: 'Xcode is building and installing the Release app' },
  ]);
  assert.deepEqual(calls[1], ['installed', 'sim-123', 'com.example.app', environment]);
  assert.deepEqual(calls[2].slice(0, 3), ['open', simulator, environment]);
  assert.equal(calls[2][5], application);
  assert.deepEqual(calls[3], ['sync', simulator, environment]);
  assert.deepEqual(calls[4], ['wait', pasteboardSync]);
});

test('a production iOS run remains usable when clipboard sync is unavailable', async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-release-no-sync-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  fs.writeFileSync(path.join(output, 'app.json'), '{"name":"Example"}\n');
  const calls = [];
  const warnings = [];
  await launchPreparedIosProduction({
    bundleIdentifier: 'com.example.app',
    environment: { env: {} },
    outputDir: output,
    simulator: { id: 'sim-123' },
    simulatorApplication: { kind: 'device-hub' },
  }, {
    runCommand: async () => {},
    isInstalled: () => true,
    openSimulator: () => calls.push('open'),
    startPasteboardSync: () => null,
    waitForPasteboardSync: () => assert.fail('Unavailable clipboard sync must not hold the run'),
    warn: message => warnings.push(message),
  });
  assert.deepEqual(calls, ['open']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Mac keyboard input could not be verified/);
  assert.match(warnings[0], /Device > Keyboard > Simulate Hardware Keyboard/);
});

test('the production clipboard session stays open until interrupted and stops only its sync', async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null;
  const stopped = [];
  const pasteboardSync = { child, stop: signal => stopped.push(signal) };
  let finished = false;
  const session = waitForIosProductionPasteboardSync(pasteboardSync, signals)
    .then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  signals.emit('SIGINT');
  await session;
  assert.deepEqual(stopped, ['SIGINT']);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGHUP'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('an unexpectedly ended production clipboard sync releases its signal handlers', async () => {
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.exitCode = null;
  const stopped = [];
  const session = waitForIosProductionPasteboardSync({
    child,
    stop: signal => stopped.push(signal),
  }, signals);
  child.emit('exit', 1);
  await session;
  assert.deepEqual(stopped, []);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGHUP'), 0);
});

test('the iOS production path never launches the Metro development session', async () => {
  const events = [];
  const result = await runIos({ production: true, environment: 'production' }, {
    prepareIosDevelopment: async options => {
      events.push(['prepare', options]);
      return { prepared: true };
    },
    launchPreparedIosProduction: async prepared => events.push(['production', prepared]),
  });
  assert.equal(result, null);
  assert.deepEqual(events, [
    ['prepare', { production: true, environment: 'production' }],
    ['production', { prepared: true }],
  ]);
});

test('frontend production mode writes the production profile and does not watch development inputs', async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-production-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const previousEnvironment = process.env.ONRAMP_ENVIRONMENT;
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.ONRAMP_ENVIRONMENT;
    else process.env.ONRAMP_ENVIRONMENT = previousEnvironment;
  });
  fs.writeFileSync(path.join(output, 'package.json'), '{}\n');
  const events = [];
  await runFrontend({ platform: 'ios', output, production: true }, {
    doctorWeb: () => events.push(['doctor']),
    maintainMobileStorage: async () => {},
    writeRuntimeConfig: (...args) => events.push(['config', ...args]),
    runIos: async options => events.push(['ios', options]),
    monitorNativeBuildInputs: () => assert.fail('Release runs must not start a Metro watcher'),
  });
  assert.deepEqual(events[1], ['config', output, 'production', 'ios', { backendPort: undefined }]);
  assert.equal(events[2][0], 'ios');
  assert.equal(events[2][1].production, true);
  assert.equal(events[2][1].environment, 'production');
  assert.equal(process.env.ONRAMP_ENVIRONMENT, 'production');
});
