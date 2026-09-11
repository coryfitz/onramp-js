const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseRunArgs, parseRepairArgs, parseUpgradeArgs } = require('../bin/onramp-js');
const { runFrontend, runMobile } = require('../src/run');

for (const platform of ['ios', 'android', 'mobile']) {
  test(`--force selects only emulator update consent for ${platform}`, () => {
    const options = parseRunArgs([platform, '--force']);
    assert.equal(options.forceEmulatorUpdates, true);
    assert.equal(options.rebuild, undefined);
    assert.equal(parseRunArgs([platform]).forceEmulatorUpdates, undefined);
    assert.equal(parseRunArgs([platform, '--force', '--rebuild']).rebuild, true);
  });

  test(`${platform} frontend routing forwards update consent to the native runner`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-force-cli-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    const calls = [];
    const runner = async options => { calls.push(options); return {}; };
    const dependencies = {
      doctorWeb() {}, writeRuntimeConfig() {}, monitorNativeBuildInputs() {},
      runIos: runner, runAndroid: runner, runMobile: runner,
    };
    const oldEnvironment = process.env.ONRAMP_ENVIRONMENT;
    t.after(() => {
      if (oldEnvironment === undefined) delete process.env.ONRAMP_ENVIRONMENT;
      else process.env.ONRAMP_ENVIRONMENT = oldEnvironment;
    });
    for (const forceEmulatorUpdates of [undefined, true]) {
      await runFrontend({ platform, output: root, forceEmulatorUpdates }, dependencies);
      assert.equal(calls.at(-1).forceEmulatorUpdates, forceEmulatorUpdates);
      assert.equal(calls.at(-1).rebuild, undefined);
    }
    assert.equal(calls.length, 2);
  });
}

test('force is rejected on web, repair, and upgrade without becoming a generic yes', async () => {
  assert.throws(() => parseRunArgs(['web', '--force']), /only valid for iOS, Android, or mobile/);
  assert.throws(() => parseRepairArgs(['ios', '--force']), /Unknown option/);
  assert.throws(() => parseUpgradeArgs(['--force']), /Unknown option/);
  await assert.rejects(runFrontend({ platform: 'web', forceEmulatorUpdates: true }, {
    doctorWeb() { assert.fail('must reject before running tools'); },
    writeRuntimeConfig() { assert.fail('must reject before changing files'); },
  }), /only valid for iOS, Android, or mobile/);
});

test('mobile forwards force to both preflights without forcing app rebuilds', async () => {
  const calls = [];
  const runners = {
    prepareAndroidDevelopment: async options => { calls.push(['android', options]); return {}; },
    prepareIosDevelopment: async options => { calls.push(['ios', options]); return {}; },
    launchPreparedAndroid: async (_prepared, options) => {
      assert.equal(options.rebuild, undefined);
      assert.equal(options.forceEmulatorUpdates, undefined);
      return { port: 9090, stop() {} };
    },
    launchPreparedIos: async (_prepared, options) => {
      assert.equal(options.rebuild, undefined);
      return { port: 9091, stop() {} };
    },
  };
  await runMobile({ output: '/tmp/onramp-force-fixture', forceEmulatorUpdates: true }, runners);
  assert.deepEqual(calls.map(([platform, options]) => [platform, options.forceEmulatorUpdates]), [
    ['android', true], ['ios', true],
  ]);
});
