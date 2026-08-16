const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { addNativePlatforms } = require('./native');
const { startMetro, warmMetroBundle } = require('./metro');
const { capture, findExecutable, run } = require('./process');

function requireDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('iOS development requires macOS.');
  }
}

function xcodeVersion(xcodebuild) {
  const result = capture(xcodebuild, ['-version']);
  const firstLine = result.stdout.split(/\r?\n/)[0] || '';
  const match = firstLine.match(/^Xcode\s+([0-9]+(?:\.[0-9]+)?)/);
  return {
    display: firstLine || 'Xcode',
    number: match ? Number(match[1]) : 0,
  };
}

function doctorIos() {
  requireDarwin();
  const env = { ...process.env };
  const xcodebuild = findExecutable('xcodebuild', env);
  const xcrun = findExecutable('xcrun', env);
  const pod = findExecutable('pod', env);

  if (!xcodebuild || !xcrun) {
    throw new Error('Xcode command-line tools were not found. Install Xcode, then try again.');
  }
  if (!pod) {
    throw new Error('CocoaPods not found. Install it with `brew install cocoapods`, then try again.');
  }

  const version = xcodeVersion(xcodebuild);
  console.log(`Found ${version.display}`);
  capture(xcodebuild, ['-showsdks'], { env });
  console.log(`Using CocoaPods ${capture(pod, ['--version'], { env }).stdout.trim()}`);
  console.log('✓ iOS environment is ready');
  return { env, pod, version, xcodebuild, xcrun };
}

async function promptYesNo(question) {
  if (!process.stdin.isTTY) {
    return false;
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(question);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
}

function ensureXcodeComponents(environment, iosDir) {
  console.log('Checking if Xcode components are properly installed...');
  const result = capture(environment.xcodebuild, ['-list'], {
    cwd: iosDir,
    env: environment.env,
    check: false,
  });
  if (result.status === 0) {
    console.log('Xcode components are working properly');
    return;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('DVTDownloads.framework') && !output.includes('IDESimulatorFoundation')) {
    console.log('Xcode component check returned an error; continuing with iOS setup.');
    return;
  }

  console.log('Detected missing Xcode framework components.');
  console.log('Running Xcode first-launch setup...');
  run(
    'sudo',
    [environment.xcodebuild, '-runFirstLaunch'],
    iosDir,
    environment.env
  );
  console.log('✓ Xcode components installed');
}

function appleClangMajor(environment) {
  try {
    const result = capture(environment.xcrun, ['clang', '--version'], {
      env: environment.env,
    });
    const match = result.stdout.match(/Apple clang version (\d+)/);
    return match ? Number(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

function applyFmtAppleClangWorkaround(iosDir, environment) {
  const clangMajor = appleClangMajor(environment);
  if (clangMajor === null || clangMajor < 21) {
    return;
  }

  const fmtBase = path.join(iosDir, 'Pods', 'fmt', 'include', 'fmt', 'base.h');
  if (!fs.existsSync(fmtBase)) {
    return;
  }

  const content = fs.readFileSync(fmtBase, 'utf8');
  if (!content.includes('#define FMT_VERSION 110002')) {
    return;
  }

  const oldBranch = [
    '#elif defined(__apple_build_version__) && __apple_build_version__ < 14000029L',
    '#  define FMT_USE_CONSTEVAL 0  // consteval is broken in Apple clang < 14.',
  ].join('\n');
  const newBranch = [
    '#elif defined(__apple_build_version__)',
    '#  define FMT_USE_CONSTEVAL 0  // consteval is broken in Apple clang.',
  ].join('\n');

  if (content.includes(newBranch)) {
    return;
  }
  if (!content.includes(oldBranch)) {
    throw new Error('Could not apply the required fmt compatibility adjustment.');
  }

  fs.chmodSync(fmtBase, fs.statSync(fmtBase).mode | 0o200);
  fs.writeFileSync(fmtBase, content.replace(oldBranch, newBranch), 'utf8');
  console.log(`✓ Applied the React Native fmt adjustment for Apple Clang ${clangMajor}`);
}

function iosPodsAreCurrent(iosDir, outputDir = path.dirname(iosDir)) {
  const lockfile = path.join(iosDir, 'Podfile.lock');
  const manifest = path.join(iosDir, 'Pods', 'Manifest.lock');
  if (!fs.existsSync(lockfile) || !fs.existsSync(manifest)) {
    return false;
  }
  if (fs.readFileSync(lockfile, 'utf8') !== fs.readFileSync(manifest, 'utf8')) {
    return false;
  }

  const manifestTime = fs.statSync(manifest).mtimeMs;
  const dependencyInputs = [
    path.join(iosDir, 'Podfile'),
    path.join(outputDir, 'package.json'),
    path.join(outputDir, 'package-lock.json'),
  ].filter(filePath => fs.existsSync(filePath));
  return dependencyInputs.every(
    filePath => fs.statSync(filePath).mtimeMs <= manifestTime
  );
}

function ensureIosPods(iosDir, environment, options = {}) {
  const outputDir = options.outputDir || path.dirname(iosDir);
  if (!options.force && iosPodsAreCurrent(iosDir, outputDir)) {
    console.log('✓ iOS Pods are current');
    applyFmtAppleClangWorkaround(iosDir, environment);
    return;
  }
  console.log('Ensuring iOS dependencies (Pods)...');
  run(environment.pod, ['install'], iosDir, environment.env);
  applyFmtAppleClangWorkaround(iosDir, environment);
  console.log('✓ iOS dependencies installed');
}

function iosBuildContainer(iosDir, nativeName) {
  const entries = fs.readdirSync(iosDir);
  const workspaces = entries.filter(name => name.endsWith('.xcworkspace')).sort();
  const projects = entries.filter(name => name.endsWith('.xcodeproj')).sort();
  const preferredWorkspace = `${nativeName}.xcworkspace`;
  const preferredProject = `${nativeName}.xcodeproj`;

  if (workspaces.includes(preferredWorkspace)) {
    return ['-workspace', preferredWorkspace];
  }
  if (workspaces.length > 0) {
    return ['-workspace', workspaces[0]];
  }
  if (projects.includes(preferredProject)) {
    return ['-project', preferredProject];
  }
  if (projects.length > 0) {
    return ['-project', projects[0]];
  }
  return null;
}

function parseIosSimulatorDestinations(output) {
  const destinations = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('platform:iOS Simulator') || line.includes('error:')) {
      continue;
    }
    const idMatch = line.match(/\bid:([^,}]+)/);
    const nameMatch = line.match(/\bname:([^,}]+)/);
    const osMatch = line.match(/\bOS:([^,}]+)/);
    if (!idMatch || !nameMatch) {
      continue;
    }
    const id = idMatch[1].trim();
    if (id.startsWith('dvtdevice-') || id.toLowerCase().includes('placeholder')) {
      continue;
    }
    destinations.push({
      id,
      name: nameMatch[1].trim(),
      os: osMatch ? osMatch[1].trim() : 'unknown',
    });
  }
  return destinations;
}

function queryEligibleIosSimulators(iosDir, nativeName, environment) {
  const container = iosBuildContainer(iosDir, nativeName);
  if (!container) {
    return {
      destinations: [],
      output: 'No Xcode workspace or project was found after pod install.',
      status: 1,
    };
  }

  const result = capture(
    environment.xcodebuild,
    [
      ...container,
      '-scheme',
      nativeName,
      '-configuration',
      'Debug',
      '-showdestinations',
    ],
    { cwd: iosDir, env: environment.env, check: false }
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return {
    destinations: parseIosSimulatorDestinations(output),
    output,
    status: result.status,
  };
}

function bootedIosSimulatorIds(environment) {
  try {
    const result = capture(
      environment.xcrun,
      ['simctl', 'list', '--json', 'devices'],
      { env: environment.env }
    );
    const data = JSON.parse(result.stdout);
    const ids = new Set();
    for (const devices of Object.values(data.devices || {})) {
      for (const device of devices) {
        if (device.state === 'Booted' && device.udid) {
          ids.add(device.udid);
        }
      }
    }
    return ids;
  } catch (_error) {
    return new Set();
  }
}

function selectIosSimulator(destinations, environment) {
  const booted = bootedIosSimulatorIds(environment);
  return destinations.find(destination => booted.has(destination.id))
    || destinations.find(destination => destination.name.toLowerCase().startsWith('iphone'))
    || destinations[0]
    || null;
}

async function ensureEligibleIosSimulator(iosDir, nativeName, environment) {
  let query = queryEligibleIosSimulators(iosDir, nativeName, environment);
  if (query.destinations.length > 0) {
    const selected = selectIosSimulator(query.destinations, environment);
    console.log(`Using ${selected.name} (iOS ${selected.os}, ${selected.id})`);
    return selected;
  }

  const missingVersions = [...query.output.matchAll(
    /iOS ([0-9]+(?:\.[0-9]+)*) is not installed/g
  )].map(match => match[1]);

  if (query.status !== 0 && missingVersions.length === 0) {
    throw new Error('Xcode could not determine an eligible simulator for this app.');
  }

  if (missingVersions.length > 0) {
    console.log(
      `The iOS Simulator runtime required by Xcode is missing (${[...new Set(missingVersions)].join(', ')}).`
    );
  } else {
    console.log('No installed simulator is eligible for the generated app.');
  }

  const shouldDownload = await promptYesNo(
    'Download the compatible iOS Simulator runtime now? This can be several GB. (y/N): '
  );
  if (!shouldDownload) {
    throw new Error('iOS launch cancelled; no compatible simulator runtime is installed.');
  }

  console.log('Downloading the compatible iOS Simulator runtime...');
  run(
    environment.xcodebuild,
    ['-downloadPlatform', 'iOS'],
    iosDir,
    environment.env
  );

  query = queryEligibleIosSimulators(iosDir, nativeName, environment);
  if (query.destinations.length === 0) {
    throw new Error(
      'The runtime download completed, but Xcode still reports no eligible simulator.'
    );
  }

  const selected = selectIosSimulator(query.destinations, environment);
  console.log(`Using ${selected.name} (iOS ${selected.os}, ${selected.id})`);
  return selected;
}

function nativeAppName(outputDir) {
  const appJson = JSON.parse(
    fs.readFileSync(path.join(outputDir, 'app.json'), 'utf8')
  );
  if (!appJson.name) {
    throw new Error('The generated app has no native project name.');
  }
  return appJson.name;
}

function parseBuildSetting(output, setting) {
  const expression = new RegExp(`^\\s*${setting}\\s*=\\s*(.+?)\\s*$`, 'm');
  const match = output.match(expression);
  return match ? match[1] : null;
}

function iosBundleIdentifier(
  iosDir,
  nativeName,
  simulatorId,
  environment
) {
  const container = iosBuildContainer(iosDir, nativeName);
  if (!container) {
    throw new Error('Could not locate the iOS workspace or project.');
  }
  const settings = capture(
    environment.xcodebuild,
    [
      ...container,
      '-scheme',
      nativeName,
      '-configuration',
      'Debug',
      '-destination',
      `id=${simulatorId}`,
      '-showBuildSettings',
    ],
    { cwd: iosDir, env: environment.env }
  );
  const identifier = parseBuildSetting(
    settings.stdout,
    'PRODUCT_BUNDLE_IDENTIFIER'
  );
  if (!identifier) {
    throw new Error('Xcode did not report an iOS product bundle identifier.');
  }
  return identifier;
}

function iosJsLocation(metroPort) {
  return `localhost:${metroPort}`;
}

function launchIosWithMetro(
  simulatorId,
  bundleIdentifier,
  metroPort,
  environment
) {
  // RCTBundleURLProvider expects a host (and optional port), not a full URL.
  // Supplying http:// here causes React Native to construct http://http://...
  // and silently fall back to its default Metro port.
  const jsLocation = iosJsLocation(metroPort);
  console.log(`Binding ${bundleIdentifier} to Metro at ${jsLocation}`);
  run(
    environment.xcrun,
    [
      'simctl',
      'launch',
      '--terminate-running-process',
      simulatorId,
      bundleIdentifier,
      '-RCT_jsLocation',
      jsLocation,
    ],
    undefined,
    environment.env
  );
}

async function runIos({ name, output, metroPort }) {
  const outputDir = path.resolve(output || process.cwd());
  console.log('Preparing iOS development...');
  const environment = doctorIos();
  environment.env.ONRAMP_PLATFORM = 'ios';

  if (environment.version.number > 0 && environment.version.number < 16.1) {
    console.log('Warning: React Native 0.81.x works best with Xcode 16.1 or later.');
    const shouldContinue = await promptYesNo('Continue anyway? (y/N): ');
    if (!shouldContinue) {
      throw new Error('iOS launch cancelled.');
    }
  }

  await addNativePlatforms({ platform: 'ios', name, output: outputDir });
  const iosDir = path.join(outputDir, 'ios');
  ensureXcodeComponents(environment, iosDir);
  ensureIosPods(iosDir, environment, { outputDir });
  console.log('Checking for an eligible iOS simulator...');
  const nativeName = nativeAppName(outputDir);
  const simulator = await ensureEligibleIosSimulator(
    iosDir,
    nativeName,
    environment
  );
  const bundleIdentifier = iosBundleIdentifier(
    iosDir,
    nativeName,
    simulator.id,
    environment
  );
  const metro = await startMetro({
    output: outputDir,
    requestedPort: metroPort,
    env: environment.env,
  });
  console.log(`Using Metro port ${metro.port}`);
  console.log('Starting iOS simulator...');
  try {
    await warmMetroBundle({ port: metro.port, platform: 'ios' });
    run(
      'npx',
      [
        'react-native',
        'run-ios',
        '--udid',
        simulator.id,
        '--port',
        String(metro.port),
        '--no-packager',
      ],
      outputDir,
      environment.env
    );
    launchIosWithMetro(
      simulator.id,
      bundleIdentifier,
      metro.port,
      environment
    );
    console.log('iOS app launched. Metro remains active; press Ctrl+C to stop.');
    return metro;
  } catch (error) {
    metro.stop('SIGTERM');
    throw error;
  }
}

async function repairIos({ name, output, fresh = false }) {
  const outputDir = path.resolve(output || process.cwd());
  console.log('Repairing iOS development files...');
  const environment = doctorIos();
  await addNativePlatforms({ platform: 'ios', name, output: outputDir });
  const iosDir = path.join(outputDir, 'ios');
  const nativeName = nativeAppName(outputDir);
  const container = iosBuildContainer(iosDir, nativeName);

  if (container) {
    const clean = capture(
      environment.xcodebuild,
      [...container, '-scheme', nativeName, 'clean'],
      { cwd: iosDir, env: environment.env, check: false }
    );
    if (clean.status !== 0) {
      console.log('Xcode clean did not complete; continuing with dependency repair.');
    }
  }

  fs.rmSync(path.join(iosDir, 'Pods'), { recursive: true, force: true });
  if (fresh) {
    fs.rmSync(path.join(iosDir, 'Podfile.lock'), { force: true });
    console.log('Removed Podfile.lock because --fresh was requested.');
  } else {
    console.log('Preserving Podfile.lock.');
  }
  ensureIosPods(iosDir, environment, { force: true, outputDir });
  console.log('✓ iOS project repaired');
}

module.exports = {
  doctorIos,
  ensureEligibleIosSimulator,
  iosBundleIdentifier,
  iosJsLocation,
  iosPodsAreCurrent,
  launchIosWithMetro,
  parseBuildSetting,
  repairIos,
  runIos,
};
