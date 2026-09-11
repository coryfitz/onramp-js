const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  createOwnedTemporaryDirectory,
  removeOwnedTemporaryDirectory,
  sweepAbandonedTemporaryDirectories,
} = require('../src/owned-temporary');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const DEAD_PID = 2147483646;
const MARKER = '.onramp-temporary.json';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-owned-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    temporaryRoot: root, now: NOW, processState: () => 'dead',
  };
  const create = (overrides = {}, kind = 'native-project') => {
    const directory = createOwnedTemporaryDirectory(kind, {
      temporaryRoot: root, now: NOW - 2 * DAY, pid: DEAD_PID, ...overrides,
    });
    fs.writeFileSync(path.join(directory, 'disposable.txt'), 'fixture');
    return directory;
  };
  return { root, options, create };
}

function changeMarker(directory, modify) {
  const file = path.join(directory, MARKER);
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  modify(marker);
  fs.writeFileSync(file, JSON.stringify(marker));
}

test('creates a canonical private marker and removes only current-process-owned output', t => {
  const f = fixture(t);
  const directory = createOwnedTemporaryDirectory('native-project', { temporaryRoot: f.root });
  const marker = JSON.parse(fs.readFileSync(path.join(directory, MARKER), 'utf8'));
  assert.equal(marker.root, f.root);
  assert.equal(marker.pid, process.pid);
  assert.equal(marker.kind, 'native-project');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, MARKER)).mode & 0o777, 0o600);
  }
  assert.equal(removeOwnedTemporaryDirectory(directory, { temporaryRoot: f.root }), true);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(removeOwnedTemporaryDirectory(directory, { temporaryRoot: f.root }), false);
  const abandoned = f.create();
  assert.equal(removeOwnedTemporaryDirectory(abandoned, { temporaryRoot: f.root }), false);
  assert.equal(fs.existsSync(abandoned), true);
});

test('dry-run is the default and describes only verified abandoned output', t => {
  const f = fixture(t);
  const directory = f.create({}, 'android-tools');
  const result = sweepAbandonedTemporaryDirectories(f.options);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].path, directory);
  assert.equal(result.candidates[0].kind, 'android-tools');
  assert.ok(result.candidates[0].bytes > 0);
  assert.equal(result.candidates[0].ageMs, 2 * DAY);
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(directory), true);
});

test('explicit cleanup removes abandoned owned trees but preserves unrelated and legacy folders', t => {
  const f = fixture(t);
  const native = f.create();
  const tools = f.create({}, 'android-tools');
  const legacy = fs.mkdtempSync(path.join(f.root, 'onramp-js-'));
  const unrelated = path.join(f.root, 'project');
  fs.mkdirSync(unrelated);
  const result = sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false });
  assert.deepEqual(result.removed.map(value => value.path).sort(), [native, tools].sort());
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.cleanup-lock')), false);
});

test('keeps recent and future markers even when the requested age threshold is shorter', t => {
  const f = fixture(t);
  const recent = f.create({ now: NOW - 60 * 60 * 1000 });
  const future = f.create({ now: NOW + DAY });
  const result = sweepAbandonedTemporaryDirectories({ ...f.options, minAgeMs: 1, dryRun: false });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(future), true);
});

test('keeps live, reused, and uncertain process IDs and always keeps its own process', t => {
  const f = fixture(t);
  const directory = f.create();
  for (const state of ['alive', 'unknown', undefined]) {
    const result = sweepAbandonedTemporaryDirectories({
      ...f.options, dryRun: false, processState: () => state,
    });
    assert.deepEqual(result.removed, []);
    assert.equal(fs.existsSync(directory), true);
  }
  const live = f.create({ pid: process.pid });
  const result = sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false });
  assert.ok(!result.removed.some(value => value.path === live));
  assert.equal(fs.existsSync(live), true);
});

test('the default OS process probe preserves an actually running process', t => {
  const f = fixture(t);
  const directory = f.create({ pid: process.ppid });
  const result = sweepAbandonedTemporaryDirectories({
    temporaryRoot: f.root, now: NOW, dryRun: false,
  });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(directory), true);
});

test('malformed, unrecognized, oversized, or mismatched ownership markers are preserved', t => {
  const f = fixture(t);
  const mutations = [
    marker => { marker.root = path.dirname(f.root); },
    marker => { marker.name = '../escape'; },
    marker => { marker.kind = 'android-tools'; },
    marker => { marker.schemaVersion = 2; },
    marker => { marker.pid = -1; },
    marker => { marker.pid = '12'; },
    marker => { marker.createdAt = 'yesterday'; },
    marker => { marker.ownerUid = 'other-user'; },
    marker => { marker.extra = 'unexpected'; },
  ];
  const directories = mutations.map(mutate => {
    const directory = f.create();
    changeMarker(directory, mutate);
    return directory;
  });
  for (const text of ['not-json', 'null', '[]', ' '.repeat(5000)]) {
    const directory = f.create();
    fs.writeFileSync(path.join(directory, MARKER), text);
    directories.push(directory);
  }
  const result = sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false });
  assert.deepEqual(result.removed, []);
  directories.forEach(directory => assert.equal(fs.existsSync(directory), true));
});

test('renaming an owned directory or requesting a different root cannot authorize removal', t => {
  const f = fixture(t);
  const directory = f.create({ pid: process.pid });
  const moved = path.join(f.root, 'onramp-js-ABCDEF');
  fs.renameSync(directory, moved);
  assert.equal(removeOwnedTemporaryDirectory(moved, { temporaryRoot: f.root }), false);
  const outside = path.join(f.root, 'other-root');
  fs.mkdirSync(outside);
  assert.equal(removeOwnedTemporaryDirectory(moved, { temporaryRoot: outside }), false);
  assert.deepEqual(sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false }).removed, []);
  assert.equal(fs.existsSync(moved), true);
});

test('top-level and nested directory symlinks never delete their targets', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'external');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  const linked = path.join(f.root, 'onramp-js-ABCDEF');
  fs.symlinkSync(outside, linked, 'junction');
  const nested = f.create();
  fs.symlinkSync(outside, path.join(nested, 'linked'), 'junction');
  const result = sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
  assert.equal(fs.existsSync(nested), true);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

test('linked marker files are preserved', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const directory = f.create();
  const marker = path.join(directory, MARKER);
  const external = path.join(f.root, 'saved-marker');
  fs.renameSync(marker, external);
  fs.symlinkSync(external, marker);
  assert.deepEqual(sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false }).removed, []);
  assert.equal(fs.existsSync(external), true);
});

test('hard-linked entries are not treated as exclusively owned disposable output', t => {
  const f = fixture(t);
  const directory = f.create();
  const external = path.join(f.root, 'retained-file');
  fs.linkSync(path.join(directory, 'disposable.txt'), external);
  assert.deepEqual(sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false }).removed, []);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(external), true);
});

test('canonicalizes the configured root once without following candidate links', t => {
  const f = fixture(t);
  const alias = path.join(f.root, 'root-alias');
  const actual = path.join(f.root, 'actual-root');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, 'junction');
  const directory = createOwnedTemporaryDirectory('android-tools', { temporaryRoot: alias });
  assert.equal(path.dirname(directory), actual);
  assert.equal(removeOwnedTemporaryDirectory(directory, { temporaryRoot: alias }), true);
});

test('bounds each sweep to 100 matching entries by default and validates overrides', t => {
  const f = fixture(t);
  for (let index = 0; index < 105; index += 1) f.create();
  assert.equal(sweepAbandonedTemporaryDirectories(f.options).candidates.length, 100);
  assert.equal(sweepAbandonedTemporaryDirectories({ ...f.options, limit: 3 }).candidates.length, 3);
  for (const limit of [0, -1, 1001, 1.5, '5']) {
    const result = sweepAbandonedTemporaryDirectories({ ...f.options, limit, dryRun: false });
    assert.equal(result.errors.length, 1);
    assert.deepEqual(result.removed, []);
  }
});

test('rechecks process liveness after acquiring the cleanup claim', t => {
  const f = fixture(t);
  const directory = f.create();
  let checks = 0;
  const result = sweepAbandonedTemporaryDirectories({
    ...f.options, dryRun: false, processState: () => ++checks === 1 ? 'dead' : 'alive',
  });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.cleanup-lock')), false);
});

test('keeps output changed during a liveness recheck', t => {
  const f = fixture(t);
  const directory = f.create();
  let checks = 0;
  const result = sweepAbandonedTemporaryDirectories({
    ...f.options, dryRun: false, processState: () => {
      if (++checks === 2) fs.writeFileSync(path.join(directory, 'new-work'), 'keep');
      return 'dead';
    },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.existsSync(path.join(directory, 'new-work')), true);
});

test('concurrent sweeps cannot claim or remove the same directory twice', t => {
  const f = fixture(t);
  const directory = f.create();
  let checks = 0;
  let concurrent;
  const result = sweepAbandonedTemporaryDirectories({
    ...f.options, dryRun: false, processState: () => {
      if (++checks === 2) {
        concurrent = sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false });
      }
      return 'dead';
    },
  });
  assert.deepEqual(concurrent.removed, []);
  assert.deepEqual(result.removed.map(value => value.path), [directory]);
});

test('existing or linked cleanup claims are never overwritten or removed', t => {
  const f = fixture(t);
  const directory = f.create();
  const lock = path.join(f.root, '.' + path.basename(directory) + '.cleanup-lock');
  fs.writeFileSync(lock, 'another sweeper');
  assert.deepEqual(sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false }).removed, []);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another sweeper');
  assert.equal(fs.existsSync(directory), true);
});

test('a linked cleanup claim never writes through to another file', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const directory = f.create();
  const outside = path.join(f.root, 'retained-lock-target');
  fs.writeFileSync(outside, 'keep');
  const lock = path.join(f.root, '.' + path.basename(directory) + '.cleanup-lock');
  fs.symlinkSync(outside, lock);
  assert.deepEqual(sweepAbandonedTemporaryDirectories({ ...f.options, dryRun: false }).removed, []);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
  assert.equal(fs.existsSync(directory), true);
});

test('a candidate replaced by a symlink during inspection cannot redirect cleanup', t => {
  const f = fixture(t);
  const directory = f.create();
  const outside = path.join(f.root, 'keep-outside');
  const moved = path.join(f.root, 'original-tree');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'keep');
  let checks = 0;
  const result = sweepAbandonedTemporaryDirectories({
    ...f.options, dryRun: false, processState: () => {
      if (++checks === 1) {
        fs.renameSync(directory, moved);
        fs.symlinkSync(outside, directory, 'junction');
      }
      return 'dead';
    },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.equal(fs.existsSync(moved), true);
});

test('native platform generation removes marked staging after success or failure', async t => {
  const f = fixture(t);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'native.js'), 'utf8');
  for (const fail of [false, true]) {
    const output = path.join(f.root, fail ? 'failing-app' : 'working-app');
    fs.mkdirSync(path.join(output, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ devDependencies: {
      '@react-native-community/cli': '1',
      '@react-native-community/cli-platform-ios': '1',
      '@react-native-community/cli-platform-android': '1',
    } }));
    fs.writeFileSync(path.join(output, 'app.json'), '{}');
    let staging;
    const module = { exports: {} };
    const dependencies = {
      fs, path,
      './owned-temporary': {
        createOwnedTemporaryDirectory: kind => {
          staging = createOwnedTemporaryDirectory(kind, { temporaryRoot: f.root });
          return staging;
        },
        removeOwnedTemporaryDirectory: directory => removeOwnedTemporaryDirectory(directory, {
          temporaryRoot: f.root,
        }),
      },
      './native-config': {
        nativeProjectName: () => 'Fixture',
        prepareNativeConfig: () => ({ name: 'Fixture', displayName: 'Fixture',
          android: { package: 'com.fixture' }, ios: { bundleIdentifier: 'com.fixture' } }),
        syncNativeProjects: () => [],
      },
      './process': {
        run: (_command, args) => {
          const marker = JSON.parse(fs.readFileSync(path.join(staging, MARKER), 'utf8'));
          assert.equal(marker.kind, 'native-project');
          if (fail) throw new Error('test generation failed');
          const project = args[args.indexOf('--directory') + 1];
          fs.mkdirSync(path.join(project, 'android'), { recursive: true });
          fs.writeFileSync(path.join(project, 'android', 'fixture'), 'copied output');
        },
      },
      '../templates/package.json': require('../templates/package.json'),
    };
    vm.runInNewContext(source, {
      module, require: name => {
        if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected dependency: ' + name);
        return dependencies[name];
      },
      process, console: { log: () => {} },
    });
    const operation = module.exports.addNativePlatforms({ platform: 'android', output });
    if (fail) await assert.rejects(operation, /test generation failed/);
    else {
      await operation;
      assert.equal(fs.readFileSync(path.join(output, 'android', 'fixture'), 'utf8'), 'copied output');
    }
    assert.ok(staging);
    assert.equal(fs.existsSync(staging), false);
  }
});

test('inspection failures remain nonfatal and never claim successful deletion', t => {
  const f = fixture(t);
  const result = sweepAbandonedTemporaryDirectories({
    ...f.options, temporaryRoot: path.join(f.root, 'missing'), dryRun: false,
  });
  assert.deepEqual(result.removed, []);
  assert.equal(result.errors.length, 1);
  assert.throws(() => createOwnedTemporaryDirectory('unknown', { temporaryRoot: f.root }), /Unknown/);
});
