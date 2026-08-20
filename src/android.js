const fs = require('fs');
const os = require('os');
const path = require('path');
const { addNativePlatforms } = require('./native');
const { startMetro, warmMetroBundle } = require('./metro');
const { capture, findExecutable, prependPath, run } = require('./process');

function findAndroidSdk(env) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  const home = os.homedir();

  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Android', 'sdk'));
  } else if (process.platform === 'win32') {
    candidates.push(path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk'));
  } else {
    candidates.push(
      path.join(home, 'Android', 'Sdk'),
      '/opt/android-sdk',
      '/usr/local/android-sdk'
    );
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const sdk = path.resolve(candidate);
    if (fs.existsSync(path.join(sdk, 'platform-tools'))) {
      return sdk;
    }
  }
  return null;
}

function javaMajor(javaHome) {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const java = path.join(javaHome, 'bin', executable);
  if (!fs.existsSync(java)) {
    return null;
  }

  try {
    const result = capture(java, ['-version']);
    const match = `${result.stderr}${result.stdout}`.match(/version "(?:1\.)?(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

function findJdk17(env) {
  const candidates = [env.JAVA_HOME];

  if (process.platform === 'darwin') {
    try {
      const result = capture('/usr/libexec/java_home', ['-v', '17']);
      candidates.push(result.stdout.trim());
    } catch (_error) {
      // Continue through the known installation locations.
    }
    candidates.push(
      '/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home',
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      path.join(
        env.ProgramFiles || 'C:\\Program Files',
        'Android',
        'Android Studio',
        'jbr'
      )
    );
  } else {
    candidates.push(
      '/usr/lib/jvm/java-17-openjdk',
      '/usr/lib/jvm/java-17-openjdk-amd64',
      '/usr/lib/jvm/java-17-openjdk-arm64',
      '/opt/android-studio/jbr'
    );
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const javaHome = path.resolve(candidate);
    if (javaMajor(javaHome) === 17) {
      return javaHome;
    }
  }
  return null;
}

function resolveAndroidEnvironment() {
  const env = { ...process.env };
  const sdk = findAndroidSdk(env);
  if (!sdk) {
    throw new Error('Android SDK not found. Install it once with Android Studio, then try again.');
  }

  env.ANDROID_HOME = sdk;
  env.ANDROID_SDK_ROOT = sdk;
  prependPath(
    env,
    path.join(sdk, 'platform-tools'),
    path.join(sdk, 'emulator'),
    path.join(sdk, 'cmdline-tools', 'latest', 'bin'),
    path.join(sdk, 'tools', 'bin')
  );

  const adb = findExecutable('adb', env);
  const emulator = findExecutable('emulator', env);
  if (!adb || !emulator) {
    throw new Error('The Android SDK is missing its platform-tools or emulator package.');
  }

  const javaHome = findJdk17(env);
  if (!javaHome) {
    throw new Error('JDK 17 was not found. React Native Android builds require JDK 17.');
  }
  env.JAVA_HOME = javaHome;
  prependPath(env, path.join(javaHome, 'bin'));

  const avdResult = capture(emulator, ['-list-avds'], { env });
  const avds = avdResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (avds.length === 0) {
    throw new Error('No Android virtual device is installed. Create one once with Android Studio.');
  }

  console.log(`Using Android SDK at ${sdk}`);
  console.log(`Using JDK 17 at ${javaHome}`);
  console.log(`Using Android virtual device ${avds[0]}`);
  return { adb, avd: avds[0], env, javaHome, sdk };
}

function wakeAndroidEmulators(adb, env) {
  let result;
  try {
    result = capture(adb, ['devices'], { env });
  } catch (_error) {
    return;
  }

  const emulators = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => (
      fields.length >= 2
      && fields[0].startsWith('emulator-')
      && fields[1] === 'device'
    ))
    .map(fields => fields[0]);

  for (const serial of emulators) {
    for (const command of [
      ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['shell', 'wm', 'dismiss-keyguard'],
      ['shell', 'svc', 'power', 'stayon', 'true'],
    ]) {
      capture(adb, ['-s', serial, ...command], { env, check: false });
    }
    console.log(`✓ Android emulator ${serial} is awake and unlocked`);
  }
}

function doctorAndroid() {
  const environment = resolveAndroidEnvironment();
  console.log('✓ Android environment is ready');
  return environment;
}

async function runAndroid({
  name,
  output,
  metroPort,
  metroStartingPort,
  watchDiagnostics = false,
}) {
  const outputDir = path.resolve(output || process.cwd());
  console.log('Preparing Android development...');
  const environment = resolveAndroidEnvironment();
  environment.env.ONRAMP_PLATFORM = 'android';
  if (watchDiagnostics) {
    environment.env.ONRAMP_WATCH_DIAGNOSTICS = '1';
  }
  await addNativePlatforms({ platform: 'android', name, output: outputDir });
  const metro = await startMetro({
    output: outputDir,
    requestedPort: metroPort,
    startingPort: metroStartingPort,
    env: environment.env,
  });
  console.log(`Using Node.js v${process.versions.node} environment`);
  console.log(`Using Metro port ${metro.port}`);
  try {
    await warmMetroBundle({ port: metro.port, platform: 'android' });
    run(
      'npx',
      [
        'react-native',
        'run-android',
        '--port',
        String(metro.port),
        '--no-packager',
      ],
      outputDir,
      environment.env
    );
    wakeAndroidEmulators(environment.adb, environment.env);
    console.log('Android app launched. Metro remains active; press Ctrl+C to stop.');
    return metro;
  } catch (error) {
    metro.stop('SIGTERM');
    throw error;
  }
}

module.exports = {
  doctorAndroid,
  resolveAndroidEnvironment,
  runAndroid,
  wakeAndroidEmulators,
};
