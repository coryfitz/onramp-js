const fs = require('fs');
const path = require('path');
const { addNativePlatforms } = require('./native');
const { writeFrontendManifest } = require('./project');
const { isPythonWrapper, run } = require('./process');
const onrampPackageJson = require('../package.json');

function npmInstallArgs(pythonWrapper = false) {
  const args = ['install', '--legacy-peer-deps'];
  if (pythonWrapper) {
    args.push('--no-audit', '--no-fund', '--loglevel=error');
  }
  return args;
}

function npmPackageName(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'app';
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function prepareOutputDirectory(outputDir) {
  const existed = fs.existsSync(outputDir);
  if (fs.existsSync(outputDir)) {
    const entries = fs.readdirSync(outputDir);
    if (entries.length > 0) {
      throw new Error(`Output directory is not empty: ${outputDir}`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
  return existed;
}

function renderProjectMetadata(outputDir, appName) {
  const packagePath = path.join(outputDir, 'package.json');
  const appJsonPath = path.join(outputDir, 'app.json');
  const readmePath = path.join(outputDir, 'README.md');

  const projectPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  projectPackage.name = npmPackageName(appName);
  projectPackage.devDependencies['onramp-js'] = (
    process.env.ONRAMP_JS_PACKAGE_SPEC || onrampPackageJson.version
  );
  writeJson(packagePath, projectPackage);

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.name = appName;
  appJson.displayName = appName;
  writeJson(appJsonPath, appJson);

  const readme = fs
    .readFileSync(readmePath, 'utf8')
    .replaceAll('__ONRAMP_APP_NAME__', appName);
  fs.writeFileSync(readmePath, readme, 'utf8');
}

function nextCommands(
  outputDir,
  platform,
  pythonWrapper = false,
  projectRootOverride = null
) {
  if (pythonWrapper) {
    const projectRoot = projectRootOverride || path.dirname(outputDir);
    return [
      `cd ${projectRoot}`,
      'onramp run      # Start web development',
      'onramp ios      # Add, build, and launch iOS',
      'onramp android  # Add, build, and launch Android',
      'onramp mobile   # Add, build, and launch iOS + Android',
      'onramp doctor ios',
    ];
  }

  const commands = [
    `cd ${outputDir}`,
    'npm run start:native  # Start native development (Metro)',
    'npx onramp-js run web      # Start web development (Webpack)',
    'npx onramp-js run android  # Run Android app',
    'npx onramp-js run ios      # Run iOS app',
    'npx onramp-js run mobile   # Run iOS and Android apps',
    'npx onramp-js upgrade --check  # Check framework tooling updates',
  ];
  if (platform === 'web') {
    commands.push(
      'npx onramp-js add ios',
      'npx onramp-js add android',
      'npx onramp-js add mobile'
    );
  }
  return commands;
}

async function createApp({ name, output, platform = 'web' }) {
  const outputDir = path.resolve(output);
  const templatesDir = path.resolve(__dirname, '..', 'templates');

  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Frontend templates not found: ${templatesDir}`);
  }

  prepareOutputDirectory(outputDir);
  try {
    console.log('Creating OnRamp frontend with file-based navigation...');
    fs.cpSync(templatesDir, outputDir, { recursive: true });
    fs.mkdirSync(path.join(outputDir, 'src', 'generated'), { recursive: true });
    fs.copyFileSync(
      path.join(outputDir, 'assets', 'logo.png'),
      path.join(outputDir, 'logo.png')
    );
    renderProjectMetadata(outputDir, name);

    const pythonWrapper = isPythonWrapper();
    console.log('Installing frontend dependencies...');
    run(
      'npm',
      npmInstallArgs(pythonWrapper),
      outputDir,
      process.env,
      { quiet: pythonWrapper }
    );
    console.log('✓ Frontend dependencies installed');
    run(process.execPath, ['scripts/build-routes.js'], outputDir);
    writeFrontendManifest(outputDir);

    if (platform === 'mobile' || platform === 'all') {
      await addNativePlatforms({ platform, name, output: outputDir });
    }
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    console.error(`Frontend generation failed; removed incomplete output at ${outputDir}.`);
    throw error;
  }

  console.log('\nOnRamp frontend created!');
  console.log('\nCommands:');
  const commands = nextCommands(
    outputDir,
    platform,
    process.env.ONRAMP_PYTHON_WRAPPER === '1',
    process.env.ONRAMP_PROJECT_ROOT
  );
  for (const command of commands) {
    console.log(`  ${command}`);
  }
}

module.exports = {
  createApp,
  nextCommands,
  npmInstallArgs,
  npmPackageName,
};
