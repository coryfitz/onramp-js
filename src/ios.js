const fs = require('fs');
const path = require('path');
const { addNativePlatforms } = require('./native');
const { startMetro, warmMetroBundle } = require('./metro');
const { capture, findExecutable, run } = require('./process');
const { promptYesNo } = require('./prompt');

const IOS_DESTINATION_QUERY_ATTEMPTS = 3;
const IOS_DESTINATION_RETRY_DELAY_MS = 500;

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

async function prepareIosEnvironment(options = {}) {
  try {
    return (options.doctor || doctorIos)();
  } catch (error) {
    if (!/Xcode command-line tools were not found/.test(error.message)) {
      throw error;
    }
    const ask = options.promptYesNo || promptYesNo;
    const approved = await ask(
      'iOS Simulator is not installed because Xcode is missing. Open the '
      + 'Xcode page in the Mac App Store now? (y/N): '
    );
    if (!approved) {
      throw new Error(
        'iOS launch cancelled; install Xcode to obtain iOS Simulator.'
      );
    }
    const open = options.captureCommand || capture;
    const result = open(
      'open',
      ['macappstore://itunes.apple.com/app/id497799835'],
      { env: process.env, check: false }
    );
    if (result.status !== 0) {
      throw new Error(
        'Could not open the Xcode page in the Mac App Store. Install Xcode '
        + 'from Apple, then run OnRamp again.'
      );
    }
    throw new Error(
      'The Xcode page is open. Complete Apple\'s Xcode installation, then '
      + 'run OnRamp again; OnRamp will install the newest iOS runtime.'
    );
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

function parseAvailableIosSimulatorRuntimes(output) {
  const data = JSON.parse(output);
  return (data.runtimes || [])
    .filter(runtime => (
      runtime.isAvailable === true
      && typeof runtime.identifier === 'string'
      && runtime.identifier.includes('.SimRuntime.iOS-')
    ))
    .map(runtime => ({
      build: runtime.buildversion || runtime.buildVersion || null,
      identifier: runtime.identifier,
      version: runtime.version || runtime.name || null,
    }))
    .filter(runtime => runtime.version);
}

function parseAvailableIosSimulatorRuntimeVersions(output) {
  return parseAvailableIosSimulatorRuntimes(output)
    .map(runtime => runtime.version);
}

function availableIosSimulatorRuntimes(environment) {
  const result = capture(
    environment.xcrun,
    ['simctl', 'list', '--json', 'runtimes'],
    { env: environment.env, check: false }
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return parseAvailableIosSimulatorRuntimes(result.stdout);
  } catch (_error) {
    return null;
  }
}

function availableIosSimulatorRuntimeVersions(environment) {
  const runtimes = availableIosSimulatorRuntimes(environment);
  return runtimes ? runtimes.map(runtime => runtime.version) : null;
}

function parsePreferredIosSimulatorRuntime(output) {
  const data = JSON.parse(output);
  const candidates = Object.entries(data)
    .filter(([, value]) => (
      value
      && value.platform === 'com.apple.platform.iphoneos'
      && value.chosenRuntimeBuild
    ))
    .map(([key, value]) => {
      const keyVersion = key.match(/^iphoneos(\d+(?:\.\d+)*)$/i);
      const directoryVersion = String(value.sdkDirectory || '').match(
        /iPhoneOS(\d+(?:\.\d+)*)\.sdk/i
      );
      return {
        build: value.chosenRuntimeBuild,
        version: (
          (keyVersion && keyVersion[1])
          || (directoryVersion && directoryVersion[1])
          || value.sdkVersion
        ),
      };
    })
    .filter(runtime => runtime.version)
    .sort((left, right) => compareIosVersions(
      right.version,
      left.version
    ));
  return candidates[0] || null;
}

function compareIosVersions(left, right) {
  const leftParts = String(left || '').match(/\d+/g) || [];
  const rightParts = String(right || '').match(/\d+/g) || [];
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const difference = Number(leftParts[index] || 0)
      - Number(rightParts[index] || 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function preferredIosSimulatorRuntime(
  environment,
  captureCommand = capture
) {
  const match = captureCommand(
    environment.xcrun,
    ['simctl', 'runtime', 'match', 'list', '-j'],
    { env: environment.env, check: false }
  );
  if (match.status === 0) {
    try {
      const preferred = parsePreferredIosSimulatorRuntime(match.stdout);
      if (preferred) {
        return preferred;
      }
    } catch (_error) {
      // Fall through for Xcode versions without runtime matching metadata.
    }
  }

  const sdkVersion = captureCommand(
    environment.xcodebuild,
    ['-version', '-sdk', 'iphonesimulator', 'ProductVersion'],
    { env: environment.env, check: false }
  );
  if (sdkVersion.status !== 0) {
    return null;
  }
  const version = sdkVersion.stdout.trim().match(/\d+(?:\.\d+)*/);
  if (!version) {
    return null;
  }
  return {
    build: null,
    version: version[0].split('.').slice(0, 2).join('.'),
  };
}

function iosRuntimeMatchesPreferred(runtime, preferred) {
  if (!runtime || !preferred) {
    return false;
  }
  if (preferred.build) {
    return runtime.build === preferred.build;
  }
  return compareIosVersions(runtime.version, preferred.version) === 0;
}

function iosRuntimeArchitectureVariant(architecture = process.arch) {
  return architecture === 'arm64' ? 'arm64' : 'universal';
}

function iosRuntimeDescription(runtime) {
  return 'iOS ' + runtime.version
    + (runtime.build ? ' build ' + runtime.build : '');
}

async function ensurePreferredIosSimulatorRuntime(
  environment,
  options = {}
) {
  const inspect = options.inspectRuntimes || availableIosSimulatorRuntimes;
  const findPreferred = (
    options.preferredRuntime || preferredIosSimulatorRuntime
  );
  const ask = options.promptYesNo || promptYesNo;
  const runCommand = options.runCommand || run;
  const log = options.log || console.log;
  const architectureVariant = options.architectureVariant
    || iosRuntimeArchitectureVariant();
  const preferred = findPreferred(environment);
  let installed = inspect(environment);
  if (!preferred || installed === null) {
    log(
      'OnRamp could not determine Apple\'s newest compatible iOS '
      + 'Simulator runtime; continuing with Xcode\'s installed runtimes.'
    );
    return { changed: false, installed, preferred };
  }

  if (installed.some(runtime => (
    iosRuntimeMatchesPreferred(runtime, preferred)
  ))) {
    log(
      '✓ Latest compatible iOS Simulator runtime is installed (iOS '
      + preferred.version
      + (preferred.build ? ', build ' + preferred.build : '') + ')'
    );
    return { changed: false, installed, preferred };
  }

  const current = installed.slice().sort((left, right) => (
    compareIosVersions(right.version, left.version)
  ))[0];
  let question;
  if (!current) {
    question = (
      'No iOS Simulator runtime is installed. Download and install iOS '
      + preferred.version + ' now? This can be several GB. (y/N): '
    );
  } else if (
    compareIosVersions(current.version, preferred.version) === 0
    && preferred.build
  ) {
    question = (
      'A newer iOS ' + preferred.version
      + ' Simulator runtime build is available ('
      + preferred.build + '; installed ' + (current.build || 'unknown')
      + '). Upgrade now? This can be several GB. (y/N): '
    );
  } else {
    question = (
      'iOS ' + preferred.version
      + ' is the newest Simulator runtime compatible with this Xcode; iOS '
      + current.version
      + ' is installed. Download and install the newer runtime? '
      + 'This can be several GB. (y/N): '
    );
  }

  const approved = await ask(question);
  if (!approved) {
    if (!current) {
      throw new Error(
        'iOS launch cancelled; no Simulator runtime is installed.'
      );
    }
    log('Continuing with iOS Simulator runtime ' + current.version + '.');
    return { changed: false, installed, preferred };
  }

  log(
    'Downloading iOS ' + preferred.version
    + ' Simulator runtime through Xcode...'
  );
  const requestedBuild = preferred.build || preferred.version;
  try {
    runCommand(
      environment.xcodebuild,
      [
        '-downloadPlatform',
        'iOS',
        '-buildVersion',
        requestedBuild,
        '-architectureVariant',
        architectureVariant,
      ],
      options.cwd,
      environment.env
    );
  } catch (_exactDownloadError) {
    log(
      'Xcode could not download the requested runtime build directly; '
      + 'retrying its latest compatible iOS runtime...'
    );
    try {
      runCommand(
        environment.xcodebuild,
        [
          '-downloadPlatform',
          'iOS',
          '-architectureVariant',
          architectureVariant,
        ],
        options.cwd,
        environment.env
      );
    } catch (latestDownloadError) {
      if (current) {
        log(
          'Xcode could not upgrade the iOS Simulator runtime. Continuing '
          + 'with installed ' + iosRuntimeDescription(current) + '.'
        );
        return { changed: false, installed, preferred };
      }
      throw new Error(
        'Could not install an iOS Simulator runtime through Xcode: '
        + latestDownloadError.message
      );
    }
  }

  installed = inspect(environment);
  const matchingRuntime = installed && installed.find(runtime => (
    iosRuntimeMatchesPreferred(runtime, preferred)
  ));
  if (matchingRuntime) {
    log('✓ iOS Simulator runtime ' + preferred.version + ' installed');
    return { changed: true, installed, preferred };
  }

  const usableRuntime = installed && installed.slice().sort((left, right) => (
    compareIosVersions(right.version, left.version)
  ))[0];
  if (usableRuntime) {
    const changed = !current
      || current.version !== usableRuntime.version
      || current.build !== usableRuntime.build;
    log(
      'Xcode did not install the preferred runtime build. Continuing with '
      + iosRuntimeDescription(usableRuntime) + '.'
    );
    return { changed, installed, preferred };
  }
  if (current) {
    log(
      'OnRamp could not verify the runtime after Xcode completed. Continuing '
      + 'with previously installed ' + iosRuntimeDescription(current) + '.'
    );
    return { changed: false, installed, preferred };
  }

  if (installed === null) {
    throw new Error(
      'Xcode completed the runtime download, but OnRamp could not verify '
      + 'an installed iOS Simulator runtime.'
    );
  }
  throw new Error(
    'Xcode completed the runtime download, but no iOS Simulator runtime '
    + 'is installed.'
  );
}

function warmCoreSimulator(environment) {
  capture(
    environment.xcrun,
    ['simctl', 'list', '--json', 'devices', 'available'],
    { env: environment.env, check: false }
  );
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function queryEligibleIosSimulatorsWithRetry(
  iosDir,
  nativeName,
  environment,
  options = {}
) {
  const attempts = options.attempts ?? IOS_DESTINATION_QUERY_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? IOS_DESTINATION_RETRY_DELAY_MS;
  const query = options.query || queryEligibleIosSimulators;
  const warm = options.warm || warmCoreSimulator;
  const waitForRetry = options.wait || wait;

  warm(environment);
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = query(iosDir, nativeName, environment);
    if (result.destinations.length > 0 || attempt === attempts) {
      return result;
    }
    if (attempt === 1) {
      console.log('Xcode has not reported a simulator yet; checking again...');
    }
    warm(environment);
    await waitForRetry(retryDelayMs);
  }
  return result;
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

function parseIosSimulatorState(output, simulatorId) {
  const data = JSON.parse(output);
  for (const devices of Object.values(data.devices || {})) {
    const simulator = devices.find(device => device.udid === simulatorId);
    if (simulator) {
      return simulator.state || null;
    }
  }
  return null;
}

function iosSimulatorState(simulatorId, environment, captureCommand = capture) {
  const result = captureCommand(
    environment.xcrun,
    ['simctl', 'list', '--json', 'devices'],
    { env: environment.env, check: false }
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return parseIosSimulatorState(result.stdout, simulatorId);
  } catch (_error) {
    return null;
  }
}

function ensureIosSimulatorBooted(
  simulator,
  environment,
  captureCommand = capture
) {
  let state = iosSimulatorState(simulator.id, environment, captureCommand);
  if (!state) {
    throw new Error(`Could not find the selected iOS simulator (${simulator.id}).`);
  }

  if (state !== 'Booted' && state !== 'Booting') {
    console.log(`Booting ${simulator.name}...`);
    const boot = captureCommand(
      environment.xcrun,
      ['simctl', 'boot', simulator.id],
      { env: environment.env, check: false }
    );
    if (boot.status !== 0) {
      state = iosSimulatorState(simulator.id, environment, captureCommand);
      if (state !== 'Booted' && state !== 'Booting') {
        const detail = (boot.stderr || boot.stdout || '').trim();
        throw new Error(
          `Could not boot ${simulator.name}`
          + `${detail ? `: ${detail}` : '.'}`
        );
      }
    }
  }

  captureCommand(
    environment.xcrun,
    ['simctl', 'bootstatus', simulator.id, '-b'],
    { env: environment.env }
  );
  console.log(`✓ ${simulator.name} is ready`);
}

function activateIosSimulator(environment, captureCommand = capture) {
  const result = captureCommand(
    'osascript',
    [
      '-e',
      'tell application id "com.apple.iphonesimulator" to activate',
    ],
    { env: environment.env, check: false }
  );
  return result.status === 0;
}

function showIosSimulator(
  simulator,
  environment,
  captureCommand = capture,
  pathExists = fs.existsSync
) {
  const xcodeSelect = environment.xcodeSelect
    || findExecutable('xcode-select', environment.env);
  if (!xcodeSelect) {
    throw new Error('xcode-select was not found on PATH.');
  }
  const developerDir = captureCommand(xcodeSelect, ['-p'], {
    env: environment.env,
  }).stdout.trim();
  const simulatorApp = path.join(
    developerDir,
    'Applications',
    'Simulator.app'
  );
  const deviceHubApp = path.join(
    developerDir,
    '..',
    'Applications',
    'DeviceHub.app'
  );

  let result;
  if (pathExists(simulatorApp)) {
    result = captureCommand(
      'open',
      [simulatorApp, '--args', '-CurrentDeviceUDID', simulator.id],
      { env: environment.env, check: false }
    );
    if (result.status === 0) {
      activateIosSimulator(environment, captureCommand);
    }
  } else if (pathExists(deviceHubApp)) {
    result = captureCommand(
      'open',
      [`devices://device/open?id=${simulator.id}`],
      { env: environment.env, check: false }
    );
  } else {
    throw new Error('Could not locate Simulator.app or DeviceHub.app.');
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      'Could not open the iOS simulator window'
      + `${detail ? `: ${detail}` : '.'}`
    );
  }
  console.log(`✓ ${simulator.name} window opened`);
}

function selectIosSimulator(
  destinations,
  environment,
  booted = bootedIosSimulatorIds(environment)
) {
  const newest = destinations
    .slice()
    .sort((left, right) => compareIosVersions(right.os, left.os));
  const newestVersion = newest[0] && newest[0].os;
  const preferred = newest.filter(destination => (
    compareIosVersions(destination.os, newestVersion) === 0
  ));
  return preferred.find(destination => booted.has(destination.id))
    || preferred.find(destination => (
      destination.name.toLowerCase().startsWith('iphone')
    ))
    || preferred[0]
    || null;
}

async function ensureEligibleIosSimulator(
  iosDir,
  nativeName,
  environment,
  options = {}
) {
  const inspectRuntimes = (
    options.inspectRuntimes || availableIosSimulatorRuntimeVersions
  );
  const queryWithRetry = (
    options.queryWithRetry || queryEligibleIosSimulatorsWithRetry
  );
  const askToDownload = options.promptYesNo || promptYesNo;
  const runCommand = options.runCommand || run;
  const selectSimulator = options.selectSimulator || selectIosSimulator;
  const architectureVariant = options.architectureVariant
    || iosRuntimeArchitectureVariant();
  const installedRuntimes = inspectRuntimes(environment);
  let query = await queryWithRetry(
    iosDir,
    nativeName,
    environment
  );
  if (query.destinations.length > 0) {
    const selected = selectSimulator(query.destinations, environment);
    console.log(`Using ${selected.name} (iOS ${selected.os}, ${selected.id})`);
    return selected;
  }

  const missingVersions = [...query.output.matchAll(
    /iOS ([0-9]+(?:\.[0-9]+)*) is not installed/g
  )].map(match => match[1]);

  if (query.status !== 0 && missingVersions.length === 0) {
    throw new Error('Xcode could not determine an eligible simulator for this app.');
  }

  if (missingVersions.length === 0 && installedRuntimes === null) {
    throw new Error(
      'Xcode reported no eligible simulator, and OnRamp could not inspect the installed runtimes.'
    );
  }

  if (missingVersions.length === 0 && installedRuntimes.length > 0) {
    throw new Error(
      'Xcode reported no eligible simulator even though iOS Simulator runtimes are installed '
      + `(${installedRuntimes.join(', ')}). Open Simulator once, then run OnRamp again.`
    );
  }

  if (missingVersions.length > 0) {
    console.log(
      `The iOS Simulator runtime required by Xcode is missing (${[...new Set(missingVersions)].join(', ')}).`
    );
  } else {
    console.log('No iOS Simulator runtime is installed.');
  }

  const shouldDownload = await askToDownload(
    'Download the compatible iOS Simulator runtime now? This can be several GB. (y/N): '
  );
  if (!shouldDownload) {
    throw new Error('iOS launch cancelled; no compatible simulator runtime is installed.');
  }

  console.log('Downloading the compatible iOS Simulator runtime...');
  runCommand(
    environment.xcodebuild,
    [
      '-downloadPlatform',
      'iOS',
      '-architectureVariant',
      architectureVariant,
    ],
    iosDir,
    environment.env
  );

  query = await queryWithRetry(
    iosDir,
    nativeName,
    environment
  );
  if (query.destinations.length === 0) {
    throw new Error(
      'The runtime download completed, but Xcode still reports no eligible simulator.'
    );
  }

  const selected = selectSimulator(query.destinations, environment);
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

async function prepareIosDevelopment({
  name,
  output,
  watchDiagnostics = false,
}) {
  const outputDir = path.resolve(output || process.cwd());
  console.log('Preparing iOS development...');
  const environment = await prepareIosEnvironment();
  environment.env.ONRAMP_PLATFORM = 'ios';
  if (watchDiagnostics) {
    environment.env.ONRAMP_WATCH_DIAGNOSTICS = '1';
  }

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
  console.log('Checking for the latest compatible iOS Simulator runtime...');
  await ensurePreferredIosSimulatorRuntime(environment, { cwd: iosDir });
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
  return {
    bundleIdentifier,
    environment,
    outputDir,
    simulator,
  };
}

async function launchPreparedIos(
  prepared,
  { metroPort, metroInteractive = true, metroLabel } = {}
) {
  const {
    bundleIdentifier,
    environment,
    outputDir,
    simulator,
  } = prepared;
  console.log('Starting iOS simulator...');
  ensureIosSimulatorBooted(simulator, environment);
  showIosSimulator(simulator, environment);
  const metro = await startMetro({
    output: outputDir,
    requestedPort: metroPort,
    env: environment.env,
    interactive: metroInteractive,
    label: metroLabel,
  });
  console.log(`Using Metro port ${metro.port}`);
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
      environment.env,
      { inheritInput: metroInteractive }
    );
    launchIosWithMetro(
      simulator.id,
      bundleIdentifier,
      metro.port,
      environment
    );
    activateIosSimulator(environment);
    console.log('iOS app launched. Metro remains active; press Ctrl+C to stop.');
    return metro;
  } catch (error) {
    metro.stop('SIGTERM');
    throw error;
  }
}

async function runIos(options) {
  const prepared = await prepareIosDevelopment(options);
  return launchPreparedIos(prepared, { metroPort: options.metroPort });
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
  activateIosSimulator,
  availableIosSimulatorRuntimes,
  availableIosSimulatorRuntimeVersions,
  doctorIos,
  ensureEligibleIosSimulator,
  ensureIosSimulatorBooted,
  ensurePreferredIosSimulatorRuntime,
  iosBundleIdentifier,
  iosJsLocation,
  iosPodsAreCurrent,
  iosRuntimeArchitectureVariant,
  launchIosWithMetro,
  parseAvailableIosSimulatorRuntimeVersions,
  parseAvailableIosSimulatorRuntimes,
  parseBuildSetting,
  parseIosSimulatorState,
  parsePreferredIosSimulatorRuntime,
  preferredIosSimulatorRuntime,
  launchPreparedIos,
  prepareIosDevelopment,
  prepareIosEnvironment,
  queryEligibleIosSimulatorsWithRetry,
  repairIos,
  runIos,
  selectIosSimulator,
  showIosSimulator,
};
