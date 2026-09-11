const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DAY = 24 * 60 * 60 * 1000;
const CACHE_NAME = /^[A-Za-z0-9_.-]+-[a-z]{28}$/;
const BUILD_PROCESS = /^(?:Xcode|xcodebuild|XCBBuildService|clang(?:\+\+)?(?:-\d+)?|swift(?:c|-frontend)?|java|gradle(?:w)?|cmake|ninja|make)$/i;

function readProcesses() {
  return execFileSync('/bin/ps', ['-axo', 'comm='], {
    encoding: 'utf8', timeout: 1500, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\n').map(value => value.trim()).filter(Boolean);
}

function readPlist(file) {
  // Xcode metadata contains dates that plutil cannot represent as JSON. Extract
  // only the string needed for ownership, never deserialize arbitrary objects.
  const WorkspacePath = execFileSync('/usr/bin/plutil', ['-extract', 'WorkspacePath', 'raw', '-o', '-', file], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return { WorkspacePath };
}

function configuration(options) {
  const disk = options.fs || fs;
  const root = path.resolve(options.derivedDataRoot
    || path.join(os.homedir(), 'Library/Developer/Xcode/DerivedData'));
  const currentWorkspacePath = options.currentWorkspacePath
    ? path.resolve(options.currentWorkspacePath) : null;
  return {
    ...options,
    fs: disk,
    root,
    currentWorkspacePath,
    platform: options.platform || process.platform,
    now: Number(options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now()),
    // Callers cannot weaken the automatic seven-day grace period.
    minAge: Math.max(7, Number(options.minAgeDays) || 7) * DAY,
    processReader: options.processReader || readProcesses,
    plistReader: options.plistReader || readPlist,
    temporaryRoots: options.temporaryRoots || [os.tmpdir(), '/tmp', '/private/tmp'],
    maxCandidates: Math.max(1, Math.min(100, options.maxCandidates || 50)),
    maxEntries: Math.max(1, Math.min(1000000, options.maxEntries || 100000)),
    timeBudgetMs: Math.max(1, Math.min(30000, options.timeBudgetMs || 2500)),
    clock: options.clock || Date.now,
  };
}

function buildActivity(config) {
  try {
    const processes = config.processReader();
    if (!Array.isArray(processes) || processes.length === 0
        || processes.some(value => typeof value !== 'string' || !value.trim())) {
      return 'Build-process inventory is unavailable.';
    }
    if (processes.some(value => BUILD_PROCESS.test(path.basename(value.trim())))) {
      return 'A native build tool or Xcode is running.';
    }
    return null;
  } catch (_) {
    return 'Build-process inventory is unavailable.';
  }
}

function ordinaryDirectory(config, directory) {
  const stat = config.fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || config.fs.realpathSync(directory) !== directory) {
    throw new Error('Directory is not an ordinary canonical directory.');
  }
  return stat;
}

function workspaceMissing(config, workspace) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)
      || path.normalize(workspace) !== workspace || workspace.includes('\0')
      || !/\.(?:xcworkspace|xcodeproj)$/.test(workspace)) return false;
  if (workspace === config.currentWorkspacePath) return false;
  try {
    config.fs.lstatSync(workspace);
    return false;
  } catch (error) {
    // Permission errors, broken links, and non-directory components are not
    // evidence that a project was deleted.
    if (error.code !== 'ENOENT') return false;
  }
  // ENOENT may also mean an ancestor is a broken symlink. Only a genuinely
  // absent path beneath a normal, resolvable directory is an abandoned project.
  let ancestor = path.dirname(workspace);
  while (ancestor !== path.dirname(ancestor)) {
    try {
      const stat = config.fs.lstatSync(ancestor);
      const canonical = config.fs.realpathSync(ancestor);
      const expected = canonicalTemporaryPath(config, ancestor);
      return stat.isDirectory() && !stat.isSymbolicLink() && canonical === expected
        || config.temporaryRoots.some(root => path.resolve(root) === ancestor)
          && config.fs.statSync(ancestor).isDirectory() && canonical === expected;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
      // An existing dangling symlink is not a missing project ancestor.
      try { if (config.fs.lstatSync(ancestor).isSymbolicLink()) return false; } catch (_) {}
      ancestor = path.dirname(ancestor);
    }
  }
  return false;
}

function canonicalTemporaryPath(config, value) {
  for (const root of config.temporaryRoots) {
    const absolute = path.resolve(root);
    if (value === absolute || value.startsWith(`${absolute}${path.sep}`)) {
      return path.join(config.fs.realpathSync(absolute), path.relative(absolute, value));
    }
  }
  return value;
}

function isTemporaryWorkspace(config, workspace) {
  for (const value of config.temporaryRoots) {
    try {
      const supplied = path.resolve(value);
      const canonical = config.fs.realpathSync(supplied);
      ordinaryDirectory(config, canonical);
      for (const prefix of new Set([supplied, canonical])) {
        const relative = path.relative(prefix, workspace);
        const parts = relative.split(path.sep);
        if (parts.length >= 2 && /^onramp-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parts[0])
            && !parts.includes('..') && !path.isAbsolute(relative)) return true;
      }
    } catch (_) {
      // An unresolvable temporary root never grants cleanup permission.
    }
  }
  return false;
}

function inspectTree(config, directory, budget) {
  let modifiedAt = 0;
  let bytes = 0;
  let measured = true;
  const inodes = new Set();
  const pending = [directory];
  while (pending.length) {
    if (++budget.entries > config.maxEntries || config.clock() > budget.deadline) {
      throw new Error('Inspection limit reached.');
    }
    const current = pending.pop();
    const stat = config.fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('Cache contains a symbolic link or special file.');
    }
    modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
    // Allocated blocks match du's disk-use meaning, including sparse files;
    // logical file sizes would significantly overstate simulator/build usage.
    const inode = `${stat.dev}:${stat.ino}`;
    if (!inodes.has(inode)) {
      inodes.add(inode);
      if (Number.isFinite(stat.blocks)) bytes += stat.blocks * 512;
      else measured = false;
    }
    if (stat.isDirectory()) {
      const names = config.fs.readdirSync(current);
      if (names.length + budget.entries > config.maxEntries) {
        throw new Error('Inspection limit reached.');
      }
      for (const name of names) pending.push(path.join(current, name));
    }
  }
  return { bytes: measured ? bytes : null, modifiedAt };
}

function inspectCandidate(config, name, budget) {
  if (!CACHE_NAME.test(name)) return null;
  const directory = path.join(config.root, name);
  const identity = ordinaryDirectory(config, directory);
  if (directory === config.currentDerivedDataPath) return null;
  for (const name of ['Build', 'Index.noindex', 'Logs']) {
    ordinaryDirectory(config, path.join(directory, name));
  }
  const infoPath = path.join(directory, 'info.plist');
  const info = config.fs.lstatSync(infoPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) return null;
  const plist = config.plistReader(infoPath);
  if (!plist || !workspaceMissing(config, plist.WorkspacePath)) return null;
  const workspacePath = plist.WorkspacePath;
  const temporaryWorkspace = isTemporaryWorkspace(config, workspacePath);
  const tree = inspectTree(config, directory, budget);
  const oldEnough = Number.isFinite(config.now) && Number.isFinite(tree.modifiedAt)
    && config.now - tree.modifiedAt >= config.minAge;
  const eligible = oldEnough && (temporaryWorkspace || config.includeOtherProjects === true);
  return {
    path: directory,
    workspacePath,
    temporaryWorkspace,
    eligible,
    reason: !oldEnough ? 'Modified within the seven-day safety window.'
      : !eligible ? 'Other deleted project: explicit cleanup approval is required.' : null,
    ...tree,
    // Identity is checked again after inspection and immediately before removal.
    identity: { dev: identity.dev, ino: identity.ino },
  };
}

function inspectXcodeBuildStorage(options = {}) {
  const config = configuration(options);
  const result = {
    supported: config.platform === 'darwin', root: config.root,
    candidates: [], skipped: [], blockedReason: null, truncated: false,
  };
  if (!result.supported) return result;
  try {
    if (path.basename(config.root) !== 'DerivedData') {
      throw new Error('Not an Xcode DerivedData directory.');
    }
    ordinaryDirectory(config, config.root);
    result.blockedReason = buildActivity(config);
    const budget = { entries: 0, deadline: config.clock() + config.timeBudgetMs };
    const names = config.fs.readdirSync(config.root).sort();
    for (const name of names) {
      if (!CACHE_NAME.test(name)) continue;
      if (result.candidates.length >= config.maxCandidates
          || config.clock() > budget.deadline || budget.entries >= config.maxEntries) {
        result.truncated = true;
        break;
      }
      try {
        const candidate = inspectCandidate(config, name, budget);
        if (candidate) {
          if (result.blockedReason) {
            candidate.eligible = false;
            candidate.reason = result.blockedReason;
          }
          result.candidates.push(candidate);
        }
      } catch (error) {
        const reason = error.message === 'Inspection limit reached.'
          ? error.message : 'Cache shape or file inventory could not be safely verified.';
        result.skipped.push({ path: path.join(config.root, name), reason });
        if (reason === 'Inspection limit reached.') {
          result.truncated = true;
          break;
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') result.blockedReason = 'Xcode build storage could not be safely inspected.';
  }
  return result;
}

function cleanupAbandonedXcodeBuilds(options = {}) {
  const config = configuration(options);
  const result = { removed: [], skipped: [], bytesFreed: 0, blockedReason: null };
  const report = inspectXcodeBuildStorage(options);
  result.blockedReason = report.blockedReason;
  result.skipped.push(...report.skipped);
  if (!report.supported || report.blockedReason) return result;
  for (const candidate of report.candidates) {
    if (!candidate.eligible) {
      result.skipped.push({ path: candidate.path, reason: candidate.reason });
      continue;
    }
    try {
      const active = buildActivity(config);
      if (active) {
        result.blockedReason = active;
        break;
      }
      ordinaryDirectory(config, config.root);
      const current = inspectCandidate(config, path.basename(candidate.path), {
        entries: 0, deadline: config.clock() + config.timeBudgetMs,
      });
      if (!current || !current.eligible || current.workspacePath !== candidate.workspacePath
          || current.identity.dev !== candidate.identity.dev
          || current.identity.ino !== candidate.identity.ino) {
        result.skipped.push({ path: candidate.path, reason: 'Cache or workspace changed during inspection.' });
        continue;
      }
      const activity = buildActivity(config);
      if (activity) {
        result.blockedReason = activity;
        break;
      }
      ordinaryDirectory(config, config.root);
      const recheck = ordinaryDirectory(config, current.path);
      if (!recheck.isDirectory() || recheck.isSymbolicLink()
          || recheck.dev !== current.identity.dev || recheck.ino !== current.identity.ino
          || !workspaceMissing(config, current.workspacePath)) {
        result.skipped.push({ path: candidate.path, reason: 'Cache or workspace changed before removal.' });
        continue;
      }
      // The only recursive mutation: one revalidated, direct DerivedData child.
      // Never prune shared caches, projects, SDKs, devices, runtimes, or Pods.
      config.fs.rmSync(current.path, { recursive: true, force: false });
      result.removed.push(current);
      result.bytesFreed += current.bytes || 0;
      if (typeof config.log === 'function') {
        config.log(`Removed abandoned Xcode build cache: ${path.basename(current.path)}`);
      }
    } catch (_) {
      result.skipped.push({ path: candidate.path, reason: 'Cleanup could not safely complete.' });
    }
  }
  return result;
}

module.exports = { inspectXcodeBuildStorage, cleanupAbandonedXcodeBuilds };
