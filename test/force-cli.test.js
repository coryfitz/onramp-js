const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { parseRunArgs, parseRepairArgs, parseUpgradeArgs } = require('../bin/onramp-js');
const { runFrontend, runMobile } = require('../src/run');

test('help distinguishes mobile force cleanup from standalone native update consent', () => {
  const help = execFileSync(process.execPath, [
    path.join(__dirname, '../bin/onramp-js.js'), '--help',
  ], { encoding: 'utf8' });
  assert.match(help, /mobile also deletes verified obsolete emulator files\/data/);
  assert.match(help, /ios\/android still ask before cleanup/);
  assert.match(help, /first installs and repairs remain opt-in/);
});

for (const platform of ['ios', 'android', 'mobile']) {
  test(`--force selects native update consent without forcing app rebuilds for ${platform}`, () => {
    const options = parseRunArgs([platform, '--force']);
    assert.equal(options.forceEmulatorUpdates, true);
    assert.equal(options.cleanupObsolete, undefined);
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
      assert.equal(calls.at(-1).cleanupObsolete, undefined);
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

for (const forceEmulatorUpdates of [undefined, false, true]) {
  test(`mobile enables obsolete cleanup only with force and finishes both preflights before Metro (force=${forceEmulatorUpdates})`, async () => {
    const calls = [];
    const stages = [];
    const runners = {
      prepareAndroidDevelopment: async options => {
        calls.push(['android', options]);
        await Promise.resolve();
        stages.push('android-preflight-complete');
        return {};
      },
      prepareIosDevelopment: async options => {
        calls.push(['ios', options]);
        await Promise.resolve();
        stages.push('ios-preflight-complete');
        return {};
      },
      launchPreparedAndroid: async (_prepared, options) => {
        assert.deepEqual(stages, ['android-preflight-complete', 'ios-preflight-complete']);
        stages.push('android-metro');
        assert.equal(options.rebuild, undefined);
        assert.equal(options.forceEmulatorUpdates, undefined);
        assert.equal(options.cleanupObsolete, undefined);
        assert.equal(options.metroInteractive, false);
        return { port: 9090, stop() {} };
      },
      launchPreparedIos: async (_prepared, options) => {
        stages.push('ios-metro');
        assert.equal(options.rebuild, undefined);
        assert.equal(options.cleanupObsolete, undefined);
        assert.equal(options.metroInteractive, false);
        return { port: 9091, stop() {} };
      },
    };
    await runMobile({ output: '/tmp/onramp-force-fixture', forceEmulatorUpdates }, runners);
    assert.deepEqual(calls.map(([platform, options]) => [
      platform, options.forceEmulatorUpdates, options.cleanupObsolete,
    ]), [
      ['android', forceEmulatorUpdates, forceEmulatorUpdates === true],
      ['ios', forceEmulatorUpdates, forceEmulatorUpdates === true],
    ]);
    assert.deepEqual(stages, [
      'android-preflight-complete', 'ios-preflight-complete', 'android-metro', 'ios-metro',
    ]);
  });
}

test('mobile force never starts Metro after an incomplete cleanup preflight', async () => {
  await assert.rejects(runMobile({
    output: '/tmp/onramp-force-fixture', forceEmulatorUpdates: true,
  }, {
    prepareAndroidDevelopment: async options => {
      assert.equal(options.cleanupObsolete, true);
      return {};
    },
    prepareIosDevelopment: async options => {
      assert.equal(options.cleanupObsolete, true);
      throw new Error('preflight incomplete');
    },
    launchPreparedAndroid: async () => assert.fail('must not start Android Metro'),
    launchPreparedIos: async () => assert.fail('must not start iOS Metro'),
  }), /preflight incomplete/);
});
