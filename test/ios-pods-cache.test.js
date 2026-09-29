const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {ensureIosPods} = require('../src/ios');
const {iosPodsAreCurrent, iosPodsStatePath, recordIosPods} = require('../src/ios-pods-cache');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-pods-cache-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const ios = path.join(root, 'ios');
  const write = (relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, value);
    return target;
  };
  write('package.json', '{}');
  write('package-lock.json', '{}');
  write('ios/Podfile', 'platform :ios');
  write('ios/Podfile.lock', 'LOCKED');
  write('ios/Pods/Manifest.lock', 'LOCKED');
  write('ios/Pods/Pods.xcodeproj/project.pbxproj', 'IPHONEOS_DEPLOYMENT_TARGET = 15.1;\n');
  write('node_modules/react-native/scripts/cocoapods/helpers.rb',
    "def self.min_ios_version_supported\n  return '15.1'\nend\n");
  return {root, ios, write};
}

test('recorded Pods stay current after identical dependency files are touched', t => {
  const {root, ios} = fixture(t);
  recordIosPods(ios, root);
  const stateTime = fs.statSync(iosPodsStatePath(root)).mtimeMs;
  const future = new Date(Date.now() + 10000);
  for (const relative of ['package.json', 'package-lock.json', 'ios/Podfile', 'ios/Podfile.lock']) {
    fs.utimesSync(path.join(root, relative), future, future);
  }
  assert.equal(iosPodsAreCurrent(ios, root), true);
  recordIosPods(ios, root);
  assert.equal(fs.statSync(iosPodsStatePath(root)).mtimeMs, stateTime);
});

for (const relative of [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'react-native.config.js', 'ios/Podfile', 'Gemfile.lock',
  'ios/Gemfile.lock', 'node_modules/.package-lock.json',
]) {
  test(`Pods content cache notices ${relative} changes even with older timestamps`, t => {
    const {root, ios, write} = fixture(t);
    recordIosPods(ios, root);
    const filePath = write(relative, 'changed');
    const past = new Date(1000);
    fs.utimesSync(filePath, past, past);
    assert.equal(iosPodsAreCurrent(ios, root), false);
  });
}

test('Pods cache notices a dependency input being removed', t => {
  const {root, ios, write} = fixture(t);
  const config = write('react-native.config.js', 'module.exports = {};');
  recordIosPods(ios, root);
  fs.rmSync(config);
  assert.equal(iosPodsAreCurrent(ios, root), false);
});

test('matching cache never overrides missing or divergent installed lockfiles', t => {
  const {root, ios, write} = fixture(t);
  recordIosPods(ios, root);
  write('ios/Pods/Manifest.lock', 'OTHER');
  assert.equal(iosPodsAreCurrent(ios, root), false);
  fs.rmSync(path.join(ios, 'Pods', 'Manifest.lock'));
  assert.equal(iosPodsAreCurrent(ios, root), false);
});

test('malformed or unsupported Pods cache is conservative', t => {
  const {root, ios} = fixture(t);
  recordIosPods(ios, root);
  fs.writeFileSync(iosPodsStatePath(root), '{invalid');
  assert.equal(iosPodsAreCurrent(ios, root), false);
  fs.writeFileSync(iosPodsStatePath(root), '{"schemaVersion":99}');
  assert.equal(iosPodsAreCurrent(ios, root), false);
});

test('successful pod install is recorded even when CocoaPods keeps its old manifest timestamp', t => {
  const {root, ios} = fixture(t);
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(root, 'package-lock.json'), future, future);
  let installs = 0;
  const options = {outputDir: root, runCommand: () => { installs += 1; }};
  const environment = {env: {}, pod: 'unused-pod', xcrun: '/missing/xcrun'};
  ensureIosPods(ios, environment, options);
  ensureIosPods(ios, environment, options);
  assert.equal(installs, 1);
  ensureIosPods(ios, environment, {...options, force: true});
  assert.equal(installs, 2);
});

test('failed pod install does not record new inputs as installed', t => {
  const {root, ios, write} = fixture(t);
  recordIosPods(ios, root);
  write('package.json', '{"dependencies":{"native-package":"1.0.0"}}');
  assert.throws(() => ensureIosPods(ios, {
    env: {}, pod: 'unused-pod', xcrun: '/missing/xcrun',
  }, {
    outputDir: root,
    runCommand: () => { throw new Error('pod install failed'); },
  }), /pod install failed/);
  assert.equal(iosPodsAreCurrent(ios, root), false);
});

test('edits made while pod install runs are not marked as installed', t => {
  const {root, ios, write} = fixture(t);
  const manifest = path.join(ios, 'Pods', 'Manifest.lock');
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(manifest, future, future);
  assert.throws(() => ensureIosPods(ios, {env: {}, pod: 'unused-pod', xcrun: '/missing/xcrun'}, {
    outputDir: root,
    force: true,
    runCommand: () => {
      const podfile = write('ios/Podfile', 'platform :ios, "17.0"');
      fs.utimesSync(podfile, new Date(1000), new Date(1000));
    },
  }), /iOS dependency inputs changed during setup/);
  assert.equal(iosPodsAreCurrent(ios, root), false);
});

test('CocoaPods may update its generated lockfile during a successful installation', t => {
  const {root, ios, write} = fixture(t);
  ensureIosPods(ios, {env: {}, pod: 'unused-pod', xcrun: '/missing/xcrun'}, {
    outputDir: root,
    force: true,
    runCommand: () => {
      write('ios/Podfile.lock', 'UPDATED');
      write('ios/Pods/Manifest.lock', 'UPDATED');
    },
  });
  assert.equal(iosPodsAreCurrent(ios, root), true);
});
