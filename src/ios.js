const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { addNativePlatforms } = require('./native');
const {
  cachedNativeBuild,
  clearNativeBuildState,
  nativeBuildFingerprint,
  recordNativeBuild,
} = require('./native-build-cache');
const { startMetro, warmMetroBundle } = require('./metro');
const {
  capture,
  childEnvironment,
  findExecutable,
  run,
  runAsync,
} = require('./process');
const { promptYesNo } = require('./prompt');
const { offerIosRuntimeCleanup } = require('./ios-runtime-cleanup');
const { syncIosNodeEnvironment } = require('./ios-node-env');
const { ensureIosPodsDeploymentTarget } = require('./ios-pods-deployment-target');

const IOS_DESTINATION_QUERY_ATTEMPTS = 3;
const IOS_DESTINATION_RETRY_DELAY_MS = 500;
const IOS_RUNTIME_DOWNLOAD_RETRY_MS = 24 * 60 * 60 * 1000;
const IOS_PASTEBOARD_SYNC_SESSION_SECONDS = 365 * 24 * 60 * 60;
const IOS_SIMULATOR_SHUTDOWN_TIMEOUT_MS = 30000;
const IOS_SIMULATOR_SHUTDOWN_POLL_MS = 250;
const SYSTEM_ENV = '/usr/bin/env';
const SYSTEM_DEFAULTS = '/usr/bin/defaults';
const SYSTEM_SUDO = '/usr/bin/sudo';
const SYSTEM_XCODEBUILD = '/usr/bin/xcodebuild';
const SYSTEM_XCRUN = '/usr/bin/xcrun';

function requireDarwin() {
  if (process.platform !== 'darwin') {
    throw new Error('iOS development requires macOS.');
  }
}

function xcodeVersion(xcodebuild, env = process.env) {
  const result = capture(xcodebuild, ['-version'], { env });
  const firstLine = result.stdout.split(/\r?\n/)[0] || '';
  const match = firstLine.match(/^Xcode\s+([0-9]+(?:\.[0-9]+)?)/);
  return {
    display: firstLine || 'Xcode',
    number: match ? Number(match[1]) : 0,
  };
}

function resolveSelectedDeveloperDir(xcrun, env, captureCommand = capture) {
  try {
    const result = captureCommand(xcrun, ['--find', 'xcodebuild'], {
      env,
      check: false,
    });
    const candidate = result.stdout.trim().split(/\r?\n/)[0];
    const suffix = path.join('usr', 'bin', 'xcodebuild');
    if (
      result.status === 0
      && path.isAbsolute(candidate)
      && candidate.endsWith(suffix)
    ) {
      const developerDir = candidate
        .slice(0, -suffix.length)
        .replace(/[\\/]$/, '');
      if (developerDir) {
        const selected = fs.realpathSync(developerDir);
        if (env.DEVELOPER_DIR) {
          const requested = fs.realpathSync(env.DEVELOPER_DIR);
          if (requested !== selected) {
            throw new Error(
              `xcrun selected ${developerDir}, not DEVELOPER_DIR=${env.DEVELOPER_DIR}.`
            );
          }
        }
        return selected;
      }
    }
  } catch (error) {
    if (env.DEVELOPER_DIR) {
      throw new Error(
        `Could not validate DEVELOPER_DIR=${env.DEVELOPER_DIR}: ${error.message}`
      );
    }
  }
  if (env.DEVELOPER_DIR) {
    throw new Error(
      `Could not resolve xcodebuild for DEVELOPER_DIR=${env.DEVELOPER_DIR}.`
    );
  }
  return null;
}

function inspectIosEnvironment() {
  requireDarwin();
  const env = { ...process.env };
  const xcodebuild = fs.existsSync(SYSTEM_XCODEBUILD)
    ? SYSTEM_XCODEBUILD
    : null;
  const xcrun = fs.existsSync(SYSTEM_XCRUN) ? SYSTEM_XCRUN : null;
  const pod = findExecutable('pod', env);

  if (!xcodebuild || !xcrun) {
    throw new Error('Xcode command-line tools were not found. Install Xcode, then try again.');
  }
  if (!pod) {
    throw new Error('CocoaPods not found. Install it with `brew install cocoapods`, then try again.');
  }

  const developerDir = resolveSelectedDeveloperDir(
    xcrun,
    env
  );
  const developerDirOverride = Boolean(env.DEVELOPER_DIR);
  const version = xcodeVersion(xcodebuild, env);
  console.log(`Found ${version.display}`);
  return {
    developerDir,
    developerDirOverride,
    env,
    pod,
    version,
    xcodebuild,
    xcrun,
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function xcodeSetupInvocation(environment, action) {
  const args = [];
  if (xcodeDeveloperDirIsExplicit(environment)) {
    args.push(
      SYSTEM_ENV,
      `DEVELOPER_DIR=${environment.developerDir}`
    );
  }
  args.push(SYSTEM_XCODEBUILD, action);
  return {
    args,
    command: SYSTEM_SUDO,
    display: ['sudo', ...args].map(shellQuote).join(' '),
  };
}

function xcodeDeveloperDirIsExplicit(environment) {
  return Boolean(
    environment.developerDirOverride
    || (environment.env && environment.env.DEVELOPER_DIR)
  );
}

function explicitDeveloperDirSetupError(environment, invocation) {
  return new Error(
    `DEVELOPER_DIR is explicitly set to ${environment.developerDir}. OnRamp `
    + 'will not pass a user-selected developer directory through sudo. Run '
    + `\`${invocation.display}\` in an interactive Terminal, then run OnRamp again.`
  );
}

function xcodeResultOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function xcodeLicenseIsRequired(result) {
  return /(?:have not agreed|accept|agree).{0,80}Xcode.{0,80}license|Xcode.{0,80}license agreement/isu
    .test(xcodeResultOutput(result));
}

function xcodeCapture(environment, args, captureCommand = capture) {
  return captureCommand(environment.xcodebuild, args, {
    env: environment.env,
    check: false,
  });
}

function failedXcodeCommand(environment, args, result) {
  const detail = xcodeResultOutput(result);
  return new Error(
    `${environment.xcodebuild} ${args.join(' ')} exited with status ${result.status}`
    + `${detail ? `: ${detail}` : ''}`
  );
}

async function runXcodeSetupAction(environment, action, options = {}) {
  const ask = options.promptYesNo || promptYesNo;
  const runCommand = options.runCommand || runAsync;
  const invocation = xcodeSetupInvocation(environment, action);
  const license = action === '-license';
  if (xcodeDeveloperDirIsExplicit(environment)) {
    throw explicitDeveloperDirSetupError(environment, invocation);
  }
  const question = license
    ? 'Xcode\'s license agreements must be reviewed and accepted before iOS development. '
      + `Open Apple\'s interactive license review now with \`${invocation.display}\`? (y/N): `
    : 'Xcode must finish installing its first-launch components before iOS development. '
      + `Run \`${invocation.display}\` now? (y/N): `;
  const promptOptions = {};
  if (options.input) {
    promptOptions.input = options.input;
  }
  if (options.output) {
    promptOptions.output = options.output;
  }
  const approved = await ask(question, promptOptions);
  if (!approved) {
    const description = license
      ? 'Xcode license review is required'
      : 'Xcode first-launch setup is required';
    throw new Error(
      `${description} before iOS development can continue. Run `
      + `\`${invocation.display}\` in an interactive Terminal, then run OnRamp again.`
    );
  }

  try {
    // Recheck immediately before elevation, then remove the override from the
    // child environment as a second boundary against path substitution while
    // the interactive prompt was open.
    if (xcodeDeveloperDirIsExplicit(environment)) {
      throw explicitDeveloperDirSetupError(environment, invocation);
    }
    const privilegedEnv = { ...environment.env };
    delete privilegedEnv.DEVELOPER_DIR;
    const commandOptions = { inheritInput: true };
    if (!license) {
      commandOptions.activityLabel = 'Xcode is still completing first-launch setup';
    }
    await runCommand(
      invocation.command,
      invocation.args,
      options.cwd,
      privilegedEnv,
      commandOptions
    );
  } catch (error) {
    throw new Error(
      `Xcode ${license ? 'license review' : 'first-launch setup'} did not complete: `
      + `${error.message}. Run \`${invocation.display}\` in an interactive Terminal, `
      + 'then run OnRamp again.'
    );
  }
}

async function ensureXcodeSetup(environment, options = {}) {
  const captureCommand = options.captureCommand || capture;
  const log = options.log || console.log;
  let firstLaunchResult = xcodeCapture(
    environment,
    ['-checkFirstLaunchStatus'],
    captureCommand
  );
  let sdkResult = xcodeCapture(environment, ['-showsdks'], captureCommand);
  if (sdkResult.status !== 0 && xcodeLicenseIsRequired(sdkResult)) {
    await runXcodeSetupAction(environment, '-license', options);
    sdkResult = xcodeCapture(environment, ['-showsdks'], captureCommand);
    if (sdkResult.status !== 0 && xcodeLicenseIsRequired(sdkResult)) {
      const invocation = xcodeSetupInvocation(environment, '-license');
      const detail = xcodeResultOutput(sdkResult);
      throw new Error(
        'Xcode still reports that its license agreements have not been accepted'
        + `${detail ? `: ${detail}` : '.'} `
        + `Run \`${invocation.display}\` in an interactive Terminal, then run OnRamp again.`
      );
    }
    if (sdkResult.status !== 0) {
      throw failedXcodeCommand(environment, ['-showsdks'], sdkResult);
    }
    log('✓ Xcode license agreements are accepted');
    firstLaunchResult = xcodeCapture(
      environment,
      ['-checkFirstLaunchStatus'],
      captureCommand
    );
  }

  // A failed SDK probe that is not the recognized license diagnostic must
  // stop here. `-runFirstLaunch` also accepts Apple's license, so never use it
  // as a generic repair while license state is ambiguous.
  if (sdkResult.status !== 0) {
    throw failedXcodeCommand(environment, ['-showsdks'], sdkResult);
  }

  if (firstLaunchResult.status !== 0) {
    await runXcodeSetupAction(environment, '-runFirstLaunch', options);
    firstLaunchResult = xcodeCapture(
      environment,
      ['-checkFirstLaunchStatus'],
      captureCommand
    );
    if (firstLaunchResult.status !== 0) {
      const invocation = xcodeSetupInvocation(environment, '-runFirstLaunch');
      const detail = xcodeResultOutput(firstLaunchResult);
      throw new Error(
        'Xcode first-launch setup is still incomplete'
        + `${detail ? `: ${detail}` : '.'} Run \`${invocation.display}\` in an `
        + 'interactive Terminal, then run OnRamp again.'
      );
    }
    log('✓ Xcode first-launch components are installed');
    sdkResult = xcodeCapture(environment, ['-showsdks'], captureCommand);
  }

  if (sdkResult.status !== 0) {
    if (xcodeLicenseIsRequired(sdkResult)) {
      const invocation = xcodeSetupInvocation(environment, '-license');
      throw new Error(
        'Xcode license review is required before iOS development can continue. '
        + `Run \`${invocation.display}\` in an interactive Terminal, then run OnRamp again.`
      );
    }
    throw failedXcodeCommand(environment, ['-showsdks'], sdkResult);
  }
}

function finishIosDoctor(
  environment,
  captureCommand = capture,
  log = console.log
) {
  const podVersion = captureCommand(environment.pod, ['--version'], {
    env: environment.env,
  }).stdout.trim();
  log(`Using CocoaPods ${podVersion}`);
  log('✓ iOS environment is ready');
}

function doctorIos(options = {}) {
  const captureCommand = options.captureCommand || capture;
  const environment = (options.inspectEnvironment || inspectIosEnvironment)();
  const firstLaunchResult = xcodeCapture(
    environment,
    ['-checkFirstLaunchStatus'],
    captureCommand
  );
  const sdkResult = xcodeCapture(environment, ['-showsdks'], captureCommand);
  if (sdkResult.status !== 0 && xcodeLicenseIsRequired(sdkResult)) {
    const invocation = xcodeSetupInvocation(environment, '-license');
    throw new Error(
      'Xcode license review is required before iOS development can continue. '
      + `Run \`${invocation.display}\` in an interactive Terminal.`
    );
  }
  if (sdkResult.status !== 0) {
    throw failedXcodeCommand(environment, ['-showsdks'], sdkResult);
  }
  if (firstLaunchResult.status !== 0) {
    const invocation = xcodeSetupInvocation(environment, '-runFirstLaunch');
    throw new Error(
      'Xcode first-launch setup is required before iOS development can continue. '
      + `Run \`${invocation.display}\` in an interactive Terminal.`
    );
  }
  finishIosDoctor(environment, captureCommand, options.log || console.log);
  return environment;
}

async function prepareIosEnvironment(options = {}) {
  let environment;
  const customDoctor = options.doctor;
  try {
    environment = (customDoctor || inspectIosEnvironment)();
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

  // Preserve the existing injectable doctor contract used by callers and
  // tests: a successful replacement doctor has already completed its checks.
  if (customDoctor) {
    return environment;
  }
  await ensureXcodeSetup(environment, options);
  finishIosDoctor(
    environment,
    options.captureCommand || capture,
    options.log || console.log
  );
  return environment;
}

/*
 * Xcode's legal agreement and privileged first-launch work must happen before
 * native generation. Component checks below remain as a fallback for partial
 * or damaged Xcode installations discovered only after a project exists.
 */
async function ensureXcodeComponents(environment, iosDir, options = {}) {
  console.log('Checking if Xcode components are properly installed...');
  const captureCommand = options.captureCommand || capture;
  const result = captureCommand(environment.xcodebuild, ['-list'], {
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
  await runXcodeSetupAction(environment, '-runFirstLaunch', {
    ...options,
    cwd: iosDir,
  });
  const verified = captureCommand(environment.xcodebuild, ['-list'], {
    cwd: iosDir,
    env: environment.env,
    check: false,
  });
  if (verified.status !== 0) {
    throw failedXcodeCommand(environment, ['-list'], verified);
  }
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

function applyIosPodsCompatibilityAdjustments(iosDir, outputDir, environment) {
  applyFmtAppleClangWorkaround(iosDir, environment);
  const deploymentTargets = ensureIosPodsDeploymentTarget(iosDir, outputDir);
  if (deploymentTargets.raised > 0) {
    console.log(
      `✓ Raised ${deploymentTargets.raised} generated iOS Pod deployment settings `
      + `to React Native's ${deploymentTargets.minimum} minimum`,
    );
  }
}

function ensureIosPods(iosDir, environment, options = {}) {
  const outputDir = options.outputDir || path.dirname(iosDir);
  const nodeEnvironment = syncIosNodeEnvironment(iosDir);
  if (nodeEnvironment.changed) {
    console.log('✓ Xcode now uses the Node executable selected for this OnRamp run');
  } else if (nodeEnvironment.preservedCustom) {
    console.log('Preserving custom Xcode Node configuration; it must resolve to the supported Node 22 version.');
  }
  if (!options.force && iosPodsAreCurrent(iosDir, outputDir)) {
    console.log('✓ iOS Pods are current');
    applyIosPodsCompatibilityAdjustments(iosDir, outputDir, environment);
    return;
  }
  console.log('Ensuring iOS dependencies (Pods)...');
  run(environment.pod, ['install'], iosDir, environment.env);
  applyIosPodsCompatibilityAdjustments(iosDir, outputDir, environment);
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

function parseAvailableIosSimulatorDevices(output) {
  const data = JSON.parse(output);
  const devices = [];
  for (const [runtime, candidates] of Object.entries(data.devices || {})) {
    const match = runtime.match(/\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/);
    if (!match || !Array.isArray(candidates)) {
      continue;
    }
    const os = match[1].replaceAll('-', '.');
    for (const candidate of candidates) {
      if (
        candidate.isAvailable !== false
        && candidate.udid
        && candidate.name
      ) {
        devices.push({
          id: candidate.udid,
          name: candidate.name,
          os,
          state: candidate.state || null,
        });
      }
    }
  }
  return devices;
}

function availableIosSimulatorDevices(
  environment,
  captureCommand = capture
) {
  const result = captureCommand(
    environment.xcrun,
    ['simctl', 'list', '--json', 'devices', 'available'],
    { env: environment.env, check: false }
  );
  if (result.status !== 0) {
    return [];
  }
  try {
    return parseAvailableIosSimulatorDevices(result.stdout);
  } catch (_error) {
    return [];
  }
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

function iosRuntimeDownloadCachePath(home = os.homedir()) {
  return path.join(
    home,
    'Library',
    'Caches',
    'OnRamp',
    'ios-runtime-download.json'
  );
}

function iosRuntimeDownloadSignature(
  environment,
  preferred,
  installed,
  architectureVariant
) {
  return JSON.stringify({
    architectureVariant,
    installedBuild: installed && installed.build || null,
    installedVersion: installed && installed.version || null,
    preferredBuild: preferred && preferred.build || null,
    preferredVersion: preferred && preferred.version || null,
    xcode: environment.version && environment.version.display
      || environment.xcodebuild,
  });
}

function deferredIosRuntimeDownload(cachePath, signature, now = Date.now()) {
  if (!cachePath) {
    return null;
  }
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (
      cached.schemaVersion === 1
      && cached.signature === signature
      && Number(cached.retryAfter) > now
    ) {
      return cached;
    }
  } catch (_error) {
    // A missing or invalid advisory cache must never block native launch.
  }
  return null;
}

function deferIosRuntimeDownload(
  cachePath,
  signature,
  now = Date.now(),
  retryMs = IOS_RUNTIME_DOWNLOAD_RETRY_MS
) {
  if (!cachePath) {
    return null;
  }
  const temporary = `${cachePath}.${process.pid}.tmp`;
  const retryAfter = now + retryMs;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        retryAfter,
        schemaVersion: 1,
        signature,
      }) + '\n'
    );
    fs.renameSync(temporary, cachePath);
    return retryAfter;
  } catch (_error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch (_cleanupError) {
      // Ignore advisory cache cleanup failures.
    }
    return null;
  }
}

function clearIosRuntimeDownloadDeferral(cachePath) {
  if (!cachePath) {
    return;
  }
  try {
    fs.rmSync(cachePath, { force: true });
  } catch (_error) {
    // A stale advisory cache must never block native launch.
  }
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
  const cachePath = Object.hasOwn(options, 'runtimeDownloadCachePath')
    ? options.runtimeDownloadCachePath
    : iosRuntimeDownloadCachePath();
  const now = options.now || Date.now;
  const retryMs = options.runtimeDownloadRetryMs
    ?? IOS_RUNTIME_DOWNLOAD_RETRY_MS;
  const preferred = findPreferred(environment);
  let installed = inspect(environment);
  const cleanupReplacement = async replacement => {
    const removed = await (options.cleanupRuntimes || offerIosRuntimeCleanup)(
      environment,
      { ...options, replacement }
    );
    if (removed && removed.length > 0) installed = inspect(environment) || installed;
  };
  if (!preferred || installed === null) {
    log(
      'OnRamp could not determine Apple\'s newest compatible iOS '
      + 'Simulator runtime; continuing with Xcode\'s installed runtimes.'
    );
    return { changed: false, installed, preferred };
  }

  const existingPreferredRuntime = installed.find(runtime => (
    iosRuntimeMatchesPreferred(runtime, preferred)
  ));
  if (existingPreferredRuntime) {
    clearIosRuntimeDownloadDeferral(cachePath);
    log(
      '✓ Latest compatible iOS Simulator runtime is installed (iOS '
      + preferred.version
      + (preferred.build ? ', build ' + preferred.build : '') + ')'
    );
    // A previous run may have installed the replacement while cleanup was
    // declined. Reuse the same verification and separate consent on later runs.
    await cleanupReplacement(existingPreferredRuntime);
    return { changed: false, installed, preferred };
  }

  const current = installed.slice().sort((left, right) => (
    compareIosVersions(right.version, left.version)
  ))[0];
  const previousRuntimes = installed.map(runtime => ({ ...runtime }));
  const downloadSignature = iosRuntimeDownloadSignature(
    environment,
    preferred,
    current,
    architectureVariant
  );
  const deferred = current && deferredIosRuntimeDownload(
    cachePath,
    downloadSignature,
    now()
  );
  if (deferred) {
    log(
      'Xcode recently reported that its preferred '
      + iosRuntimeDescription(preferred)
      + ' could not be downloaded. Continuing with installed '
      + iosRuntimeDescription(current) + '; OnRamp will try this build '
      + 'again after ' + new Date(deferred.retryAfter).toISOString() + '.'
    );
    return { changed: false, installed, preferred };
  }

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
      'Xcode prefers iOS ' + preferred.version
      + ' Simulator runtime build ' + preferred.build
      + ' (installed ' + (current.build || 'unknown')
      + '). Try to download it now? This can be several GB. (y/N): '
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

  // Update approval does not imply first-time installation or cleanup approval.
  // Coordinated mobile --force passes cleanupObsolete separately.
  const forcedUpdate = Boolean(current) && options.forceEmulatorUpdates === true;
  if (forcedUpdate) {
    log(
      'Automatically approving the compatible iOS Simulator runtime update '
      + 'with --force; the download can be several GB.'
    );
  }
  const approved = forcedUpdate || await ask(question);
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
        const retryAfter = deferIosRuntimeDownload(
          cachePath,
          downloadSignature,
          now(),
          retryMs
        );
        log(
          'Xcode could not provide its preferred iOS Simulator runtime. '
          + 'Continuing with installed ' + iosRuntimeDescription(current)
          + (retryAfter
            ? '; OnRamp will try this build again after '
              + new Date(retryAfter).toISOString() + '.'
            : '.')
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
    clearIosRuntimeDownloadDeferral(cachePath);
    log('✓ iOS Simulator runtime ' + preferred.version + ' installed');
    await cleanupReplacement(matchingRuntime);
    return { changed: true, installed, preferred };
  }

  const usableRuntime = installed && installed.slice().sort((left, right) => (
    compareIosVersions(right.version, left.version)
  ))[0];
  if (usableRuntime) {
    const changed = !previousRuntimes.some(runtime => (
      runtime.identifier === usableRuntime.identifier
      && runtime.version === usableRuntime.version
      && runtime.build === usableRuntime.build
    ));
    log(
      'Xcode did not install the preferred runtime build. Continuing with '
      + iosRuntimeDescription(usableRuntime) + '.'
    );
    if (!changed) {
      deferIosRuntimeDownload(
        cachePath,
        downloadSignature,
        now(),
        retryMs
      );
    } else {
      await cleanupReplacement(usableRuntime);
    }
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

function resolveIosSimulatorApplication(
  environment,
  captureCommand = capture,
  pathExists = fs.existsSync
) {
  let developerDir = environment.developerDir;
  if (!developerDir) {
    const xcodeSelect = environment.xcodeSelect
      || findExecutable('xcode-select', environment.env);
    if (!xcodeSelect) {
      throw new Error('xcode-select was not found on PATH.');
    }
    developerDir = captureCommand(xcodeSelect, ['-p'], {
      env: environment.env,
    }).stdout.trim();
  }
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

  if (pathExists(simulatorApp)) {
    return { kind: 'simulator', path: simulatorApp };
  }
  if (pathExists(deviceHubApp)) {
    return { kind: 'device-hub', path: deviceHubApp };
  }
  throw new Error('Could not locate Simulator.app or DeviceHub.app.');
}

function iosHostKeyboardPreference(application) {
  if (application === 'device-hub') {
    return {
      // Device Hub is sandboxed. Xcode 27's supported defaults CLI form uses
      // its container and preferences domain as separate arguments.
      args: ['-container', 'com.apple.dt.Devices'],
      domain: 'com.apple.dt.Devices',
      guidance: 'Open Device Hub > Settings > Interaction and enable '
        + '“Always simulate hardware keyboard.” If this simulator is already '
        + 'connected, choose Device > Keyboard > Simulate Hardware Keyboard for '
        + 'that device.',
      key: 'alwaysSimulateHardwareKeyboard',
      label: 'Xcode Device Hub',
    };
  }
  if (application === 'simulator') {
    return {
      // Simulator predates the sandboxed Device Hub preferences container.
      args: [],
      domain: 'com.apple.iphonesimulator',
      guidance: 'Open Simulator and choose I/O > Keyboard > '
        + 'Connect Hardware Keyboard.',
      key: 'ConnectHardwareKeyboard',
      label: 'Simulator',
    };
  }
  throw new Error(`Unknown iOS simulator application: ${application}`);
}

function configureIosHostKeyboard(
  application,
  environment,
  captureCommand = capture,
  warn = console.warn,
  log = console.log
) {
  const preference = iosHostKeyboardPreference(application);
  const reportFailure = message => {
    const punctuation = /[.!?]$/.test(message) ? '' : '.';
    const explanation = `${message}${punctuation} ${preference.guidance}`;
    warn(`Warning: ${explanation}`);
    return { changed: false, enabled: false };
  };
  const readPreference = () => captureCommand(
    SYSTEM_DEFAULTS,
    [
      ...preference.args,
      'read',
      preference.domain,
      preference.key,
    ],
    { env: environment.env, check: false }
  );
  const isEnabled = result => (
    result.status === 0
    && ['1', 'true', 'yes'].includes(result.stdout.trim().toLowerCase())
  );

  try {
    const current = readPreference();
    if (isEnabled(current)) {
      log(
        application === 'device-hub'
          ? '✓ Xcode Device Hub hardware-keyboard default is enabled'
          : `✓ Mac keyboard input is enabled in ${preference.label}`
      );
      return { changed: false, enabled: true };
    }
  } catch (_error) {
    // A missing preference, inaccessible container, or older defaults command
    // may make the initial read fail. The narrow write below is still worth
    // attempting and is always followed by a fresh verification read.
  }

  let write;
  try {
    write = captureCommand(
      SYSTEM_DEFAULTS,
      [
        ...preference.args,
        'write',
        preference.domain,
        preference.key,
        '-bool',
        'true',
      ],
      { env: environment.env, check: false }
    );
  } catch (error) {
    return reportFailure(
      `OnRamp could not enable Mac keyboard input in ${preference.label}: `
      + `${error.message}.`
    );
  }

  if (write.status !== 0) {
    const detail = (write.stderr || write.stdout || '').trim();
    return reportFailure(
      `OnRamp could not enable Mac keyboard input in ${preference.label}`
      + `${detail ? `: ${detail}` : '.'}`
    );
  }

  let read;
  try {
    read = readPreference();
  } catch (error) {
    return reportFailure(
      `OnRamp updated ${preference.label}'s Mac keyboard setting, but could not `
      + `verify it: ${error.message}.`
    );
  }

  if (!isEnabled(read)) {
    const detail = (read.stderr || read.stdout || '').trim();
    return reportFailure(
      `OnRamp updated ${preference.label}'s Mac keyboard setting, but it did not `
      + `read back as enabled${detail ? ` (${detail})` : ''}.`
    );
  }

  log(
    application === 'device-hub'
      ? '✓ Xcode Device Hub hardware-keyboard default is enabled'
      : `✓ Mac keyboard input is enabled in ${preference.label}`
  );
  return { changed: true, enabled: true };
}

async function restartIosSimulatorForDeviceHubKeyboard(
  simulator,
  environment,
  options = {}
) {
  const captureCommand = options.captureCommand || capture;
  const delay = options.delay || wait;
  const now = options.now || Date.now;
  const simulatorState = options.simulatorState || iosSimulatorState;
  const timeoutMs = options.timeoutMs ?? IOS_SIMULATOR_SHUTDOWN_TIMEOUT_MS;
  const pollMs = options.pollMs ?? IOS_SIMULATOR_SHUTDOWN_POLL_MS;
  const initialState = options.initialState ?? simulatorState(
    simulator.id,
    environment,
    captureCommand
  );
  if (initialState !== 'Booted' && initialState !== 'Booting') {
    return {
      initialState,
      restarted: false,
      safeForNewConnection: initialState === 'Shutdown',
    };
  }

  const shutdown = captureCommand(
    environment.xcrun,
    ['simctl', 'shutdown', simulator.id],
    { env: environment.env, check: false }
  );
  let state = simulatorState(simulator.id, environment, captureCommand);
  if (shutdown.status !== 0 && state !== 'Shutdown') {
    const detail = (shutdown.stderr || shutdown.stdout || '').trim();
    return {
      detail,
      initialState,
      restarted: false,
      safeForNewConnection: false,
      state,
    };
  }

  const startedAt = now();
  while (state !== 'Shutdown' && now() - startedAt < timeoutMs) {
    await delay(pollMs);
    state = simulatorState(simulator.id, environment, captureCommand);
  }
  if (state !== 'Shutdown') {
    return {
      detail: `the exact simulator did not shut down within `
        + `${Math.round(timeoutMs / 1000)} seconds`,
      initialState,
      restarted: false,
      safeForNewConnection: false,
      state,
    };
  }

  return {
    initialState,
    restarted: true,
    safeForNewConnection: true,
    state,
  };
}

async function prepareIosHostKeyboard(
  simulator,
  environment,
  options = {}
) {
  const captureCommand = options.captureCommand || capture;
  const pathExists = options.pathExists || fs.existsSync;
  const warn = options.warn || console.warn;
  const log = options.log || console.log;
  const application = options.application || resolveIosSimulatorApplication(
    environment,
    captureCommand,
    pathExists
  );
  const preference = configureIosHostKeyboard(
    application.kind,
    environment,
    captureCommand,
    warn,
    log
  );
  if (application.kind !== 'device-hub' || !preference.enabled) {
    return {
      application,
      connectionVerified: preference.enabled,
      preference,
    };
  }

  const simulatorState = options.simulatorState || iosSimulatorState;
  let state = simulatorState(simulator.id, environment, captureCommand);
  let reconnect = {
    initialState: state,
    restarted: false,
    safeForNewConnection: state === 'Shutdown',
  };
  if (preference.changed && (state === 'Booted' || state === 'Booting')) {
    log(
      `Restarting ${simulator.name} so Xcode Device Hub applies its `
      + 'hardware-keyboard setting to a new connection...'
    );
    reconnect = await restartIosSimulatorForDeviceHubKeyboard(
      simulator,
      environment,
      {
        captureCommand,
        delay: options.delay,
        initialState: state,
        now: options.now,
        pollMs: options.pollMs,
        simulatorState,
        timeoutMs: options.timeoutMs,
      }
    );
    state = reconnect.state || state;
    if (reconnect.restarted) {
      log(`✓ ${simulator.name} disconnected safely for its keyboard update`);
    }
  }

  const connectionVerified = reconnect.safeForNewConnection;
  if (!connectionVerified) {
    const detail = reconnect.detail ? ` (${reconnect.detail})` : '';
    warn(
      `Warning: Xcode Device Hub's hardware-keyboard default is enabled, but `
      + `OnRamp cannot verify it for the existing ${simulator.name} connection`
      + `${detail}. In Device Hub, choose Device > Keyboard > Simulate Hardware `
      + 'Keyboard for that device.'
    );
  }
  return {
    application,
    connectionVerified,
    preference,
    reconnect,
    state,
  };
}

function showIosSimulator(
  simulator,
  environment,
  captureCommand = capture,
  pathExists = fs.existsSync,
  preparedApplication = null
) {
  const application = preparedApplication || resolveIosSimulatorApplication(
    environment,
    captureCommand,
    pathExists
  );
  if (!preparedApplication) {
    // Keep direct callers compatible, but never describe Device Hub's default
    // as proof that an already-connected device adopted it. The normal launch
    // path configures and, when needed, reconnects before simulator boot.
    const preference = configureIosHostKeyboard(
      application.kind,
      environment,
      captureCommand
    );
    if (application.kind === 'device-hub' && preference.enabled) {
      console.warn(
        `Warning: Xcode Device Hub's hardware-keyboard default is enabled, but `
        + `OnRamp cannot verify it for the existing ${simulator.name} connection. `
        + 'In Device Hub, choose Device > Keyboard > Simulate Hardware Keyboard '
        + 'for that device.'
      );
    }
  }

  let result;
  if (application.kind === 'simulator') {
    result = captureCommand(
      'open',
      [application.path, '--args', '-CurrentDeviceUDID', simulator.id],
      { env: environment.env, check: false }
    );
    if (result.status === 0) {
      activateIosSimulator(environment, captureCommand);
    }
  } else if (application.kind === 'device-hub') {
    result = captureCommand(
      'open',
      [`devices://device/open?id=${simulator.id}`],
      { env: environment.env, check: false }
    );
  } else {
    throw new Error(`Unknown iOS simulator application: ${application.kind}`);
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

function startIosPasteboardSync(
  simulator,
  environment,
  options = {}
) {
  const captureCommand = options.captureCommand || capture;
  const spawnCommand = options.spawnCommand || spawn;
  const warn = options.warn || console.warn;
  const log = options.log || console.log;
  const sessionSeconds = options.sessionSeconds
    || IOS_PASTEBOARD_SYNC_SESSION_SECONDS;
  const reportUnavailable = detail => {
    warn(
      `Warning: OnRamp could not prepare clipboard sharing for `
      + `${simulator.name}${detail ? `: ${detail}` : '.'} Reopen the selected `
      + 'simulator in Device Hub and try again.'
    );
    return null;
  };
  let info;
  try {
    info = captureCommand(
      environment.xcrun,
      [
        'devicectl',
        'device',
        'pasteboard',
        'info',
        '--device',
        simulator.id,
        '--timeout',
        '5',
        '--quiet',
      ],
      { env: environment.env, check: false }
    );
  } catch (error) {
    return reportUnavailable(error.message);
  }
  if (info.status !== 0) {
    return reportUnavailable((info.stderr || info.stdout || '').trim());
  }

  let child;
  try {
    child = spawnCommand(
      environment.xcrun,
      [
        'devicectl',
        'device',
        'pasteboard',
        'sync-with-host',
        '--device',
        simulator.id,
        '--session-timeout',
        String(sessionSeconds),
        '--timeout',
        String(sessionSeconds + 1),
        '--quiet',
      ],
      {
        env: childEnvironment(environment.env),
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
  } catch (error) {
    return reportUnavailable(error.message);
  }
  let stopped = false;
  let failure = '';
  if (child.stderr) {
    child.stderr.on('data', chunk => {
      failure = `${failure}${chunk}`.slice(-4096);
    });
  }
  const stop = signal => {
    if (stopped || child.exitCode !== null) {
      return;
    }
    stopped = true;
    child.kill(signal || 'SIGTERM');
  };
  child.once('error', error => {
    if (!stopped) {
      warn(
        `Warning: iOS clipboard sharing could not start for ${simulator.name}: `
        + error.message
      );
    }
  });
  child.once('exit', (code, signal) => {
    if (stopped) {
      return;
    }
    const detail = failure.trim();
    warn(
      `Warning: iOS clipboard sharing stopped unexpectedly for ${simulator.name}`
      + `${code !== null ? ` with status ${code}` : ''}`
      + `${signal ? ` after signal ${signal}` : ''}`
      + `${detail ? `: ${detail}` : '.'}`
    );
  });
  log(`✓ Mac and ${simulator.name} clipboards are synchronized`);
  return { child, stop };
}

function attachIosPasteboardSync(metro, pasteboardSync) {
  if (!pasteboardSync) {
    return metro;
  }
  const stopMetro = metro.stop;
  metro.stop = signal => {
    pasteboardSync.stop(signal || 'SIGTERM');
    stopMetro(signal);
  };
  metro.child.once('exit', () => pasteboardSync.stop('SIGTERM'));
  metro.pasteboardSync = pasteboardSync;
  return metro;
}

function waitForIosProductionPasteboardSync(pasteboardSync, signalEmitter = process) {
  if (!pasteboardSync?.child || pasteboardSync.child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const finish = signal => {
      signalEmitter.removeListener('SIGINT', onInterrupt);
      signalEmitter.removeListener('SIGTERM', onTerminate);
      signalEmitter.removeListener('SIGHUP', onHangup);
      pasteboardSync.child.removeListener('exit', onExit);
      pasteboardSync.child.removeListener('error', onExit);
      if (signal) pasteboardSync.stop(signal);
      resolve();
    };
    const onInterrupt = () => finish('SIGINT');
    const onTerminate = () => finish('SIGTERM');
    const onHangup = () => finish('SIGHUP');
    const onExit = () => finish();
    signalEmitter.once('SIGINT', onInterrupt);
    signalEmitter.once('SIGTERM', onTerminate);
    signalEmitter.once('SIGHUP', onHangup);
    pasteboardSync.child.once('exit', onExit);
    pasteboardSync.child.once('error', onExit);
  });
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
  if (installedRuntimes && !installedRuntimes.includes(selected.os)) {
    await (options.cleanupRuntimes || offerIosRuntimeCleanup)(environment, {
      ...options,
      simulatorId: selected.id,
    });
  }
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
  environment,
  configuration = 'Debug'
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
      configuration,
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

function iosProjectBundleIdentifier(iosDir) {
  for (const entry of fs.readdirSync(iosDir).sort()) {
    if (!entry.endsWith('.xcodeproj')) {
      continue;
    }
    const projectPath = path.join(iosDir, entry, 'project.pbxproj');
    if (!fs.existsSync(projectPath)) {
      continue;
    }
    const match = fs.readFileSync(projectPath, 'utf8').match(
      /\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^;"\s]+)"?\s*;/
    );
    if (match && !match[1].includes('$(')) {
      return match[1];
    }
  }
  return null;
}

function resolvedIosBundleIdentifier(
  outputDir,
  iosDir,
  nativeConfig,
  nativeName,
  simulatorId,
  environment
) {
  return nativeConfig?.ios.bundleIdentifier
    || iosProjectBundleIdentifier(iosDir)
    || iosBundleIdentifier(iosDir, nativeName, simulatorId, environment);
}

function iosAppIsInstalled(
  simulatorId,
  bundleIdentifier,
  environment,
  captureCommand = capture
) {
  const result = captureCommand(
    environment.xcrun,
    [
      'simctl',
      'get_app_container',
      simulatorId,
      bundleIdentifier,
      'app',
    ],
    { env: environment.env, check: false }
  );
  return result.status === 0 && result.stdout.trim().endsWith('.app');
}

function iosJsLocation(metroPort) {
  // iOS 26 simulator runtimes can repeatedly drop React Native's Fast Refresh
  // connection when localhost resolves over both IPv4 and IPv6. OnRamp's iOS
  // launcher targets simulators, whose numeric loopback reaches host Metro
  // without invoking that hostname-resolution path.
  return `127.0.0.1:${metroPort}`;
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
  forceEmulatorUpdates = false,
  cleanupObsolete = false,
  environment: appEnvironment,
  production = false,
}) {
  const outputDir = path.resolve(output || process.cwd());
  console.log(production ? 'Preparing iOS production Release run...' : 'Preparing iOS development...');
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

  const native = await addNativePlatforms({
    platform: 'ios',
    name,
    output: outputDir,
    environment: appEnvironment,
  });
  const iosDir = path.join(outputDir, 'ios');
  await ensureXcodeComponents(environment, iosDir);
  console.log('Checking for the latest compatible iOS Simulator runtime...');
  await ensurePreferredIosSimulatorRuntime(environment, {
    cwd: iosDir,
    forceEmulatorUpdates,
    cleanupObsolete,
  });
  ensureIosPods(iosDir, environment, { outputDir });
  console.log('Checking for an eligible iOS simulator...');
  const nativeName = nativeAppName(outputDir);
  const directCandidates = availableIosSimulatorDevices(environment);
  let simulator;
  if (directCandidates.length > 0) {
    simulator = selectIosSimulator(
      directCandidates,
      environment,
      new Set(
        directCandidates
          .filter(candidate => candidate.state === 'Booted')
          .map(candidate => candidate.id)
      )
    );
    console.log(`Using ${simulator.name} (iOS ${simulator.os}, ${simulator.id})`);
  } else {
    simulator = await ensureEligibleIosSimulator(
      iosDir,
      nativeName,
      environment,
      { cleanupObsolete }
    );
  }
  if (cleanupObsolete) {
    // A rejected preferred download or its cooldown must not suppress cleanup
    // once an actually usable replacement has been selected and verified.
    await offerIosRuntimeCleanup(environment, { cleanupObsolete, simulatorId: simulator.id });
  }
  const hostKeyboard = await prepareIosHostKeyboard(
    simulator,
    environment
  );
  const bundleIdentifier = production
    ? iosBundleIdentifier(iosDir, nativeName, simulator.id, environment, 'Release')
    : resolvedIosBundleIdentifier(
      outputDir,
      iosDir,
      native.nativeConfig,
      nativeName,
      simulator.id,
      environment
    );
  return {
    bundleIdentifier,
    environment,
    hostKeyboard,
    outputDir,
    simulator,
    simulatorApplication: hostKeyboard.application,
  };
}

function productionIosRunArgs(simulatorId, nativeName) {
  return [
    'react-native',
    'run-ios',
    '--udid',
    simulatorId,
    '--scheme',
    nativeName,
    '--mode',
    'Release',
    '--no-packager',
  ];
}

async function launchPreparedIosProduction(prepared, dependencies = {}) {
  const {
    bundleIdentifier,
    environment,
    hostKeyboard,
    outputDir,
    simulator,
    simulatorApplication,
  } = prepared;
  const runCommand = dependencies.runCommand || runAsync;
  const isInstalled = dependencies.isInstalled || iosAppIsInstalled;
  const openSimulator = dependencies.openSimulator || showIosSimulator;
  const startPasteboardSync = dependencies.startPasteboardSync || startIosPasteboardSync;
  const waitForPasteboardSync = dependencies.waitForPasteboardSync || waitForIosProductionPasteboardSync;
  console.log('Building and installing the iOS Release app without Metro...');
  await runCommand(
    'npx',
    productionIosRunArgs(simulator.id, nativeAppName(outputDir)),
    outputDir,
    environment.env,
    { activityLabel: 'Xcode is building and installing the Release app' }
  );
  if (!isInstalled(simulator.id, bundleIdentifier, environment)) {
    throw new Error(`The iOS Release app (${bundleIdentifier}) was not installed on the selected simulator.`);
  }
  const application = simulatorApplication
    || hostKeyboard?.application
    || resolveIosSimulatorApplication(environment);
  openSimulator(simulator, environment, capture, fs.existsSync, application);
  if (application.kind === 'device-hub' && hostKeyboard?.connectionVerified) {
    console.log(`✓ Mac keyboard input is enabled for ${simulator.name} in Xcode Device Hub`);
  }
  console.log(`iOS production app launched (${bundleIdentifier}). No local backend or Metro is running.`);
  if (application.kind === 'device-hub') {
    const pasteboardSync = startPasteboardSync(simulator, environment);
    if (pasteboardSync) {
      console.log('Clipboard sharing remains active while this command is open. Press Ctrl+C to stop sharing; the app stays installed.');
      await waitForPasteboardSync(pasteboardSync);
    }
  }
}

async function launchPreparedIos(
  prepared,
  {
    metroPort,
    metroStartingPort,
    metroInteractive = true,
    metroLabel,
    rebuild = false,
  } = {}
) {
  const {
    bundleIdentifier,
    environment,
    hostKeyboard,
    outputDir,
    simulator,
    simulatorApplication,
  } = prepared;
  const resolvedSimulatorApplication = simulatorApplication
    || hostKeyboard?.application
    || resolveIosSimulatorApplication(environment);
  const resolvedHostKeyboard = hostKeyboard || await prepareIosHostKeyboard(
    simulator,
    environment,
    { application: resolvedSimulatorApplication }
  );
  console.log('Starting iOS simulator...');
  ensureIosSimulatorBooted(simulator, environment);
  showIosSimulator(
    simulator,
    environment,
    capture,
    fs.existsSync,
    resolvedSimulatorApplication
  );
  if (
    resolvedSimulatorApplication.kind === 'device-hub'
    && resolvedHostKeyboard?.connectionVerified
  ) {
    console.log(
      `✓ Mac keyboard input is enabled for ${simulator.name} in Xcode Device Hub`
    );
  }
  const metro = await startMetro({
    output: outputDir,
    requestedPort: metroPort,
    startingPort: metroStartingPort,
    env: environment.env,
    interactive: metroInteractive,
    label: metroLabel,
  });
  console.log(`Using Metro port ${metro.port}`);
  try {
    if (resolvedSimulatorApplication.kind === 'device-hub') {
      attachIosPasteboardSync(
        metro,
        startIosPasteboardSync(simulator, environment)
      );
    }
    await warmMetroBundle({ port: metro.port, platform: 'ios' });
    const fingerprint = nativeBuildFingerprint(outputDir, 'ios');
    const cached = cachedNativeBuild(outputDir, 'ios');
    const reuseInstalled = (
      !rebuild
      && cached
      && cached.fingerprint === fingerprint
      && cached.bundleIdentifier === bundleIdentifier
      && cached.simulatorId === simulator.id
      && iosAppIsInstalled(
        simulator.id,
        bundleIdentifier,
        environment
      )
    );
    if (reuseInstalled) {
      console.log(
        '✓ iOS native inputs are unchanged; opening the installed app without rebuilding'
      );
    } else {
      console.log('Building and installing the iOS app...');
      console.log(
        'Xcode may be quiet while finalizing build settings; OnRamp will keep reporting activity.'
      );
      await runAsync(
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
        {
          activityLabel: 'Xcode is still building, finalizing, and installing',
          inheritInput: metroInteractive,
        }
      );
    }
    launchIosWithMetro(
      simulator.id,
      bundleIdentifier,
      metro.port,
      environment
    );
    if (!reuseInstalled) {
      recordNativeBuild(outputDir, 'ios', {
        bundleIdentifier,
        simulatorId: simulator.id,
      });
    }
    activateIosSimulator(environment);
    console.log('iOS app launched. Metro remains active; press Ctrl+C to stop.');
    return metro;
  } catch (error) {
    metro.stop('SIGTERM');
    throw error;
  }
}

async function runIos(options, dependencies = {}) {
  const prepare = dependencies.prepareIosDevelopment || prepareIosDevelopment;
  const prepared = await prepare(options);
  if (options.production) {
    const launchProduction = dependencies.launchPreparedIosProduction || launchPreparedIosProduction;
    await launchProduction(prepared);
    return null;
  }
  const nativeBuildBaseline = {
    ios: nativeBuildFingerprint(prepared.outputDir, 'ios'),
  };
  const metro = await launchPreparedIos(prepared, {
    metroPort: options.metroPort,
    rebuild: options.rebuild,
  });
  metro.nativeBuildBaseline = nativeBuildBaseline;
  return metro;
}

async function repairIos({ name, output, fresh = false }) {
  const outputDir = path.resolve(output || process.cwd());
  console.log('Repairing iOS development files...');
  clearNativeBuildState(outputDir, 'ios');
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
  attachIosPasteboardSync,
  waitForIosProductionPasteboardSync,
  availableIosSimulatorDevices,
  availableIosSimulatorRuntimes,
  availableIosSimulatorRuntimeVersions,
  doctorIos,
  configureIosHostKeyboard,
  ensureEligibleIosSimulator,
  ensureIosSimulatorBooted,
  ensurePreferredIosSimulatorRuntime,
  ensureIosPods,
  ensureXcodeComponents,
  ensureXcodeSetup,
  iosBundleIdentifier,
  iosAppIsInstalled,
  iosJsLocation,
  iosProjectBundleIdentifier,
  iosPodsAreCurrent,
  launchPreparedIosProduction,
  iosRuntimeArchitectureVariant,
  launchIosWithMetro,
  parseAvailableIosSimulatorRuntimeVersions,
  parseAvailableIosSimulatorRuntimes,
  parseAvailableIosSimulatorDevices,
  parseBuildSetting,
  parseIosSimulatorState,
  parsePreferredIosSimulatorRuntime,
  preferredIosSimulatorRuntime,
  productionIosRunArgs,
  launchPreparedIos,
  prepareIosDevelopment,
  prepareIosEnvironment,
  prepareIosHostKeyboard,
  queryEligibleIosSimulatorsWithRetry,
  repairIos,
  resolveIosSimulatorApplication,
  resolveSelectedDeveloperDir,
  restartIosSimulatorForDeviceHubKeyboard,
  runIos,
  selectIosSimulator,
  showIosSimulator,
  startIosPasteboardSync,
};
