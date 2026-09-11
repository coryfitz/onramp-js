const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectXcodeBuildStorage, cleanupAbandonedXcodeBuilds } = require('./xcode-storage');
const { sweepAbandonedTemporaryDirectories } = require('./owned-temporary');

const DAY = 24 * 60 * 60 * 1000;

function formatBytes(bytes) {
  return `${(Math.max(0, Number(bytes) || 0) / 1024 ** 3).toFixed(2)} GiB`;
}

/** No emulator, device, dependency-cache, source, or backup deletion lives here. */
function runStorageCommand(options = {}, dependencies = {}) {
  const log = dependencies.log || console.log;
  const inspect = dependencies.inspectXcode || inspectXcodeBuildStorage;
  const cleanup = dependencies.cleanupXcode || cleanupAbandonedXcodeBuilds;
  const sweep = dependencies.sweepTemporary || sweepAbandonedTemporaryDirectories;
  const clean = options.clean === true;
  const settings = {
    includeOtherProjects: options.includeOtherProjects === true,
    timeBudgetMs: 30000,
    maxEntries: 1000000,
  };
  log(clean ? 'OnRamp disposable storage cleanup:' : 'OnRamp storage check (no files changed):');
  const xcode = clean ? cleanup(settings) : inspect(settings);
  const temporary = sweep({ dryRun: !clean });
  const xcodeEntries = clean ? xcode.removed : xcode.candidates;
  for (const item of xcodeEntries || []) {
    const status = clean ? 'Removed' : item.eligible ? 'Eligible' : 'Keeping';
    log(`${status}: ${formatBytes(item.bytes)} ${item.path}`);
    if (!clean && item.reason) log(`  ${item.reason}`);
  }
  for (const item of (clean ? temporary.removed : temporary.candidates) || []) {
    log(`${clean ? 'Removed' : 'Eligible'}: ${formatBytes(item.bytes)} ${item.path}`);
  }
  if (xcode.blockedReason) log(`Xcode cleanup skipped: ${xcode.blockedReason}`);
  if (xcode.truncated) log('Inspection reached its safety limit; additional output was kept.');
  for (const item of xcode.skipped || []) log(`Keeping ${item.path}: ${item.reason}`);
  for (const error of temporary.errors || []) log(`Temporary cleanup skipped: ${String(error)}`);
  const total = (clean ? Number(xcode.bytesFreed) || 0
    : (xcodeEntries || []).filter(item => item.eligible).reduce((sum, item) => sum + item.bytes, 0))
    + ((clean ? temporary.removed : temporary.candidates) || [])
      .reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  log(`${clean ? 'Removed' : 'Eligible disposable storage'}: ${formatBytes(total)}.`);
  log('Keeping installed emulator runtimes/images, all virtual-device app data, current project builds, Pods, dependency downloads, and project backups.');
  return { xcode, temporary, bytes: total };
}

/** Once-daily, best-effort housekeeping before native launch, never a launch gate. */
function automaticallyMaintainMobileStorage(options = {}, dependencies = {}) {
  const log = dependencies.log || console.log;
  const cleanup = dependencies.cleanupXcode || cleanupAbandonedXcodeBuilds;
  const sweep = dependencies.sweepTemporary || sweepAbandonedTemporaryDirectories;
  const stateRoot = options.stateRoot || path.join(os.homedir(), '.onramp');
  const statePath = path.join(stateRoot, 'storage-maintenance.json');
  const now = options.now ?? Date.now();
  let temporaryState;
  try {
    if (fs.existsSync(stateRoot)) {
      const stat = fs.lstatSync(stateRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    } else {
      fs.mkdirSync(stateRoot, { mode: 0o700 });
    }
    if (fs.existsSync(statePath)) {
      const stat = fs.lstatSync(statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return;
      let state;
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { state = null; }
      if (state?.schema === 1 && Number.isFinite(state.checkedAt)
          && state.checkedAt <= now && now - state.checkedAt < DAY) return;
    }
    const xcode = cleanup({ includeOtherProjects: false });
    const temporary = sweep({ dryRun: false });
    const bytes = (Number(xcode.bytesFreed) || 0)
      + (temporary.removed || []).reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    if ((xcode.removed || []).length + (temporary.removed || []).length > 0) {
      log(`✓ OnRamp removed ${formatBytes(bytes)} of abandoned development output; installed emulators, device data, and current build caches were kept.`);
    }
    // Write only a timestamp, using a new exclusive file and atomic replacement.
    // Never follow a user-created state-file symlink.
    const candidateState = path.join(stateRoot, `.storage-maintenance-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(candidateState, JSON.stringify({ schema: 1, checkedAt: now }) + '\n', {
      flag: 'wx', mode: 0o600,
    });
    temporaryState = candidateState;
    fs.renameSync(temporaryState, statePath);
    temporaryState = undefined;
  } catch (_) {
    log('OnRamp automatic storage maintenance was skipped; continuing with native launch.');
  } finally {
    if (temporaryState) {
      try { fs.unlinkSync(temporaryState); } catch (_) { /* optional timestamp only */ }
    }
  }
}

module.exports = { automaticallyMaintainMobileStorage, formatBytes, runStorageCommand };
