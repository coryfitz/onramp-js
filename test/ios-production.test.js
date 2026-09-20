const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  launchPreparedIosProduction,
  productionIosRunArgs,
  runIos,
} = require('../src/ios');
const { runFrontend } = require('../src/run');

test('the production iOS command selects Release without starting Metro', () => {
  assert.deepEqual(productionIosRunArgs('sim-123', 'Example'), [
    'react-native', 'run-ios', '--udid', 'sim-123',
    '--scheme', 'Example', '--mode', 'Release', '--no-packager',
  ]);
});

test('a production iOS run installs the Release bundle and exits', async t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-release-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  fs.writeFileSync(path.join(output, 'app.json'), '{"name":"Example"}\n');
  const calls = [];
  const environment = { env: { PATH: 'test' } };
  await launchPreparedIosProduction({
    bundleIdentifier: 'com.example.app',
    environment,
    outputDir: output,
    simulator: { id: 'sim-123' },
  }, {
    runCommand: async (...args) => calls.push(['run', ...args]),
    isInstalled: (...args) => {
      calls.push(['installed', ...args]);
      return true;
    },
    activateSimulator: (...args) => calls.push(['activate', ...args]),
  });
  assert.deepEqual(calls[0].slice(0, 6), [
    'run', 'npx',
    ['react-native', 'run-ios', '--udid', 'sim-123', '--scheme', 'Example', '--mode', 'Release', '--no-packager'],
    output,
    environment.env,
    { activityLabel: 'Xcode is building and installing the Release app' },
  ]);
  assert.deepEqual(calls[1], ['installed', 'sim-123', 'com.example.app', environment]);
  assert.deepEqual(calls[2], ['activate', environment]);
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
