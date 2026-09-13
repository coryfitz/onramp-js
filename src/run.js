const fs = require('fs');
const path = require('path');
const {
  activateAndroidEmulator,
  doctorAndroid,
  launchPreparedAndroid,
  prepareAndroidDevelopment,
  reportAndroidEmulatorActivation,
  runAndroid,
  safelyActivateAndroidEmulator,
} = require('./android');
const {
  doctorIos,
  launchPreparedIos,
  prepareIosDevelopment,
  repairIos,
  runIos,
} = require('./ios');
const { findExecutable, run } = require('./process');
const { doctorWatchman } = require('./watchman');
const { normalizeEnvironment, writeRuntimeConfig } = require('./environment');
const { startNativeBuildWatch } = require('./native-build-watch');
const { nativeBuildFingerprint } = require('./native-build-cache');

function monitorNativeBuildInputs(
  outputDir,
  platform,
  session,
  starter = startNativeBuildWatch
) {
  try {
    return starter(outputDir, platform, session, {
      initialFingerprints: session && session.nativeBuildBaseline,
    });
  } catch (error) {
    console.warn(
      `Warning: OnRamp could not monitor native build inputs: ${error.message}`
    );
    return null;
  }
}

function nodeVersionTuple() {
  return process.versions.node
    .split('.')
    .slice(0, 3)
    .map(value => Number(value) || 0);
}

function doctorWeb() {
  const [major, minor, patch] = nodeVersionTuple();
  const minimumSatisfied = (
    major === 22
    && (minor > 15 || (minor === 15 && patch >= 0))
  );
  if (!minimumSatisfied) {
    throw new Error(
      `Node.js 22.15.0 or newer on the Node 22 line is required; found ${process.versions.node}.`
    );
  }
  if (!findExecutable('npm')) {
    throw new Error('npm was not found on PATH.');
  }
  console.log(`Using Node.js v${process.versions.node} environment`);
  console.log('✓ Web environment is ready');
}

function doctor(platform = 'all') {
  doctorWeb();
  if (platform === 'web') {
    return;
  }
  if (platform === 'ios') {
    doctorWatchman();
    doctorIos();
    return;
  }
  if (platform === 'android') {
    doctorWatchman();
    doctorAndroid();
    return;
  }
  if (platform === 'mobile' || platform === 'all') {
    doctorWatchman();
    doctorIos();
    doctorAndroid();
    return;
  }
  throw new Error('Doctor platform must be web, ios, android, mobile, or all.');
}

function requireFrontend(outputDir) {
  if (!fs.existsSync(path.join(outputDir, 'package.json'))) {
    throw new Error(`No OnRamp frontend found at ${outputDir}`);
  }
}

function runWeb(outputDir, runner = run) {
  runner('npm', ['run', 'start:web', '--', '--open'], outputDir);
}

async function runMobile(options, runners = {
  activateAndroidEmulator,
  launchPreparedAndroid,
  launchPreparedIos,
  prepareAndroidDevelopment,
  prepareIosDevelopment,
}) {
  if (options.metroPort >= 65535) {
    throw new Error('Mobile development requires two available Metro ports.');
  }
  console.log(
    'Checking Android and iOS prerequisites before starting either app...'
  );
  const preparationOptions = {
    name: options.name,
    output: options.output,
    watchDiagnostics: options.watchDiagnostics,
    environment: options.environment,
    forceEmulatorUpdates: options.forceEmulatorUpdates,
    cleanupObsolete: options.forceEmulatorUpdates === true,
  };
  const preparedAndroid = await runners.prepareAndroidDevelopment(
    preparationOptions
  );
  const preparedIos = await runners.prepareIosDevelopment(
    preparationOptions
  );
  console.log('✓ Mobile prerequisites are ready');
  const outputDir = path.resolve(options.output || process.cwd());
  const nativeBuildBaseline = {
    android: nativeBuildFingerprint(outputDir, 'android'),
    ios: nativeBuildFingerprint(outputDir, 'ios'),
  };

  let androidMetro;
  try {
    androidMetro = await runners.launchPreparedAndroid(preparedAndroid, {
      activateEmulator: runners.activateAndroidEmulator,
      metroPort: options.metroPort,
      metroInteractive: false,
      metroLabel: 'Android',
      platform: options.platform || process.platform,
      rebuild: options.rebuild,
    });
    if (!androidMetro || !Number.isInteger(androidMetro.port)) {
      throw new Error('The Android Metro server did not report its port.');
    }
    if (androidMetro.port >= 65535) {
      throw new Error('Mobile development requires two available Metro ports.');
    }
    const iosMetro = await runners.launchPreparedIos(
      preparedIos,
      {
        metroStartingPort: androidMetro.port + 1,
        metroInteractive: false,
        metroLabel: 'iOS',
        rebuild: options.rebuild,
      }
    );
    if (typeof runners.activateAndroidEmulator === 'function') {
      const environment = preparedAndroid.environment || preparedAndroid;
      const platform = options.platform || process.platform;
      const activation = safelyActivateAndroidEmulator(
        runners.activateAndroidEmulator,
        environment,
        { platform, serial: androidMetro.androidDevice }
      );
      reportAndroidEmulatorActivation(activation, environment, {
        afterIos: true,
        platform,
      });
    }
    return {
      android: androidMetro,
      ios: iosMetro,
      nativeBuildBaseline,
    };
  } catch (error) {
    if (androidMetro) {
      androidMetro.stop('SIGTERM');
    }
    throw error;
  }
}

async function runFrontend(
  {
    platform,
    name,
    output,
    metroPort,
    rebuild,
    forceEmulatorUpdates,
    watchDiagnostics,
    environment,
  },
  dependencies = {}
) {
  const doctorWebForRun = dependencies.doctorWeb || doctorWeb;
  const monitorNativeBuildInputsForRun = (
    dependencies.monitorNativeBuildInputs || monitorNativeBuildInputs
  );
  const runAndroidForRun = dependencies.runAndroid || runAndroid;
  const runIosForRun = dependencies.runIos || runIos;
  const runMobileForRun = dependencies.runMobile || runMobile;
  const runWebForRun = dependencies.runWeb || runWeb;
  const writeRuntimeConfigForRun = (
    dependencies.writeRuntimeConfig || writeRuntimeConfig
  );
  const outputDir = path.resolve(output || process.cwd());
  if (forceEmulatorUpdates && !['ios', 'android', 'mobile'].includes(platform)) {
    throw new Error('--force is only valid for iOS, Android, or mobile runs.');
  }
  requireFrontend(outputDir);
  doctorWebForRun();
  if (['ios', 'android', 'mobile'].includes(platform) && dependencies.maintainMobileStorage) {
    try {
      await dependencies.maintainMobileStorage();
    } catch (_) {
      console.warn('OnRamp storage maintenance was skipped; continuing with native launch.');
    }
  }
  const selectedEnvironment = normalizeEnvironment(environment);
  writeRuntimeConfigForRun(outputDir, selectedEnvironment, platform);
  process.env.ONRAMP_ENVIRONMENT = selectedEnvironment;

  if (platform === 'web') {
    if (metroPort !== undefined) {
      throw new Error('--metro-port is only valid for iOS, Android, or mobile runs.');
    }
    if (watchDiagnostics) {
      throw new Error('--watch-diagnostics is only valid for iOS, Android, or mobile runs.');
    }
    if (rebuild) {
      throw new Error('--rebuild is only valid for iOS, Android, or mobile runs.');
    }
    runWebForRun(outputDir);
    return;
  }
  if (platform === 'ios') {
    const session = await runIosForRun({
      name,
      output: outputDir,
      metroPort,
      rebuild,
      forceEmulatorUpdates,
      watchDiagnostics,
      environment: selectedEnvironment,
    });
    monitorNativeBuildInputsForRun(outputDir, platform, session);
    return;
  }
  if (platform === 'android') {
    const session = await runAndroidForRun({
      name,
      output: outputDir,
      metroPort,
      rebuild,
      forceEmulatorUpdates,
      watchDiagnostics,
      environment: selectedEnvironment,
    });
    monitorNativeBuildInputsForRun(outputDir, platform, session);
    return;
  }
  if (platform === 'mobile') {
    const session = await runMobileForRun({
      name,
      output: outputDir,
      metroPort,
      rebuild,
      forceEmulatorUpdates,
      watchDiagnostics,
      environment: selectedEnvironment,
    });
    monitorNativeBuildInputsForRun(outputDir, platform, session);
    return;
  }
  throw new Error('Run platform must be web, ios, android, or mobile.');
}

async function repairFrontend({ platform, name, output, fresh = false }) {
  doctorWeb();
  if (platform === 'ios') {
    await repairIos({ name, output, fresh });
    return;
  }
  throw new Error('Repair platform must be ios.');
}

module.exports = {
  doctor,
  doctorWeb,
  monitorNativeBuildInputs,
  repairFrontend,
  runFrontend,
  runMobile,
  runWeb,
};
