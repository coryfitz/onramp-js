const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseStorageArgs } = require('../bin/onramp-js');
const { automaticallyMaintainMobileStorage, runStorageCommand } = require('../src/storage');
const { runFrontend } = require('../src/run');

test('storage defaults to inspection; cleanup is separate from update force', () => {
  assert.deepEqual(parseStorageArgs([]), { clean: false, includeOtherProjects: false });
  assert.deepEqual(parseStorageArgs(['--clean', '--include-other-projects']), {
    clean: true, includeOtherProjects: true,
  });
  assert.throws(() => parseStorageArgs(['--check', '--clean']), /either/);
  assert.throws(() => parseStorageArgs(['--force']), /Unknown storage option/);
  assert.throws(() => parseStorageArgs(['/']), /Unknown storage option/);
});

test('inspection never calls deletion and reports other-project exclusions', () => {
  const logs = [];
  const result = runStorageCommand({}, {
    log: line => logs.push(line),
    inspectXcode: options => {
      assert.equal(options.includeOtherProjects, false);
      return { candidates: [{ path: '/example/cache', bytes: 1024 ** 3, eligible: true },
        { path: '/other/cache', bytes: 1024 ** 3, eligible: false, reason: 'Other project' }] };
    },
    cleanupXcode: () => assert.fail('inspection deleted Xcode output'),
    sweepTemporary: options => {
      assert.equal(options.dryRun, true);
      return { candidates: [], removed: [] };
    },
  });
  assert.equal(result.bytes, 1024 ** 3);
  assert.ok(logs.some(line => line.includes('Other project')));
  assert.ok(logs.some(line => line.includes('no files changed')));
});

test('explicit cleanup only invokes reviewed disposable-output collectors', () => {
  const result = runStorageCommand({ clean: true, includeOtherProjects: true }, {
    log: () => {},
    inspectXcode: () => assert.fail('wrong path'),
    cleanupXcode: options => {
      assert.equal(options.includeOtherProjects, true);
      return { removed: [{ path: '/test/cache', bytes: 3 }], bytesFreed: 3 };
    },
    sweepTemporary: options => {
      assert.equal(options.dryRun, false);
      return { removed: [{ path: '/test/temp', bytes: 2 }] };
    },
  });
  assert.equal(result.bytes, 5);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-storage-command-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('automatic maintenance is daily, limited to OnRamp output, and nonfatal', t => {
  const root = fixture(t);
  const calls = [];
  const dependencies = {
    log: () => {},
    cleanupXcode: options => {
      calls.push(options);
      return { removed: [], bytesFreed: 0 };
    },
    sweepTemporary: options => {
      calls.push(options);
      return { removed: [] };
    },
  };
  const now = Date.now();
  automaticallyMaintainMobileStorage({ stateRoot: root, now }, dependencies);
  automaticallyMaintainMobileStorage({ stateRoot: root, now: now + 1 }, dependencies);
  assert.deepEqual(calls, [{ includeOtherProjects: false }, { dryRun: false }]);
  automaticallyMaintainMobileStorage({ stateRoot: root, now: now + 86400001 }, dependencies);
  assert.equal(calls.length, 4);
  assert.doesNotThrow(() => automaticallyMaintainMobileStorage({ stateRoot: root, now: now + 172800002 }, {
    ...dependencies, cleanupXcode: () => { throw new Error('unavailable'); },
  }));
});

test('automatic state never follows a symlink or overwrites unrelated files', t => {
  const root = fixture(t);
  const outside = path.join(root, 'keep');
  fs.writeFileSync(outside, 'keep');
  const stateRoot = path.join(root, 'state');
  fs.mkdirSync(stateRoot);
  fs.symlinkSync(outside, path.join(stateRoot, 'storage-maintenance.json'));
  automaticallyMaintainMobileStorage({ stateRoot }, {
    cleanupXcode: () => assert.fail('unsafe state must skip cleanup'),
  });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('native launch invokes housekeeping before preparation; web never does', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const calls = [];
  const dependencies = {
    doctorWeb: () => {}, writeRuntimeConfig: () => {},
    monitorNativeBuildInputs: () => {},
    maintainMobileStorage: () => calls.push('storage'),
    runIos: async () => calls.push('ios'),
    runAndroid: async () => calls.push('android'),
    runMobile: async () => calls.push('mobile'),
    runWeb: () => calls.push('web'),
  };
  for (const platform of ['ios', 'android', 'mobile', 'web']) {
    await runFrontend({ platform, output: root }, dependencies);
  }
  assert.deepEqual(calls, ['storage', 'ios', 'storage', 'android', 'storage', 'mobile', 'web']);
});
