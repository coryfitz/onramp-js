const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { capture } = require('./process');
const { promptYesNo } = require('./prompt');

const IOS_PLATFORM = 'com.apple.platform.iphonesimulator';
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+(?:-\d+)*$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const VERSION = /^\d+(?:\.\d+)*$/;

function olderVersion(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
      || !VERSION.test(left) || !VERSION.test(right)) return false;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) {
      return (a[index] || 0) < (b[index] || 0);
    }
  }
  // Same-version builds can share a runtime identifier. Never prune them.
  return false;
}

function inspectIosRuntimeStorage(environment, captureFn = capture) {
  const query = args => {
    const result = captureFn(environment.xcrun, ['simctl', ...args], {
      env: environment.env,
      check: false,
    });
    if (result.status !== 0) throw new Error('Simulator inventory unavailable');
    return JSON.parse(result.stdout);
  };
  const images = query(['runtime', 'list', '--json']);
  const { runtimes } = query(['list', '--json', 'runtimes']);
  // Include unavailable devices: these can still hold valuable app data.
  const { devices } = query(['list', '--json', 'devices']);
  if (!images || Array.isArray(images) || typeof images !== 'object'
      || !Array.isArray(runtimes) || !devices || Array.isArray(devices)
      || typeof devices !== 'object'
      || Object.values(devices).some(group => !Array.isArray(group))
      || Object.entries(images).some(([id, image]) => (
        !image || typeof image !== 'object' || image.identifier !== id
      ))) {
    throw new Error('Unrecognized Simulator inventory');
  }
  return { images: Object.values(images), runtimes, devices };
}

function verifiedReplacement(storage, replacement, simulatorId) {
  const matches = storage.runtimes.filter(runtime => {
    if (!runtime || runtime.isAvailable !== true || !IOS_RUNTIME.test(runtime.identifier)
        || !VERSION.test(runtime.version)) return false;
    if (replacement) {
      return runtime.identifier === replacement.identifier
        && runtime.version === replacement.version
        && (runtime.buildversion || runtime.buildVersion) === replacement.build;
    }
    return simulatorId && (storage.devices[runtime.identifier] || [])
      .some(device => device && device.udid === simulatorId);
  });
  if (matches.length !== 1) return null;
  const runtime = matches[0];
  const build = runtime.buildversion || runtime.buildVersion;
  if (!build || !storage.images.some(image => (
    image && image.platformIdentifier === IOS_PLATFORM
    && image.runtimeIdentifier === runtime.identifier
    && image.build === build && image.version === runtime.version
    && image.state === 'Ready'
  ))) return null;
  return { identifier: runtime.identifier, version: runtime.version, build };
}

function cleanupCandidates(storage, replacement) {
  return storage.images.filter(image => (
    image && UUID.test(image.identifier)
    && image.platformIdentifier === IOS_PLATFORM
    && IOS_RUNTIME.test(image.runtimeIdentifier)
    && image.runtimeIdentifier !== replacement.identifier
    && image.deletable === true && image.state === 'Ready'
    && typeof image.build === 'string' && image.build.length > 0
    && olderVersion(image.version, replacement.version)
    // simctl deletion would shut down running devices. Only idle images qualify.
    && (storage.devices[image.runtimeIdentifier] || [])
      .every(device => device && device.state === 'Shutdown')
  ));
}

function physicalPath(file, directory = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) {
    return false;
  }
  try {
    let current = path.parse(file).root;
    for (const component of file.slice(current.length).split(path.sep)) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    const stat = fs.lstatSync(file);
    return directory ? stat.isDirectory() : stat.isFile();
  } catch (_error) {
    return false;
  }
}

function warnRetainedRuntimeDownload(image, log) {
  const downloadPath = image.parentImagePath
    || (image.kind === 'Patchable Cryptex Disk Image' ? image.path : null);
  if (physicalPath(downloadPath)) {
    log(`Apple retained the downloaded iOS ${image.version} runtime asset (${downloadPath}); `
      + 'its disk space is not reported as reclaimed.');
  }
}

function safeDevice(device, deviceRoot) {
  if (!device || !UUID.test(device.udid) || device.state !== 'Shutdown'
      || typeof device.isAvailable !== 'boolean'
      || device.dataPath !== path.join(deviceRoot, device.udid, 'data')
      || !physicalPath(device.dataPath, true)) return false;
  try {
    return typeof process.getuid !== 'function'
      || fs.lstatSync(path.dirname(device.dataPath)).uid === process.getuid();
  } catch (_error) {
    return false;
  }
}

function unambiguousStorage(storage) {
  if (!storage || !Array.isArray(storage.images) || !Array.isArray(storage.runtimes)
      || !storage.devices || Array.isArray(storage.devices)
      || typeof storage.devices !== 'object') return false;
  const ids = new Set();
  for (const [runtime, devices] of Object.entries(storage.devices)) {
    if (!runtime || !Array.isArray(devices)) return false;
    for (const device of devices) {
      if (!device || !UUID.test(device.udid) || ids.has(device.udid)
          || typeof device.state !== 'string') return false;
      ids.add(device.udid);
    }
  }
  return storage.runtimes.every(runtime => runtime && typeof runtime.identifier === 'string')
    && new Set(storage.runtimes.map(runtime => runtime.identifier)).size === storage.runtimes.length
    && storage.images.every(image => image && UUID.test(image.identifier)
      && typeof image.runtimeIdentifier === 'string'
      && typeof image.platformIdentifier === 'string'
      && typeof image.state === 'string')
    && new Set(storage.images.map(image => image.identifier)).size === storage.images.length;
}

function obsoleteStorage(storage, replacement, deviceRoot) {
  if (!unambiguousStorage(storage)) return { images: [], devices: [] };
  const images = cleanupCandidates(storage, replacement).filter(image => (
    physicalPath(image.path)
    && storage.images.filter(other => other.runtimeIdentifier === image.runtimeIdentifier).length === 1
    && storage.runtimes.some(runtime => runtime.identifier === image.runtimeIdentifier
      && runtime.version === image.version
      && (runtime.buildversion || runtime.buildVersion) === image.build)
    && (storage.devices[image.runtimeIdentifier] || [])
      .every(device => safeDevice(device, deviceRoot))
  ));
  const olderRuntimeIds = new Set(images.map(image => image.runtimeIdentifier));
  const devices = [];
  for (const [runtime, group] of Object.entries(storage.devices)) {
    if (!IOS_RUNTIME.test(runtime)) continue;
    const version = runtime.slice('com.apple.CoreSimulator.SimRuntime.iOS-'.length).replaceAll('-', '.');
    const absentOlderRuntime = olderVersion(version, replacement.version)
      && !storage.runtimes.some(installed => installed.identifier === runtime)
      && !storage.images.some(image => image.runtimeIdentifier === runtime)
      && group.every(device => device.isAvailable === false && safeDevice(device, deviceRoot));
    if (olderRuntimeIds.has(runtime) || absentOlderRuntime) {
      for (const device of group) devices.push({ ...device, runtime });
    }
  }
  return { images, devices };
}

function removeObsoleteIosStorage(environment, options, inspect, captureFn, log, removed) {
  const deviceRoot = options.deviceRoot
    || path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices');
  const initial = inspect();
  if (!unambiguousStorage(initial)) return removed;
  const replacement = verifiedReplacement(initial, options.replacement, options.simulatorId);
  if (!replacement) return removed;
  const candidates = obsoleteStorage(initial, replacement, deviceRoot);
  if (candidates.images.length === 0 && candidates.devices.length === 0) return removed;
  log('mobile --force: removing verified obsolete iOS runtimes and shutdown simulator devices. '
    + 'Removed devices lose their saved apps and data; current/newer and active simulators are kept.');

  for (const candidate of candidates.devices) {
    const current = inspect();
    if (!unambiguousStorage(current) || !verifiedReplacement(current, replacement)) break;
    const safe = obsoleteStorage(current, replacement, deviceRoot).devices.find(device => (
      device.udid === candidate.udid && device.runtime === candidate.runtime
      && device.dataPath === candidate.dataPath
    ));
    if (!safe) {
      log(`Keeping iOS simulator ${candidate.udid}; its state or storage changed.`);
      continue;
    }
    const result = captureFn(environment.xcrun, ['simctl', 'delete', candidate.udid], {
      env: environment.env, check: false,
    });
    const after = inspect();
    if (result.status !== 0 || !unambiguousStorage(after)) {
      log(`Could not confirm removal of iOS simulator ${candidate.udid}; continuing safely.`);
      continue;
    }
    if (Object.values(after.devices).some(group => group.some(device => device.udid === candidate.udid))) {
      log(`Removal requested for iOS simulator ${candidate.udid}; Xcode still lists it, so completion is pending.`);
      continue;
    }
    removed.push(candidate.udid);
    log(`✓ Removed obsolete iOS simulator ${candidate.name || candidate.udid}, including saved apps and data.`);
  }

  for (const candidate of candidates.images) {
    const current = inspect();
    if (!unambiguousStorage(current) || !verifiedReplacement(current, replacement)) break;
    const safe = obsoleteStorage(current, replacement, deviceRoot).images.find(image => (
      image.identifier === candidate.identifier && image.runtimeIdentifier === candidate.runtimeIdentifier
      && image.version === candidate.version && image.build === candidate.build
      && image.path === candidate.path
    ));
    // Do not remove a runtime if any device was preserved or could not be deleted.
    if (!safe || (current.devices[candidate.runtimeIdentifier] || []).length > 0) continue;
    const result = captureFn(environment.xcrun, ['simctl', 'runtime', 'delete', candidate.identifier], {
      env: environment.env, check: false,
    });
    const after = inspect();
    if (result.status !== 0 || !unambiguousStorage(after)) {
      log(`Could not confirm removal of iOS ${candidate.version}; continuing safely.`);
      continue;
    }
    if (after.images.some(image => image.identifier === candidate.identifier)) {
      log(`Removal requested for iOS ${candidate.version}; Xcode still lists it, so completion is pending.`);
      continue;
    }
    removed.push(candidate.identifier);
    log(`✓ Removed obsolete iOS ${candidate.version} runtime.`);
    warnRetainedRuntimeDownload(candidate, log);
  }
  return removed;
}

async function offerIosRuntimeCleanup(environment, options = {}) {
  const captureFn = options.captureFn || capture;
  const inspect = options.inspectStorage
    || (() => inspectIosRuntimeStorage(environment, captureFn));
  const ask = options.promptYesNo || promptYesNo;
  const log = options.log || console.log;
  const removed = [];
  try {
    // Only coordinated mobile --force supplies this separate destructive option.
    // The ordinary ios --force path still asks and never removes device data.
    if (options.cleanupObsolete === true) {
      return removeObsoleteIosStorage(environment, options, inspect, captureFn, log, removed);
    }
    const storage = inspect();
    const replacement = verifiedReplacement(
      storage, options.replacement, options.simulatorId
    );
    if (!replacement) return removed;
    const candidates = cleanupCandidates(storage, replacement);
    if (candidates.length === 0) return removed;
    const descriptions = candidates.map(image => {
      const size = Number.isFinite(image.sizeBytes) && image.sizeBytes > 0
        ? `, approximately ${(image.sizeBytes / 1024 ** 3).toFixed(1)} GiB`
        : '';
      return `iOS ${image.version} build ${image.build}${size}`;
    });
    const approved = await ask(
      `The replacement iOS ${replacement.version} runtime is installed. `
      + `Remove these older idle runtimes to recover disk space: ${descriptions.join('; ')}? `
      + 'They are shared by all projects and Mac users. Simulator devices and app data will be kept, '
      + 'but those devices will need their runtime downloaded again before use. (y/N): '
    );
    if (!approved) return removed;

    for (const candidate of candidates) {
      // Recheck after user input and each deletion to protect active devices.
      const current = inspect();
      if (!verifiedReplacement(current, replacement)) break;
      const safe = cleanupCandidates(current, replacement).find(image => (
        image.identifier === candidate.identifier
        && image.runtimeIdentifier === candidate.runtimeIdentifier
        && image.version === candidate.version && image.build === candidate.build
      ));
      if (!safe) {
        log(`Keeping iOS ${candidate.version}; its runtime or device state changed.`);
        continue;
      }
      const result = captureFn(environment.xcrun, [
        'simctl', 'runtime', 'delete', candidate.identifier,
      ], { env: environment.env, check: false });
      if (result.status !== 0) {
        log(`Could not remove iOS ${candidate.version}; continuing with the new runtime.`);
        continue;
      }
      if (inspect().images.some(image => image.identifier === candidate.identifier)) {
        log(`Removal requested for iOS ${candidate.version}; Xcode still lists it, so completion is pending.`);
        continue;
      }
      removed.push(candidate.identifier);
      log(`✓ Removed older iOS ${candidate.version} runtime; simulator app data was kept.`);
      warnRetainedRuntimeDownload(candidate, log);
    }
  } catch (_error) {
    // Cleanup is optional. An old Xcode, unreadable inventory, or removal failure
    // must not turn a successful installation into a launch failure.
    log('Could not safely finish iOS runtime cleanup; continuing with installed runtimes.');
  }
  return removed;
}

module.exports = { inspectIosRuntimeStorage, offerIosRuntimeCleanup };
