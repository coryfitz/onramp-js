const fs = require('fs');
const path = require('path');

const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const IOS_BUNDLE_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const NATIVE_VERSION_PATTERN = /^\d+(?:\.\d+){1,2}$/;
const BUILD_NUMBER_PATTERN = /^\d+(?:\.\d+)*$/;
const { resolveEnvironmentProfile } = require('./environment');

function writeJson(filePath, value) {
  return writeIfChanged(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeIfChanged(filePath, content) {
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === content) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function copyIfChanged(source, destination) {
  if (
    fs.existsSync(destination)
    && fs.readFileSync(source).equals(fs.readFileSync(destination))
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function nativeProjectName(value) {
  const parts = String(value || '').match(/[A-Za-z0-9]+/g) || [];
  let name = parts
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join('');

  if (!name) {
    name = 'App';
  }
  if (!/^[A-Za-z]/.test(name)) {
    name = `App${name}`;
  }
  return name;
}

function humanDisplayName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!normalized) return 'App';
  return normalized.replace(/(^|\s)([a-z])/g, (_match, prefix, letter) => (
    `${prefix}${letter.toUpperCase()}`
  ));
}

function defaultNativePackage(nativeName) {
  return `com.${nativeName.toLowerCase()}`;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function validateAndroidPackage(value) {
  const packageName = requireString(value, 'app.json android.package');
  if (!ANDROID_PACKAGE_PATTERN.test(packageName)) {
    throw new Error(
      'app.json android.package must be a reverse-domain identifier such as com.example.app.'
    );
  }
  return packageName;
}

function validateIosBundleIdentifier(value) {
  const bundleIdentifier = requireString(value, 'app.json ios.bundleIdentifier');
  if (!IOS_BUNDLE_PATTERN.test(bundleIdentifier)) {
    throw new Error(
      'app.json ios.bundleIdentifier must be a reverse-domain identifier such as com.example.app.'
    );
  }
  return bundleIdentifier;
}

function validateVersion(value) {
  const version = requireString(value, 'app.json version');
  if (!NATIVE_VERSION_PATTERN.test(version)) {
    throw new Error('app.json version must contain two or three numeric components, such as 1.0.0.');
  }
  return version;
}

function validateVersionCode(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('app.json android.versionCode must be a positive integer.');
  }
  return value;
}

function validateBuildNumber(value) {
  const buildNumber = requireString(String(value), 'app.json ios.buildNumber');
  if (!BUILD_NUMBER_PATTERN.test(buildNumber)) {
    throw new Error('app.json ios.buildNumber must contain only digits and periods.');
  }
  return buildNumber;
}

function projectFile(outputDir, relativePath, label) {
  const root = path.resolve(outputDir);
  const resolved = path.resolve(root, requireString(relativePath, label));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must stay inside the frontend project.`);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist: ${relativePath}`);
  }
  return resolved;
}

function readPngDimensions(filePath) {
  const header = Buffer.alloc(24);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== header.length) {
      throw new Error('the file is too small');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!header.subarray(0, 8).equals(signature) || header.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('the file is not a PNG');
  }
  return {
    width: header.readUInt32BE(16),
    height: header.readUInt32BE(20),
  };
}

function validateIcon(outputDir, relativePath) {
  const iconPath = projectFile(outputDir, relativePath, 'app.json icon');
  let dimensions;
  try {
    dimensions = readPngDimensions(iconPath);
  } catch (error) {
    throw new Error(`app.json icon must be a PNG: ${error.message}`);
  }
  if (dimensions.width !== 1024 || dimensions.height !== 1024) {
    throw new Error(
      `app.json icon must be a 1024x1024 PNG; found ${dimensions.width}x${dimensions.height}.`
    );
  }
  return iconPath;
}

function prepareNativeConfig(outputDir, requestedName, environment = null) {
  const appJsonPath = path.join(outputDir, 'app.json');
  const packagePath = path.join(outputDir, 'package.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const sourceName = requestedName
    || appJson.displayName
    || appJson.name
    || packageJson.name;
  const name = nativeProjectName(sourceName);
  const displayName = humanDisplayName(appJson.displayName || sourceName || name);
  const version = appJson.version === undefined
    ? null
    : validateVersion(appJson.version);
  const icon = appJson.icon === undefined
    ? null
    : validateIcon(outputDir, appJson.icon);
  const androidPackage = appJson.android?.package === undefined
    ? null
    : validateAndroidPackage(appJson.android.package);
  const androidVersionCode = appJson.android?.versionCode === undefined
    ? null
    : validateVersionCode(appJson.android.versionCode);
  const iosBundleIdentifier = appJson.ios?.bundleIdentifier === undefined
    ? null
    : validateIosBundleIdentifier(appJson.ios.bundleIdentifier);
  const iosBuildNumber = appJson.ios?.buildNumber === undefined
    ? null
    : validateBuildNumber(appJson.ios.buildNumber);

  appJson.name = name;
  appJson.displayName = displayName;
  writeJson(appJsonPath, appJson);
  fs.writeFileSync(path.join(outputDir, '.nvmrc'), '22\n', 'utf8');

  const profile = environment
    ? resolveEnvironmentProfile(outputDir, environment, 'ios')
    : { displayNameSuffix: '', identifierSuffix: '' };
  return {
    android: {
      package: androidPackage ? `${androidPackage}${profile.identifierSuffix}` : null,
      versionCode: androidVersionCode,
    },
    displayName: `${displayName}${profile.displayNameSuffix}`,
    icon,
    ios: {
      buildNumber: iosBuildNumber,
      bundleIdentifier: iosBundleIdentifier
        ? `${iosBundleIdentifier}${profile.identifierSuffix}`
        : null,
    },
    name,
    version,
    environment,
  };
}

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Could not update ${label}; the generated native file format was not recognized.`);
  }
  pattern.lastIndex = 0;
  return content.replace(pattern, replacement);
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function walkFiles(directory, callback) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, callback);
    } else if (entry.isFile()) {
      callback(entryPath);
    }
  }
}

function syncAndroidSourcePackage(androidRoot, oldPackage, newPackage) {
  if (!oldPackage || !newPackage || oldPackage === newPackage) return;
  const escaped = oldPackage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const packagePattern = new RegExp(`\\b${escaped}\\b`, 'g');
  for (const sourceRoot of [
    path.join(androidRoot, 'app', 'src', 'main', 'java'),
    path.join(androidRoot, 'app', 'src', 'main', 'kotlin'),
  ]) {
    walkFiles(sourceRoot, filePath => {
      if (!/\.(java|kt)$/.test(filePath)) return;
      const current = fs.readFileSync(filePath, 'utf8');
      const updated = current.replace(packagePattern, newPackage);
      if (updated !== current) fs.writeFileSync(filePath, updated, 'utf8');
    });
  }
}

function copyAndroidIcon(androidRoot, iconPath) {
  const resourceDirectory = path.join(
    androidRoot,
    'app',
    'src',
    'main',
    'res',
    'drawable-nodpi'
  );
  const changed = copyIfChanged(
    iconPath,
    path.join(resourceDirectory, 'onramp_app_icon.png')
  );

  const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  manifest = replaceRequired(
    manifest,
    /android:icon="[^"]+"/,
    'android:icon="@drawable/onramp_app_icon"',
    'the Android launcher icon'
  );
  if (/android:roundIcon="[^"]+"/.test(manifest)) {
    manifest = manifest.replace(
      /android:roundIcon="[^"]+"/,
      'android:roundIcon="@drawable/onramp_app_icon"'
    );
  }
  return writeIfChanged(manifestPath, manifest) || changed;
}

function syncAndroidMetadata(outputDir, config) {
  const androidRoot = path.join(outputDir, 'android');
  if (!fs.existsSync(androidRoot)) return false;
  let changed = false;
  const buildGradlePath = path.join(androidRoot, 'app', 'build.gradle');
  let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
  const namespaceMatch = buildGradle.match(/\bnamespace\s+["']([^"']+)["']/);
  const oldPackage = namespaceMatch?.[1] || null;

  if (config.android.package) {
    buildGradle = replaceRequired(
      buildGradle,
      /(\bnamespace\s+["'])[^"']+(["'])/,
      `$1${config.android.package}$2`,
      'the Android namespace'
    );
    buildGradle = replaceRequired(
      buildGradle,
      /(\bapplicationId\s+["'])[^"']+(["'])/,
      `$1${config.android.package}$2`,
      'the Android application ID'
    );
  }
  if (config.android.versionCode !== null) {
    buildGradle = replaceRequired(
      buildGradle,
      /(\bversionCode\s+)\d+/,
      `$1${config.android.versionCode}`,
      'the Android version code'
    );
  }
  if (config.version) {
    buildGradle = replaceRequired(
      buildGradle,
      /(\bversionName\s+["'])[^"']+(["'])/,
      `$1${config.version}$2`,
      'the Android version name'
    );
  }
  changed = writeIfChanged(buildGradlePath, buildGradle) || changed;
  syncAndroidSourcePackage(androidRoot, oldPackage, config.android.package);

  const settingsPath = path.join(androidRoot, 'settings.gradle');
  let settings = fs.readFileSync(settingsPath, 'utf8');
  settings = replaceRequired(
    settings,
    /(rootProject\.name\s*=\s*['"])[^'"]+(['"])/,
    `$1${config.name}$2`,
    'the Android project name'
  );
  changed = writeIfChanged(settingsPath, settings) || changed;

  const stringsPath = path.join(
    androidRoot,
    'app',
    'src',
    'main',
    'res',
    'values',
    'strings.xml'
  );
  let strings = fs.readFileSync(stringsPath, 'utf8');
  strings = replaceRequired(
    strings,
    /(<string\s+name="app_name">)[\s\S]*?(<\/string>)/,
    `$1${escapeXml(config.displayName)}$2`,
    'the Android display name'
  );
  changed = writeIfChanged(stringsPath, strings) || changed;

  if (config.icon) {
    changed = copyAndroidIcon(androidRoot, config.icon) || changed;
  }
  return changed;
}

function findIosProjectFile(iosRoot, suffix) {
  if (!fs.existsSync(iosRoot)) return null;
  const matches = fs.readdirSync(iosRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'Pods')
    .map(entry => (
      suffix === 'project.pbxproj'
        ? path.join(iosRoot, entry.name, 'project.pbxproj')
        : path.join(iosRoot, entry.name, 'Info.plist')
    ))
    .filter(filePath => fs.existsSync(filePath));
  if (matches.length !== 1) {
    throw new Error(`Expected one iOS ${suffix} file; found ${matches.length}.`);
  }
  return matches[0];
}

function copyIosIcon(iosRoot, config, infoPlistPath) {
  const appRoot = path.dirname(infoPlistPath);
  const appIconSet = path.join(appRoot, 'Images.xcassets', 'AppIcon.appiconset');
  let changed = copyIfChanged(
    config.icon,
    path.join(appIconSet, 'onramp-icon-1024.png')
  );
  changed = writeJson(path.join(appIconSet, 'Contents.json'), {
    images: [{
      filename: 'onramp-icon-1024.png',
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    }],
    info: {
      author: 'onramp',
      version: 1,
    },
  }) || changed;
  return changed;
}

function syncIosMetadata(outputDir, config) {
  const iosRoot = path.join(outputDir, 'ios');
  if (!fs.existsSync(iosRoot)) return false;
  let changed = false;
  const projectPath = findIosProjectFile(iosRoot, 'project.pbxproj');
  const infoPlistPath = findIosProjectFile(iosRoot, 'Info.plist');
  let project = fs.readFileSync(projectPath, 'utf8');

  if (config.ios.bundleIdentifier) {
    project = replaceRequired(
      project,
      /(PRODUCT_BUNDLE_IDENTIFIER\s*=\s*)[^;]+;/g,
      `$1"${config.ios.bundleIdentifier}";`,
      'the iOS bundle identifier'
    );
  }
  if (config.ios.buildNumber) {
    project = replaceRequired(
      project,
      /(CURRENT_PROJECT_VERSION\s*=\s*)[^;]+;/g,
      `$1${config.ios.buildNumber};`,
      'the iOS build number'
    );
  }
  if (config.version) {
    project = replaceRequired(
      project,
      /(MARKETING_VERSION\s*=\s*)[^;]+;/g,
      `$1${config.version};`,
      'the iOS marketing version'
    );
  }
  changed = writeIfChanged(projectPath, project) || changed;

  let infoPlist = fs.readFileSync(infoPlistPath, 'utf8');
  infoPlist = replaceRequired(
    infoPlist,
    /(<key>CFBundleDisplayName<\/key>\s*<string>)[\s\S]*?(<\/string>)/,
    `$1${escapeXml(config.displayName)}$2`,
    'the iOS display name'
  );
  changed = writeIfChanged(infoPlistPath, infoPlist) || changed;

  const launchScreenPath = path.join(path.dirname(infoPlistPath), 'LaunchScreen.storyboard');
  if (fs.existsSync(launchScreenPath)) {
    const launchScreen = fs.readFileSync(launchScreenPath, 'utf8');
    const updatedLaunchScreen = launchScreen.replace(
      /(<label\b[^>]*\btext=")[^"]*("[^>]*\bid="GJd-Yh-RWb"[^>]*>)/,
      `$1${escapeXml(config.displayName)}$2`
    );
    changed = writeIfChanged(launchScreenPath, updatedLaunchScreen) || changed;
  }

  if (config.icon) {
    changed = copyIosIcon(iosRoot, config, infoPlistPath) || changed;
  }
  return changed;
}

function syncNativeProjects(outputDir, config, platforms = ['ios', 'android']) {
  const changed = [];
  if (platforms.includes('android') && syncAndroidMetadata(outputDir, config)) {
    changed.push('android');
  }
  if (platforms.includes('ios') && syncIosMetadata(outputDir, config)) {
    changed.push('ios');
  }
  return changed;
}

module.exports = {
  defaultNativePackage,
  humanDisplayName,
  nativeProjectName,
  prepareNativeConfig,
  readPngDimensions,
  syncAndroidMetadata,
  syncIosMetadata,
  syncNativeProjects,
  validateAndroidPackage,
  validateBuildNumber,
  validateIosBundleIdentifier,
  validateVersion,
  validateVersionCode,
};
