const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectXcodeBuildStorage, cleanupAbandonedXcodeBuilds } = require('../src/xcode-storage');

const DAY = 86400000;

function harness(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-storage-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'DerivedData');
  const temp = path.join(base, 'tmp');
  fs.mkdirSync(root);
  fs.mkdirSync(temp);
  const now = Date.now();
  const options = {
    platform: 'darwin', derivedDataRoot: root, temporaryRoots: [temp], now,
    processReader: () => ['/usr/bin/node'],
    plistReader: file => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
  function age(directory, days = 10) {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) age(file, days);
      else fs.utimesSync(file, new Date(now - days * DAY), new Date(now - days * DAY));
    }
    fs.utimesSync(directory, new Date(now - days * DAY), new Date(now - days * DAY));
  }
  function cache(letter = 'a', workspace = path.join(temp, `onramp-smoke.${letter}`, 'build/ios/Demo.xcworkspace')) {
    const directory = path.join(root, `Demo-${letter.repeat(28)}`);
    for (const part of ['Build/Products', 'Index.noindex', 'Logs']) {
      fs.mkdirSync(path.join(directory, part), { recursive: true });
    }
    fs.writeFileSync(path.join(directory, 'info.plist'), JSON.stringify({ WorkspacePath: workspace }));
    fs.writeFileSync(path.join(directory, 'Build/Products/binary'), 'compiled output');
    age(directory);
    return { directory, workspace };
  }
  return { base, root, temp, now, options, age, cache };
}

test('inspection is read-only and identifies allocated bytes of old temporary build orphans', t => {
  const h = harness(t);
  const cache = h.cache();
  const report = inspectXcodeBuildStorage(h.options);
  assert.equal(report.blockedReason, null);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].workspacePath, cache.workspace);
  assert.equal(report.candidates[0].temporaryWorkspace, true);
  assert.equal(report.candidates[0].eligible, true);
  assert.ok(report.candidates[0].bytes > 0);
  assert.ok(fs.existsSync(cache.directory));
});

test('macOS plist reader supports real Xcode metadata containing date objects', { skip: process.platform !== 'darwin' }, t => {
  const h = harness(t);
  const cache = h.cache();
  fs.writeFileSync(path.join(cache.directory, 'info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>WorkspacePath</key><string>${cache.workspace}</string>
<key>LastAccessedDate</key><date>2026-08-01T00:00:00Z</date></dict></plist>`);
  h.age(cache.directory);
  delete h.options.plistReader;
  assert.equal(inspectXcodeBuildStorage(h.options).candidates[0].eligible, true);
  assert.ok(fs.existsSync(cache.directory));
});

test('automatic cleanup removes only abandoned temporary build products, not shared caches or installed tools', t => {
  const h = harness(t);
  const cache = h.cache();
  for (const name of ['ModuleCache.noindex', 'SDKStatCaches.noindex', 'CompilationCache.noindex', 'Devices', 'Pods']) {
    fs.mkdirSync(path.join(h.root, name));
  }
  const current = h.cache('b');
  fs.mkdirSync(current.workspace, { recursive: true });
  const report = cleanupAbandonedXcodeBuilds(h.options);
  assert.deepEqual(report.removed.map(item => item.path), [cache.directory]);
  assert.ok(report.bytesFreed > 0);
  assert.ok(fs.existsSync(current.directory));
  assert.ok(fs.existsSync(path.join(h.root, 'ModuleCache.noindex')));
  assert.ok(fs.existsSync(path.join(h.root, 'Pods')));
});

test('other deleted projects are report-only unless explicitly opted into cleanup', t => {
  const h = harness(t);
  const cache = h.cache('a', path.join(h.base, 'Desktop/myapp/build/ios/Myapp.xcworkspace'));
  const report = inspectXcodeBuildStorage(h.options);
  assert.equal(report.candidates[0].temporaryWorkspace, false);
  assert.equal(report.candidates[0].eligible, false);
  assert.match(report.candidates[0].reason, /explicit cleanup approval/);
  assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0);
  assert.ok(fs.existsSync(cache.directory));
  assert.equal(cleanupAbandonedXcodeBuilds({ ...h.options, includeOtherProjects: true }).removed.length, 1);
});

test('age applies to newest nested content and cannot be disabled by a caller', t => {
  const h = harness(t);
  const cache = h.cache();
  const binary = path.join(cache.directory, 'Build/Products/binary');
  fs.utimesSync(binary, new Date(h.now), new Date(h.now));
  const report = inspectXcodeBuildStorage({ ...h.options, minAgeDays: 0 });
  assert.equal(report.candidates[0].eligible, false);
  assert.match(report.candidates[0].reason, /seven-day/);
  assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0);
});

for (const processName of ['Xcode', 'xcodebuild', 'XCBBuildService', 'clang', 'clang++', 'clang-20', 'swift', 'swiftc', 'swift-frontend', 'java', 'gradle', 'cmake', 'ninja', 'make']) {
  test(`fails closed while ${processName} is running`, t => {
    const h = harness(t);
    const cache = h.cache();
    h.options.processReader = () => [`/Applications/Developer Tools/${processName}`];
    assert.match(inspectXcodeBuildStorage(h.options).blockedReason, /running/);
    assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0);
    assert.ok(fs.existsSync(cache.directory));
  });
}

for (const processes of [[], null, [null], [''], 'node']) {
  test(`fails closed for invalid process inventory ${JSON.stringify(processes)}`, t => {
    const h = harness(t);
    h.cache();
    h.options.processReader = () => processes;
    assert.match(cleanupAbandonedXcodeBuilds(h.options).blockedReason, /unavailable/);
  });
}

test('process-reader failures and unsupported platforms are nonfatal and nonmutating', t => {
  const h = harness(t);
  const cache = h.cache();
  h.options.processReader = () => { throw new Error('ps unavailable'); };
  assert.match(cleanupAbandonedXcodeBuilds(h.options).blockedReason, /unavailable/);
  for (const platform of ['linux', 'win32']) {
    assert.equal(inspectXcodeBuildStorage({ ...h.options, platform }).supported, false);
    assert.equal(cleanupAbandonedXcodeBuilds({ ...h.options, platform }).removed.length, 0);
  }
  assert.ok(fs.existsSync(cache.directory));
});

test('missing, malformed, oversized, or linked metadata cannot authorize deletion', t => {
  const h = harness(t);
  const a = h.cache('a');
  const b = h.cache('b');
  const c = h.cache('c');
  const d = h.cache('d');
  fs.rmSync(path.join(a.directory, 'info.plist'));
  fs.writeFileSync(path.join(b.directory, 'info.plist'), 'invalid json');
  fs.writeFileSync(path.join(c.directory, 'info.plist'), ' '.repeat(300000));
  fs.rmSync(path.join(d.directory, 'info.plist'));
  fs.symlinkSync(path.join(b.directory, 'info.plist'), path.join(d.directory, 'info.plist'));
  assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0);
});

test('workspace permission errors are not mistaken for deleted projects', t => {
  const h = harness(t);
  const cache = h.cache();
  h.options.fs = {
    ...fs,
    lstatSync: file => {
      if (file === cache.workspace) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.lstatSync(file);
    },
  };
  assert.equal(inspectXcodeBuildStorage(h.options).candidates.length, 0);
  assert.ok(fs.existsSync(cache.directory));
});

test('protects current workspace and explicit current DerivedData directory even if workspace disappeared', t => {
  const h = harness(t);
  const cache = h.cache();
  assert.equal(inspectXcodeBuildStorage({ ...h.options, currentWorkspacePath: cache.workspace }).candidates.length, 0);
  assert.equal(inspectXcodeBuildStorage({ ...h.options, currentDerivedDataPath: cache.directory }).candidates.length, 0);
});

test('rejects symlinked DerivedData roots, direct children, and nested tree entries', t => {
  const h = harness(t);
  const a = h.cache('a');
  const b = h.cache('b');
  fs.symlinkSync(h.base, path.join(a.directory, 'Build/external'));
  const old = `${b.directory}-moved`;
  fs.renameSync(b.directory, old);
  fs.symlinkSync(old, b.directory);
  const linkedParent = path.join(h.base, 'linked');
  fs.mkdirSync(linkedParent);
  fs.symlinkSync(h.root, path.join(linkedParent, 'DerivedData'));
  assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0);
  assert.match(inspectXcodeBuildStorage({ ...h.options, derivedDataRoot: path.join(linkedParent, 'DerivedData') }).blockedReason, /safely/);
  assert.ok(fs.existsSync(a.directory));
});

test('rejects missing workspaces beneath a dangling or noncanonical project symlink', t => {
  const h = harness(t);
  const a = h.cache('a');
  const b = h.cache('b');
  fs.symlinkSync(path.join(h.base, 'gone'), path.join(h.temp, 'onramp-smoke.a'));
  fs.symlinkSync(h.base, path.join(h.temp, 'onramp-smoke.b'));
  assert.equal(inspectXcodeBuildStorage(h.options).candidates.length, 0);
  assert.ok(fs.existsSync(a.directory));
  assert.ok(fs.existsSync(b.directory));
});

test('accepts known OS temporary-root aliases without trusting arbitrary project links', t => {
  const h = harness(t);
  const alias = path.join(h.base, 'temp-alias');
  fs.symlinkSync(h.temp, alias);
  const cache = h.cache('a', path.join(alias, 'onramp-e2e.Abc123/app/ios/Demo.xcworkspace'));
  h.options.temporaryRoots = [alias];
  assert.equal(inspectXcodeBuildStorage(h.options).candidates[0].eligible, true);
  assert.ok(fs.existsSync(cache.directory));
});

test('never treats other temporary directories, malformed workspace paths, or unstructured caches as disposable', t => {
  const h = harness(t);
  h.cache('a', path.join(h.temp, 'another-project/build/Demo.xcworkspace'));
  h.cache('b', path.join(h.temp, 'onramp-project/Demo.txt'));
  h.cache('c', '/tmp/onramp-smoke/../private/Demo.xcworkspace');
  const d = h.cache('d');
  fs.rmSync(path.join(d.directory, 'Logs'), { recursive: true });
  fs.mkdirSync(path.join(h.root, 'Demo-not-a-hash'));
  assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0);
});

test('rechecks build activity before every removal', t => {
  const h = harness(t);
  const a = h.cache('a');
  const b = h.cache('b');
  let reads = 0;
  h.options.processReader = () => ++reads >= 4 ? ['xcodebuild'] : ['node'];
  const report = cleanupAbandonedXcodeBuilds(h.options);
  assert.equal(report.removed.length, 1);
  assert.match(report.blockedReason, /running/);
  assert.equal(fs.existsSync(a.directory), false);
  assert.equal(fs.existsSync(b.directory), true);
});

test('rechecks workspace existence, cache identity, and new nested symlinks after inspection', t => {
  for (const mutation of ['workspace', 'identity', 'symlink', 'recent']) {
    const h = harness(t);
    const cache = h.cache();
    let reads = 0;
    h.options.processReader = () => {
      if (++reads === 2) {
        if (mutation === 'workspace') fs.mkdirSync(cache.workspace, { recursive: true });
        if (mutation === 'identity') {
          fs.renameSync(cache.directory, `${cache.directory}-moved`);
          h.cache();
        }
        if (mutation === 'symlink') fs.symlinkSync(h.base, path.join(cache.directory, 'Build/new-link'));
        if (mutation === 'recent') fs.writeFileSync(path.join(cache.directory, 'Build/new-output'), 'new');
      }
      return ['node'];
    };
    assert.equal(cleanupAbandonedXcodeBuilds(h.options).removed.length, 0, mutation);
    assert.ok(fs.existsSync(cache.directory));
  }
});

test('inspection has bounded candidates, entries, and elapsed-time budgets', t => {
  const h = harness(t);
  h.cache('a');
  h.cache('b');
  const byCount = inspectXcodeBuildStorage({ ...h.options, maxCandidates: 1 });
  assert.equal(byCount.candidates.length, 1);
  assert.equal(byCount.truncated, true);
  const byEntries = inspectXcodeBuildStorage({ ...h.options, maxEntries: 1 });
  assert.equal(byEntries.candidates.length, 0);
  assert.equal(byEntries.truncated, true);
  let clock = 0;
  const byTime = inspectXcodeBuildStorage({ ...h.options, clock: () => ++clock, timeBudgetMs: 1 });
  assert.equal(byTime.candidates.length, 0);
  assert.equal(byTime.truncated, true);
});

test('removal errors stay nonfatal and root substitutions are not followed', t => {
  const h = harness(t);
  const cache = h.cache();
  h.options.fs = { ...fs, rmSync: () => { throw new Error('permission denied'); } };
  const report = cleanupAbandonedXcodeBuilds(h.options);
  assert.equal(report.removed.length, 0);
  assert.match(report.skipped[0].reason, /safely complete/);
  assert.ok(fs.existsSync(cache.directory));
  assert.match(inspectXcodeBuildStorage({ ...h.options, derivedDataRoot: h.base }).blockedReason, /safely/);
});

test('rechecks a substituted root after the final process inventory', t => {
  const h = harness(t);
  const cache = h.cache();
  let reads = 0;
  const moved = `${h.root}-moved`;
  h.options.processReader = () => {
    if (++reads === 3) {
      fs.renameSync(h.root, moved);
      fs.symlinkSync(moved, h.root);
    }
    return ['node'];
  };
  const report = cleanupAbandonedXcodeBuilds(h.options);
  assert.equal(report.removed.length, 0);
  assert.ok(fs.existsSync(path.join(moved, path.basename(cache.directory))));
});
