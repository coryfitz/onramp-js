const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  androidSystemImageDetails,
  compareVersions,
  listAndroidSdkPackages,
  removeAndroidSdkPackages,
} = require('./android-sdk');

function readIni(file) {
  const contents = fs.readFileSync(file, 'utf8');
  const values = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const match = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!match || values.has(match[1].trim())) {
      throw new Error('Ambiguous Android virtual device metadata: ' + file);
    }
    values.set(match[1].trim(), match[2].trim());
  }
  return { contents, values };
}

function avdSearchRoots(env, homedir) {
  const roots = [path.join(homedir, '.android', 'avd')];
  for (const [key, suffix] of [
    ['ANDROID_AVD_HOME', ''],
    ['ANDROID_USER_HOME', 'avd'],
    ['ANDROID_EMULATOR_HOME', 'avd'],
    ['ANDROID_SDK_HOME', '.android/avd'],
    ['HOME', '.android/avd'],
    ['USERPROFILE', '.android/avd'],
  ]) {
    if (!env[key]) {
      continue;
    }
    if (!path.isAbsolute(env[key])) {
      throw new Error('Cannot safely inspect relative ' + key + '.');
    }
    roots.push(path.join(env[key], suffix));
  }
  return [...new Set(roots.map(root => path.resolve(root)))].sort();
}

function resolveImagePath(value, sdk) {
  // Android config paths are literal: guessing expansions could hide a reference.
  if (!value || /[\0\r\n$~]/.test(value)
      || (path.sep !== '\\' && /\\|^[A-Za-z]:/.test(value))) {
    throw new Error('Cannot safely resolve an Android image path.');
  }
  const resolved = path.resolve(sdk, value);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // A broken AVD still owns its configured image. Keep its lexical reference.
    return resolved;
  }
}

function androidAvdImageReferences(sdk, env = process.env, homedir = os.homedir()) {
  const records = [];
  const directories = new Set();
  const references = new Set();
  for (const root of avdSearchRoots(env, homedir)) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A dangling link must not masquerade as an absent AVD root.
        try {
          fs.lstatSync(root);
        } catch (missing) {
          if (missing.code === 'ENOENT') {
            records.push([root, null]);
            continue;
          }
          throw missing;
        }
      }
      throw error;
    }
    records.push([root, entries.map(entry => entry.name).sort()]);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(root, entry.name);
      if (entry.name.endsWith('.avd')) {
        directories.add(file);
      } else if (entry.name.endsWith('.ini')) {
        const { contents, values } = readIni(file);
        records.push([file, contents]);
        const absolute = values.get('path');
        const relative = values.get('path.rel');
        if (!absolute && !relative) {
          throw new Error('Android AVD locator has no device path: ' + file);
        }
        if (absolute) {
          if (!path.isAbsolute(absolute)) {
            throw new Error('Android AVD locator path is ambiguous: ' + file);
          }
          directories.add(absolute);
        }
        if (relative) {
          if (path.isAbsolute(relative)) {
            throw new Error('Android AVD relative locator is ambiguous: ' + file);
          }
          // Inspect both locator paths, even if the preferred one is broken.
          directories.add(path.resolve(path.dirname(root), relative));
        }
      }
    }
  }
  for (const directory of [...directories].sort()) {
    const file = path.join(directory, 'config.ini');
    const { contents, values } = readIni(file);
    records.push([fs.realpathSync(directory), contents]);
    if (!values.get('image.sysdir.1')) {
      throw new Error('Android AVD has no readable system image reference: ' + file);
    }
    for (const [key, value] of values) {
      if (/^image\.sysdir\.\d+$/.test(key)) {
        references.add(resolveImagePath(value, sdk));
      } else if (value && /(?:path|file)$/i.test(key)) {
        // Explicit system/ramdisk overrides can reference a second image.
        references.add(resolveImagePath(value, sdk));
        references.add(resolveImagePath(value, directory));
      }
    }
  }
  return {
    fingerprint: JSON.stringify(records),
    references,
  };
}

function imageSnapshot(sdk, packageInfo) {
  if (!packageInfo || !/^\d+(?:\.\d+)*$/.test(packageInfo.installedVersion || '')) {
    return null;
  }
  const details = androidSystemImageDetails(packageInfo);
  if (!details || !/^\w[\w.-]*$/.test(details.tag)
      || !/^\w[\w.-]*$/.test(details.architecture)) {
    return null;
  }
  const directory = path.join(sdk, ...packageInfo.path.split(';'));
  if (fs.realpathSync(directory) !== directory) {
    return null;
  }
  const systemImage = fs.statSync(path.join(directory, 'system.img'));
  if (!systemImage.isFile() || !systemImage.size) {
    return null;
  }
  const files = [];
  let bytes = 0;
  function visit(current) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error('Cannot safely inspect linked Android system image.');
    }
    files.push([
      path.relative(directory, current), stat.dev, stat.ino,
      stat.size, stat.mtimeMs, stat.ctimeMs,
    ]);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name));
      }
    } else {
      bytes += stat.blocks === undefined ? stat.size : stat.blocks * 512;
    }
  }
  visit(directory);
  for (const file of ['source.properties', 'package.xml']) {
    const metadata = path.join(directory, file);
    if (!fs.existsSync(metadata)) {
      continue;
    }
    const contents = fs.readFileSync(metadata, 'utf8');
    const codename = contents.match(/AndroidVersion\.Code[nN]ame\s*=\s*(\S+)/)
      || contents.match(/<codename>\s*([^<]+)\s*<\/codename>/);
    if ((codename && codename[1].trim() !== 'REL')
        || /<preview>\s*[1-9]\d*\s*<\/preview>/.test(contents)) {
      return null;
    }
  }
  return {
    ...details,
    bytes,
    directory,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify([
      packageInfo.installedVersion, files,
    ])).digest('hex'),
  };
}

function referencedImage(image, references) {
  return [...references].some(reference => (
    reference === image.directory
    || reference.startsWith(image.directory + path.sep)
    // A reference to the containing directory is ambiguous; preserve it too.
    || image.directory.startsWith(reference + path.sep)
  ));
}

async function cleanupSupersededAndroidSystemImages({
  sdkManager,
  sdk,
  env = process.env,
  replacementPackagePath,
  packages,
  promptYesNo,
  listPackagesFn = listAndroidSdkPackages,
  removePackagesFn = removeAndroidSdkPackages,
  log = console.log,
  homedir = os.homedir(),
}) {
  const removed = [];
  try {
    sdk = fs.realpathSync(sdk);
    packages = packages || await listPackagesFn(sdkManager, sdk, env);
    const replacement = imageSnapshot(sdk, packages.get(replacementPackagePath));
    if (!replacement) {
      return removed;
    }
    const inventory = androidAvdImageReferences(sdk, env, homedir);
    const candidates = [];
    for (const packageInfo of packages.values()) {
      const details = androidSystemImageDetails(packageInfo);
      if (!details || !packageInfo.installedVersion
          || details.tag !== replacement.tag
          || details.architecture !== replacement.architecture
          || compareVersions(details.api, replacement.api) >= 0) {
        continue;
      }
      try {
        const candidate = imageSnapshot(sdk, packageInfo);
        if (candidate && !referencedImage(candidate, inventory.references)) {
          candidates.push(candidate);
        }
      } catch (_error) {
        // An incomplete or unreadable installation is not safe to remove.
      }
    }
    if (!candidates.length || typeof promptYesNo !== 'function') {
      return removed;
    }
    candidates.sort((left, right) => (
      left.packageInfo.path.localeCompare(right.packageInfo.path)
    ));
    const gigabytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0)
      / 1024 ** 3;
    const approved = await promptYesNo(
      'The replacement Android system image is installed. Remove these older '
      + 'system images, which no discovered virtual device references, from '
      + 'the shared SDK at ' + sdk + '? This may free about '
      + gigabytes.toFixed(1) + ' GiB.\n'
      + candidates.map(candidate => '  ' + candidate.packageInfo.path).join('\n')
      + '\nVirtual devices and their app data will be preserved. (y/N): '
    );
    if (!approved) {
      return removed;
    }
    for (const candidate of candidates) {
      // Consent can stay open while Android Studio creates a device or updates
      // an image. Reinspect each time, immediately before invoking SDK removal.
      const currentPackages = await listPackagesFn(sdkManager, sdk, env);
      const currentReplacement = imageSnapshot(
        sdk, currentPackages.get(replacementPackagePath)
      );
      const currentCandidate = imageSnapshot(
        sdk, currentPackages.get(candidate.packageInfo.path)
      );
      const currentInventory = androidAvdImageReferences(sdk, env, homedir);
      if (!currentReplacement || !currentCandidate
          || currentReplacement.fingerprint !== replacement.fingerprint
          || currentCandidate.fingerprint !== candidate.fingerprint
          || currentInventory.fingerprint !== inventory.fingerprint
          || referencedImage(currentCandidate, currentInventory.references)) {
        log('Android image cleanup skipped because the installed images or '
          + 'virtual devices changed.');
        break;
      }
      const result = await removePackagesFn(
        sdkManager, sdk, env, [candidate.packageInfo.path]
      );
      if (result && result.status !== undefined && result.status !== 0) {
        throw new Error('Android SDK removal failed for ' + candidate.packageInfo.path + '.');
      }
      const remainingPackages = await listPackagesFn(sdkManager, sdk, env);
      let directoryRemains = true;
      try {
        fs.lstatSync(candidate.directory);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        directoryRemains = false;
      }
      if (remainingPackages.get(candidate.packageInfo.path)?.installedVersion
          || directoryRemains) {
        throw new Error('Android SDK removal did not confirm that '
          + candidate.packageInfo.path + ' was removed.');
      }
      removed.push(candidate.packageInfo.path);
    }
    if (removed.length) {
      log('Removed ' + removed.length + ' unused older Android system image'
        + (removed.length === 1 ? '.' : 's.'));
    }
  } catch (error) {
    log('Android image cleanup skipped: ' + error.message);
  }
  return removed;
}

module.exports = {
  androidAvdImageReferences,
  cleanupSupersededAndroidSystemImages,
};
