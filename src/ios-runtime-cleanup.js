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

async function offerIosRuntimeCleanup(environment, options = {}) {
  const captureFn = options.captureFn || capture;
  const inspect = options.inspectStorage
    || (() => inspectIosRuntimeStorage(environment, captureFn));
  const ask = options.promptYesNo || promptYesNo;
  const log = options.log || console.log;
  const removed = [];
  try {
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
        log(`Xcode has not confirmed removal of iOS ${candidate.version}.`);
        continue;
      }
      removed.push(candidate.identifier);
      log(`✓ Removed older iOS ${candidate.version} runtime; simulator app data was kept.`);
    }
  } catch (_error) {
    // Cleanup is optional. An old Xcode, unreadable inventory, or removal failure
    // must not turn a successful installation into a launch failure.
    log('Could not safely finish iOS runtime cleanup; continuing with installed runtimes.');
  }
  return removed;
}

module.exports = { inspectIosRuntimeStorage, offerIosRuntimeCleanup };
