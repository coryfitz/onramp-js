const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  nativeProjectName,
  prepareNativeConfig,
  syncNativeProjects,
} = require('./native-config');
const { run } = require('./process');

const REACT_NATIVE_VERSION = '0.81.1';
const REACT_NATIVE_CLI_VERSION = '20.0.2';
const CLI_DEPENDENCIES = {
  '@react-native-community/cli': '^20.0.2',
  '@react-native-community/cli-platform-ios': '^20.0.2',
  '@react-native-community/cli-platform-android': '^20.0.2',
};

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function platformDirectories(platform) {
  if (platform === 'ios' || platform === 'android') {
    return [platform];
  }
  if (platform === 'mobile' || platform === 'all') {
    return ['ios', 'android'];
  }
  throw new Error('Platform must be ios, android, mobile, or all.');
}

function ensureNativeCliDependencies(outputDir) {
  const packagePath = path.join(outputDir, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.devDependencies = packageJson.devDependencies || {};

  let changed = false;
  for (const [dependency, version] of Object.entries(CLI_DEPENDENCIES)) {
    if (!packageJson.devDependencies[dependency]) {
      packageJson.devDependencies[dependency] = version;
      changed = true;
    }
  }

  if (changed) {
    writeJson(packagePath, packageJson);
  }

  if (changed || !fs.existsSync(path.join(outputDir, 'node_modules'))) {
    console.log('Installing frontend dependencies...');
    run('npm', ['install', '--legacy-peer-deps'], outputDir);
  }
}

async function addNativePlatforms({ platform, name, output }) {
  const outputDir = path.resolve(output || process.cwd());
  const packagePath = path.join(outputDir, 'package.json');
  const appJsonPath = path.join(outputDir, 'app.json');

  if (!fs.existsSync(packagePath) || !fs.existsSync(appJsonPath)) {
    throw new Error(`No OnRamp frontend found at ${outputDir}`);
  }

  const directories = platformDirectories(platform);
  ensureNativeCliDependencies(outputDir);
  const nativeConfig = prepareNativeConfig(outputDir, name);
  const nativeName = nativeConfig.name;
  const missing = directories.filter(
    directory => !fs.existsSync(path.join(outputDir, directory))
  );

  if (missing.length === 0) {
    console.log(`${directories.join(' and ')} already prepared.`);
    const synchronized = syncNativeProjects(outputDir, nativeConfig, directories);
    for (const directory of synchronized) {
      console.log(`✓ ${directory} identity and launcher assets synchronized`);
    }
    return { nativeConfig, nativeName, added: [] };
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-js-'));
  const temporaryProject = path.join(temporaryRoot, 'project');

  try {
    const packageName = directories.length === 1 && directories[0] === 'ios'
      ? nativeConfig.ios.bundleIdentifier
      : nativeConfig.android.package || nativeConfig.ios.bundleIdentifier;
    const initArguments = [
      '--yes',
      `@react-native-community/cli@${REACT_NATIVE_CLI_VERSION}`,
      'init',
      nativeName,
      '--version',
      REACT_NATIVE_VERSION,
      '--directory',
      temporaryProject,
      '--skip-install',
      '--skip-git-init',
      '--title',
      nativeConfig.displayName,
    ];
    if (packageName) {
      initArguments.push('--package-name', packageName);
    }
    run(
      'npx',
      initArguments,
      outputDir
    );

    for (const directory of missing) {
      fs.cpSync(
        path.join(temporaryProject, directory),
        path.join(outputDir, directory),
        { recursive: true }
      );
      console.log(`✓ ${directory} project added (${nativeName})`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const synchronized = syncNativeProjects(outputDir, nativeConfig, directories);
  for (const directory of synchronized) {
    console.log(`✓ ${directory} identity and launcher assets synchronized`);
  }

  return { nativeConfig, nativeName, added: missing };
}

module.exports = {
  addNativePlatforms,
  nativeProjectName,
};
