const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { addNativePlatforms } = require('./native');

function npmPackageName(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'app';
}

function run(command, args, cwd) {
  console.log(`Running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function prepareOutputDirectory(outputDir) {
  if (fs.existsSync(outputDir)) {
    const entries = fs.readdirSync(outputDir);
    if (entries.length > 0) {
      throw new Error(`Output directory is not empty: ${outputDir}`);
    }
  }

  fs.mkdirSync(outputDir, { recursive: true });
}

function renderProjectMetadata(outputDir, appName) {
  const packagePath = path.join(outputDir, 'package.json');
  const appJsonPath = path.join(outputDir, 'app.json');
  const readmePath = path.join(outputDir, 'README.md');

  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.name = npmPackageName(appName);
  writeJson(packagePath, packageJson);

  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.name = appName;
  appJson.displayName = appName;
  writeJson(appJsonPath, appJson);

  const readme = fs
    .readFileSync(readmePath, 'utf8')
    .replaceAll('__ONRAMP_APP_NAME__', appName);
  fs.writeFileSync(readmePath, readme, 'utf8');
}

async function createApp({ name, output, platform = 'web' }) {
  const outputDir = path.resolve(output);
  const templatesDir = path.resolve(__dirname, '..', 'templates');

  if (!fs.existsSync(templatesDir)) {
    throw new Error(`Frontend templates not found: ${templatesDir}`);
  }

  prepareOutputDirectory(outputDir);

  console.log('Creating OnRamp frontend with file-based navigation...');
  fs.cpSync(templatesDir, outputDir, { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'src', 'generated'), { recursive: true });
  fs.copyFileSync(
    path.join(outputDir, 'assets', 'logo.png'),
    path.join(outputDir, 'logo.png')
  );
  renderProjectMetadata(outputDir, name);

  try {
    run('npm', ['install', '--legacy-peer-deps'], outputDir);
  } catch (error) {
    console.error('Installation failed. Run this command manually:');
    console.error(`  cd ${outputDir} && npm install --legacy-peer-deps`);
    throw error;
  }

  try {
    run(process.execPath, ['scripts/build-routes.js'], outputDir);
  } catch (error) {
    console.warn('Could not generate the initial routes.');
    throw error;
  }

  if (platform === 'mobile' || platform === 'all') {
    await addNativePlatforms({ platform, name, output: outputDir });
  }

  console.log('\nOnRamp frontend created!');
  console.log('\nCommands:');
  console.log(`  cd ${outputDir}`);
  console.log('  npm run start:native  # Start native development (Metro)');
  console.log('  npm run start:web     # Start web development (Webpack)');
  console.log('  npm run android       # Run Android app');
  console.log('  npm run ios           # Run iOS app');
  if (platform === 'web') {
    console.log('\nAdd native platforms later:');
    console.log('  npx onramp-js add ios');
    console.log('  npx onramp-js add android');
    console.log('  npx onramp-js add mobile');
  }
}

module.exports = {
  createApp,
  npmPackageName,
};
