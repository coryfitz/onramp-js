const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

function iosPodsStatePath(outputDir) {
  return path.join(outputDir, 'node_modules', '.cache', 'onramp', 'ios-pods-state.json');
}

function iosPodsInputs(iosDir, outputDir) {
  return [...new Set([
    path.join(iosDir, 'Podfile'),
    path.join(iosDir, 'Podfile.lock'),
    path.join(iosDir, 'Gemfile'),
    path.join(iosDir, 'Gemfile.lock'),
    ...[
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'react-native.config.js',
      'Gemfile',
      'Gemfile.lock',
      'node_modules/.package-lock.json',
    ].map(relative => path.join(outputDir, relative)),
  ])];
}

function iosPodsFingerprint(iosDir, outputDir, includeLockfile = true) {
  const hash = crypto.createHash('sha256');
  hash.update(`onramp-ios-pods-v${SCHEMA_VERSION}\0`);
  for (const filePath of iosPodsInputs(iosDir, outputDir)) {
    if (!includeLockfile && filePath === path.join(iosDir, 'Podfile.lock')) continue;
    hash.update(`${path.relative(outputDir, filePath)}\0`);
    if (fs.existsSync(filePath)) {
      hash.update('file\0');
      hash.update(fs.readFileSync(filePath));
    } else hash.update('missing\0');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function iosPodsAreCurrent(iosDir, outputDir = path.dirname(iosDir)) {
  const lockfile = path.join(iosDir, 'Podfile.lock');
  const manifest = path.join(iosDir, 'Pods', 'Manifest.lock');
  if (!fs.existsSync(lockfile) || !fs.existsSync(manifest)) return false;
  if (!fs.readFileSync(lockfile).equals(fs.readFileSync(manifest))) return false;

  const statePath = iosPodsStatePath(outputDir);
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      return state.schemaVersion === SCHEMA_VERSION
        && state.fingerprint === iosPodsFingerprint(iosDir, outputDir);
    } catch (_error) {
      // An invalid advisory cache cannot authorize skipping dependency setup.
      return false;
    }
  }

  // Adopt an existing installation using the previous timestamp check once.
  // Later runs compare content: npm install and source-control operations can
  // touch unchanged inputs, while CocoaPods leaves Manifest.lock untouched.
  const manifestTime = fs.statSync(manifest).mtimeMs;
  return iosPodsInputs(iosDir, outputDir).every(filePath => (
    !fs.existsSync(filePath) || fs.statSync(filePath).mtimeMs <= manifestTime
  ));
}

function iosPodsSourceFingerprint(iosDir, outputDir = path.dirname(iosDir)) {
  // CocoaPods owns Podfile.lock and may legitimately update it during install.
  return iosPodsFingerprint(iosDir, outputDir, false);
}

function recordIosPods(iosDir, outputDir = path.dirname(iosDir), expectedSources) {
  const statePath = iosPodsStatePath(outputDir);
  const temporary = `${statePath}.${process.pid}.tmp`;
  const sourcesUnchanged = expectedSources === undefined
    || expectedSources === iosPodsSourceFingerprint(iosDir, outputDir);
  try {
    const contents = `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      // Keep an invalid marker when edits happened during pod install. Removing
      // state could incorrectly adopt those edits through the legacy mtime path.
      fingerprint: sourcesUnchanged ? iosPodsFingerprint(iosDir, outputDir) : null,
    }, null, 2)}\n`;
    if (fs.existsSync(statePath) && fs.readFileSync(statePath, 'utf8') === contents) {
      return sourcesUnchanged;
    }
    fs.mkdirSync(path.dirname(statePath), {recursive: true});
    fs.writeFileSync(temporary, contents, 'utf8');
    fs.renameSync(temporary, statePath);
  } catch (_error) {
    // Dependency installation remains usable when disposable cache storage is
    // unavailable; the next launch simply repeats the conservative check.
    try { fs.rmSync(temporary, {force: true}); } catch (_cleanupError) {}
  }
  return sourcesUnchanged;
}

module.exports = {iosPodsAreCurrent, iosPodsSourceFingerprint, iosPodsStatePath, recordIosPods};
