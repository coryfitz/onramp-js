const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_SCHEMA_VERSION = 1;
const SHARED_NATIVE_INPUTS = [
  'app.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];
const IGNORED_DIRECTORIES = new Set([
  '.cxx',
  '.gradle',
  '.kotlin',
  '.git',
  'build',
  'DerivedData',
  'Pods',
  'xcuserdata',
]);
const IGNORED_FILES = new Set([
  '.DS_Store',
]);

function nativeBuildStatePath(outputDir) {
  return path.join(
    path.resolve(outputDir),
    'node_modules',
    '.cache',
    'onramp',
    'native-launch-state'
  );
}

function hashFile(hash, root, filePath) {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  hash.update(`file:${relative}\0`);
  hash.update(fs.readFileSync(filePath));
  hash.update('\0');
}

function hashDirectory(hash, root, directory) {
  if (!fs.existsSync(directory)) {
    hash.update(`missing:${path.relative(root, directory)}\0`);
    return;
  }
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    if (entry.isFile() && IGNORED_FILES.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      hashDirectory(hash, root, entryPath);
    } else if (entry.isFile()) {
      hashFile(hash, root, entryPath);
    } else if (entry.isSymbolicLink()) {
      const relative = path.relative(root, entryPath).split(path.sep).join('/');
      hash.update(`link:${relative}:${fs.readlinkSync(entryPath)}\0`);
    }
  }
}

function nativeBuildFingerprint(outputDir, platform) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Native build fingerprints support only ios or android.');
  }
  const root = path.resolve(outputDir);
  const hash = crypto.createHash('sha256');
  hash.update(`onramp-native-build-v${STATE_SCHEMA_VERSION}:${platform}\0`);
  for (const relativePath of SHARED_NATIVE_INPUTS) {
    const filePath = path.join(root, relativePath);
    if (fs.existsSync(filePath)) {
      hashFile(hash, root, filePath);
    }
  }
  hashDirectory(hash, root, path.join(root, platform));
  return hash.digest('hex');
}

function readNativeBuildState(outputDir) {
  try {
    const state = JSON.parse(
      fs.readFileSync(nativeBuildStatePath(outputDir), 'utf8')
    );
    if (state.schemaVersion === STATE_SCHEMA_VERSION) {
      return state;
    }
  } catch (_error) {
    // Missing or invalid advisory state always falls back to a native build.
  }
  return { schemaVersion: STATE_SCHEMA_VERSION };
}

function cachedNativeBuild(outputDir, platform) {
  return readNativeBuildState(outputDir)[platform] || null;
}

function recordNativeBuild(outputDir, platform, details = {}) {
  const state = readNativeBuildState(outputDir);
  state[platform] = {
    ...details,
    fingerprint: nativeBuildFingerprint(outputDir, platform),
  };
  const statePath = nativeBuildStatePath(outputDir);
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
  return state[platform];
}

function clearNativeBuildState(outputDir, platform) {
  const statePath = nativeBuildStatePath(outputDir);
  if (!platform) {
    fs.rmSync(statePath, { force: true });
    return;
  }
  const state = readNativeBuildState(outputDir);
  delete state[platform];
  const remaining = Object.keys(state).filter(key => key !== 'schemaVersion');
  if (remaining.length === 0) {
    fs.rmSync(statePath, { force: true });
    return;
  }
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
}

module.exports = {
  cachedNativeBuild,
  clearNativeBuildState,
  nativeBuildFingerprint,
  nativeBuildStatePath,
  readNativeBuildState,
  recordNativeBuild,
};
