const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cachedNativeBuild,
  clearNativeBuildState,
  nativeBuildFingerprint,
  nativeBuildStatePath,
  recordNativeBuild,
} = require('../src/native-build-cache');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-native-cache-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'ios'));
  fs.mkdirSync(path.join(root, 'android'));
  fs.writeFileSync(path.join(root, 'app.json'), '{"name":"Example"}\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"example"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'app', 'index.tsx'), 'export default 1;\n');
  fs.writeFileSync(path.join(root, 'ios', 'Podfile'), 'platform :ios, "15.1"\n');
  fs.writeFileSync(path.join(root, 'android', 'settings.gradle'), 'rootProject.name="Example"\n');
  return root;
}

test('native fingerprints ignore JavaScript source and generated native output', () => {
  const root = makeProject();
  try {
    const before = nativeBuildFingerprint(root, 'ios');
    fs.writeFileSync(path.join(root, 'app', 'index.tsx'), 'export default 2;\n');
    fs.mkdirSync(path.join(root, 'ios', 'build'));
    fs.writeFileSync(path.join(root, 'ios', 'build', 'generated.txt'), 'new');
    assert.equal(nativeBuildFingerprint(root, 'ios'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native fingerprints change for shared and platform-native inputs', () => {
  const root = makeProject();
  try {
    const iosBefore = nativeBuildFingerprint(root, 'ios');
    fs.appendFileSync(path.join(root, 'ios', 'Podfile'), '# native change\n');
    assert.notEqual(nativeBuildFingerprint(root, 'ios'), iosBefore);

    const androidBefore = nativeBuildFingerprint(root, 'android');
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":4}\n');
    assert.notEqual(nativeBuildFingerprint(root, 'android'), androidBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('records and clears project-local native launch state under the npm cache', () => {
  const root = makeProject();
  try {
    const recorded = recordNativeBuild(root, 'ios', {
      bundleIdentifier: 'com.example.app',
      simulatorId: 'SIMULATOR-ID',
    });
    assert.equal(recorded.bundleIdentifier, 'com.example.app');
    assert.deepEqual(cachedNativeBuild(root, 'ios'), recorded);
    assert.match(
      nativeBuildStatePath(root),
      /node_modules[/\\]\.cache[/\\]onramp[/\\]native-launch-state$/
    );

    clearNativeBuildState(root, 'ios');
    assert.equal(cachedNativeBuild(root, 'ios'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
