const fs = require('fs');
const path = require('path');
const {
  doctorAndroid,
  launchPreparedAndroid,
  prepareAndroidDevelopment,
  runAndroid,
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

function nodeVersionTuple() {
  return process.versions.node
    .split('.')
    .slice(0, 3)
    .map(value => Number(value) || 0);
}

function doctorWeb() {
  const [major, minor, patch] = nodeVersionTuple();
  const minimumSatisfied = (
    major === 20
    && (minor > 19 || (minor === 19 && patch >= 4))
  );
  if (!minimumSatisfied) {
    throw new Error(
      `Node.js 20.19.4 or newer on the Node 20 line is required; found ${process.versions.node}.`
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
  launchPreparedAndroid,
  launchPreparedIos,
  prepareAndroidDevelopment,
  prepareIosDevelopment,
}) {
  if (options.metroPort >= 65535) {
    throw new Error('Mobile development requires two available Metro ports.');
  }
  console.log(
    'Checking iOS and Android prerequisites before starting either app...'
  );
  const preparationOptions = {
    name: options.name,
    output: options.output,
    watchDiagnostics: options.watchDiagnostics,
  };
  const preparedIos = await runners.prepareIosDevelopment(
    preparationOptions
  );
  const preparedAndroid = await runners.prepareAndroidDevelopment(
    preparationOptions
  );
  console.log('✓ Mobile prerequisites are ready');

  let iosMetro;
  try {
    iosMetro = await runners.launchPreparedIos(preparedIos, {
      metroPort: options.metroPort,
      metroInteractive: false,
      metroLabel: 'iOS',
    });
    if (!iosMetro || !Number.isInteger(iosMetro.port)) {
      throw new Error('The iOS Metro server did not report its port.');
    }
    if (iosMetro.port >= 65535) {
      throw new Error('Mobile development requires two available Metro ports.');
    }
    const androidMetro = await runners.launchPreparedAndroid(
      preparedAndroid,
      {
        metroStartingPort: iosMetro.port + 1,
        metroInteractive: false,
        metroLabel: 'Android',
      }
    );
    return { android: androidMetro, ios: iosMetro };
  } catch (error) {
    if (iosMetro) {
      iosMetro.stop('SIGTERM');
    }
    throw error;
  }
}

async function runFrontend({ platform, name, output, metroPort, watchDiagnostics }) {
  const outputDir = path.resolve(output || process.cwd());
  requireFrontend(outputDir);
  doctorWeb();

  if (platform === 'web') {
    if (metroPort !== undefined) {
      throw new Error('--metro-port is only valid for iOS, Android, or mobile runs.');
    }
    if (watchDiagnostics) {
      throw new Error('--watch-diagnostics is only valid for iOS, Android, or mobile runs.');
    }
    runWeb(outputDir);
    return;
  }
  if (platform === 'ios') {
    await runIos({ name, output: outputDir, metroPort, watchDiagnostics });
    return;
  }
  if (platform === 'android') {
    await runAndroid({ name, output: outputDir, metroPort, watchDiagnostics });
    return;
  }
  if (platform === 'mobile') {
    await runMobile({ name, output: outputDir, metroPort, watchDiagnostics });
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
  repairFrontend,
  runFrontend,
  runMobile,
  runWeb,
};
