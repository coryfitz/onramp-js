const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = '.onramp-temporary.json';
const MINIMUM_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const PREFIXES = {
  'native-project': 'onramp-js-',
  'android-tools': 'onramp-android-tools-',
};
const NAME = /^(?:onramp-js-|onramp-android-tools-)[A-Za-z0-9]{6}$/;
const MARKER_KEYS = [
  'createdAt', 'kind', 'name', 'ownerUid', 'pid', 'root', 'schemaVersion',
];

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function canonicalRoot(options) {
  // macOS's system temporary path can itself contain /var -> /private/var.
  // Resolve that once; all owned directories must be direct, ordinary children.
  return fs.realpathSync(options.temporaryRoot || os.tmpdir());
}

function createOwnedTemporaryDirectory(kind, options = {}) {
  if (!Object.hasOwn(PREFIXES, kind)) throw new Error('Unknown temporary directory kind.');
  const root = canonicalRoot(options);
  const directory = fs.mkdtempSync(path.join(root, PREFIXES[kind]));
  const marker = {
    schemaVersion: 1,
    kind,
    pid: options.pid === undefined ? process.pid : options.pid,
    createdAt: options.now === undefined ? Date.now() : options.now,
    root,
    name: path.basename(directory),
    ownerUid: currentUid(),
  };
  try {
    fs.writeFileSync(path.join(directory, MARKER), JSON.stringify(marker) + '\n', {
      flag: 'wx', mode: 0o600,
    });
  } catch (error) {
    // Only an empty directory created by this call is eligible on failure.
    try { fs.rmdirSync(directory); } catch (_cleanupError) { /* Preserve uncertain state. */ }
    throw error;
  }
  return directory;
}

function inspect(directory, root, isEligible) {
  if (path.dirname(directory) !== root || !NAME.test(path.basename(directory))) return null;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync(directory) !== directory
      || (currentUid() !== null && stat.uid !== currentUid())) return null;
  const markerPath = path.join(directory, MARKER);
  const markerStat = fs.lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1
      || markerStat.size > 4096
      || (currentUid() !== null && markerStat.uid !== currentUid())) return null;
  const contents = fs.readFileSync(markerPath, 'utf8');
  const marker = JSON.parse(contents);
  if (!marker || Array.isArray(marker)
      || JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(MARKER_KEYS)
      || marker.schemaVersion !== 1 || !Object.hasOwn(PREFIXES, marker.kind)
      || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
      || !Number.isSafeInteger(marker.createdAt) || marker.createdAt < 0
      || marker.ownerUid !== currentUid()
      || marker.root !== root || marker.name !== path.basename(directory)
      || !marker.name.startsWith(PREFIXES[marker.kind])) return null;
  // Native launch should not recursively inspect active or recent staging.
  if (isEligible && !isEligible({ marker })) return null;

  let bytes = 0;
  let entries = 0;
  const fingerprint = crypto.createHash('sha256');
  fingerprint.update(JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid, contents]));
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (++entries > 10000) throw new Error('Temporary directory inspection limit reached.');
      const file = path.join(current, entry.name);
      const info = fs.lstatSync(file);
      if (info.isSymbolicLink() || info.dev !== stat.dev
          || (!info.isDirectory() && !info.isFile())
          || (info.isFile() && info.nlink !== 1)
          || (currentUid() !== null && info.uid !== currentUid())) {
        throw new Error('Temporary directory contains linked or unowned entries.');
      }
      fingerprint.update(JSON.stringify([
        path.relative(directory, file), info.dev, info.ino, info.mode,
        info.size, info.mtimeMs, info.ctimeMs,
      ]));
      if (info.isDirectory()) visit(file);
      else bytes += info.blocks === undefined ? info.size : info.blocks * 512;
    }
  }
  visit(directory);
  return { marker, bytes, fingerprint: fingerprint.digest('hex') };
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    // EPERM and provider errors are uncertainty, not proof of a dead owner.
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function removeInspected(directory, root, previous, eligible) {
  // Keep the lock beside the directory: a changed candidate must never cause
  // us to create a file through a symlink into an unrelated directory.
  const lock = path.join(root, '.' + path.basename(directory) + '.cleanup-lock');
  let descriptor;
  try {
    // Cooperating launchers cannot both remove or partially inspect one tree.
    descriptor = fs.openSync(lock, 'wx', 0o600);
    const current = inspect(directory, root);
    if (!current || current.fingerprint !== previous.fingerprint || !eligible(current)) return false;
    const final = inspect(directory, root);
    if (!final || final.fingerprint !== current.fingerprint) return false;
    fs.rmSync(directory, { recursive: true, force: false });
    return !fs.existsSync(directory);
  } finally {
    if (descriptor !== undefined) {
      const ownedLock = fs.fstatSync(descriptor);
      fs.closeSync(descriptor);
      try {
        const remainingLock = fs.lstatSync(lock);
        if (remainingLock.dev === ownedLock.dev && remainingLock.ino === ownedLock.ino) {
          fs.unlinkSync(lock);
        }
      } catch (_error) { /* The tree may have been removed; never touch another lock. */ }
    }
  }
}

function removeOwnedTemporaryDirectory(directory, options = {}) {
  try {
    const root = canonicalRoot(options);
    const candidate = inspect(directory, root);
    const pid = options.pid === undefined ? process.pid : options.pid;
    if (!candidate || candidate.marker.pid !== pid) return false;
    return removeInspected(directory, root, candidate, current => current.marker.pid === pid);
  } catch (_error) {
    // Cleanup must not hide the original generation or installation failure.
    return false;
  }
}

function sweepAbandonedTemporaryDirectories(options = {}) {
  const result = { candidates: [], removed: [], skipped: 0, errors: [] };
  const now = options.now === undefined ? Date.now() : options.now;
  const minAgeMs = Math.max(MINIMUM_AGE_MS, options.minAgeMs || MINIMUM_AGE_MS);
  const limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;
  const state = options.processState || processState;
  if (!Number.isFinite(now) || !Number.isFinite(minAgeMs)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    result.errors.push('Invalid temporary cleanup options.');
    return result;
  }
  try {
    const root = canonicalRoot(options);
    const eligible = candidate => now - candidate.marker.createdAt >= minAgeMs
      && candidate.marker.pid !== process.pid
      && state(candidate.marker.pid) === 'dead';
    const handle = fs.opendirSync(root);
    let inspected = 0;
    let scanned = 0;
    try {
      let entry;
      while (inspected < limit && scanned++ < 10000 && (entry = handle.readSync())) {
        if (!NAME.test(entry.name)) continue;
        inspected += 1;
        const directory = path.join(root, entry.name);
        try {
          const candidate = inspect(directory, root, eligible);
          if (!candidate) { result.skipped += 1; continue; }
          const description = {
            path: directory, kind: candidate.marker.kind,
            ageMs: now - candidate.marker.createdAt, bytes: candidate.bytes,
          };
          result.candidates.push(description);
          if (options.dryRun === false) {
            if (removeInspected(directory, root, candidate, eligible)) result.removed.push(description);
            else result.skipped += 1;
          }
        } catch (error) {
          result.skipped += 1;
          // Unmarked legacy folders are expected and never automatically removed.
          if (error.code !== 'ENOENT' && error.code !== 'EEXIST') {
            result.errors.push('Kept ' + entry.name + ': ' + error.message);
          }
        }
      }
    } finally {
      handle.closeSync();
    }
  } catch (error) {
    result.errors.push('Temporary cleanup unavailable: ' + error.message);
  }
  return result;
}

module.exports = {
  createOwnedTemporaryDirectory,
  removeOwnedTemporaryDirectory,
  sweepAbandonedTemporaryDirectories,
};
