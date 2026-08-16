const fs = require('fs');
const os = require('os');
const path = require('path');
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

function syncNativeMetadata(outputDir, requestedName) {
  const appJsonPath = path.join(outputDir, 'app.json');
  const packagePath = path.join(outputDir, 'package.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const sourceName = requestedName
    || appJson.displayName
    || appJson.name
    || packageJson.name;
  const name = nativeProjectName(sourceName);

  appJson.name = name;
  appJson.displayName = appJson.displayName || sourceName || name;
  writeJson(appJsonPath, appJson);
  fs.writeFileSync(path.join(outputDir, '.nvmrc'), '20\n', 'utf8');
  return name;
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
  const nativeName = syncNativeMetadata(outputDir, name);
  const missing = directories.filter(
    directory => !fs.existsSync(path.join(outputDir, directory))
  );

  if (missing.length === 0) {
    console.log(`${directories.join(' and ')} already prepared.`);
    return { nativeName, added: [] };
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-js-'));
  const temporaryProject = path.join(temporaryRoot, 'project');

  try {
    run(
      'npx',
      [
        '--yes',
        `@react-native-community/cli@${REACT_NATIVE_CLI_VERSION}`,
        'init',
        nativeName,
        '--version',
        REACT_NATIVE_VERSION,
        '--directory',
        temporaryProject,
        '--skip-install',
      ],
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

  return { nativeName, added: missing };
}

module.exports = {
  addNativePlatforms,
  nativeProjectName,
};
