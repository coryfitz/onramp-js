const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseRepairArgs,
  parseRunArgs,
  parseUpgradeArgs,
} = require('../bin/onramp-js');
const { nextCommands, npmInstallArgs } = require('../src/create');
const {
  ensureEligibleIosSimulator,
  ensureIosSimulatorBooted,
  ensurePreferredIosSimulatorRuntime,
  iosJsLocation,
  iosPodsAreCurrent,
  parseAvailableIosSimulatorRuntimes,
  parseAvailableIosSimulatorRuntimeVersions,
  parseBuildSetting,
  parsePreferredIosSimulatorRuntime,
  prepareIosEnvironment,
  queryEligibleIosSimulatorsWithRetry,
  selectIosSimulator,
  showIosSimulator,
} = require('../src/ios');
const { nativeProjectName } = require('../src/native');
const { isPythonWrapper, run } = require('../src/process');
const { runMobile, runWeb } = require('../src/run');

test('parses a native Metro port separately from the output directory', () => {
  const options = parseRunArgs([
    'ios',
    '--output',
    '/tmp/example',
    '--metro-port',
    '9090',
  ]);

  assert.equal(options.platform, 'ios');
  assert.equal(options.metroPort, 9090);
  assert.equal(options.output, '/tmp/example');
});

test('parses native source watcher diagnostics', () => {
  const options = parseRunArgs(['ios', '--watch-diagnostics']);

  assert.equal(options.platform, 'ios');
  assert.equal(options.watchDiagnostics, true);
});

test('parses mobile as a native run target', () => {
  const options = parseRunArgs(['mobile', '--metro-port', '9090']);

  assert.equal(options.platform, 'mobile');
  assert.equal(options.metroPort, 9090);
});

test('parses a non-mutating frontend upgrade check', () => {
  const options = parseUpgradeArgs(['--output', '/tmp/example', '--check']);

  assert.equal(options.output, '/tmp/example');
  assert.equal(options.check, true);
});

test('rejects the removed dry-run upgrade option', () => {
  assert.throws(
    () => parseUpgradeArgs(['--dry-run']),
    /Unknown option: --dry-run/
  );
});

test('iOS repair preserves the lock by default and exposes explicit fresh mode', () => {
  assert.equal(parseRepairArgs(['ios']).fresh, false);
  assert.equal(parseRepairArgs(['ios', '--fresh']).fresh, true);
});

test('Python-wrapper command suggestions stay on the OnRamp interface', () => {
  const commands = nextCommands(
    '/tmp/staging/build',
    'web',
    true,
    '/tmp/example'
  );

  assert.ok(commands.some(command => command.startsWith('onramp ios')));
  assert.ok(commands.some(command => command.startsWith('onramp mobile')));
  assert.equal(
    commands.slice(1).every(command => command.startsWith('onramp ')),
    true
  );
  assert.equal(commands[0], 'cd /tmp/example');
});

test('Python-wrapper mode suppresses raw command descriptions', () => {
  const env = { ...process.env, ONRAMP_PYTHON_WRAPPER: '1' };
  const messages = [];
  const originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    assert.equal(isPythonWrapper(env), true);
    run(process.execPath, ['-e', ''], process.cwd(), env);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(messages, []);
});

test('Python-wrapper installs suppress npm audit and routine output', () => {
  const env = { ...process.env, ONRAMP_PYTHON_WRAPPER: '1' };
  const messages = [];
  const originalLog = console.log;
  console.log = message => messages.push(message);
  let result;
  try {
    result = run(
      process.execPath,
      ['-e', "process.stdout.write('internal npm output')"],
      process.cwd(),
      env,
      { quiet: true }
    );
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(messages, []);
  assert.equal(result.stdout, 'internal npm output');
  assert.deepEqual(
    npmInstallArgs(true),
    [
      'install',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
    ]
  );
});

test('standalone onramp-js retains raw command descriptions', () => {
  const env = { ...process.env };
  delete env.ONRAMP_PYTHON_WRAPPER;
  const messages = [];
  const originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    run(process.execPath, ['-e', ''], process.cwd(), env);
  } finally {
    console.log = originalLog;
  }

  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Running: /);
});

test('web development opens the selected local server in a browser', () => {
  const calls = [];
  runWeb('/tmp/example', (...args) => calls.push(args));

  assert.deepEqual(calls, [[
    'npm',
    ['run', 'start:web', '--', '--open'],
    '/tmp/example',
  ]]);
});

test('mobile runs iOS and Android on distinct Metro ports', async () => {
  const calls = [];
  const iosMetro = { port: 9090, stop: () => calls.push('stop-ios') };
  const androidMetro = { port: 9091, stop: () => calls.push('stop-android') };
  const result = await runMobile(
    { name: 'Example', output: '/tmp/example', metroPort: 9090 },
    {
      runIos: async options => {
        calls.push(['ios', options]);
        return iosMetro;
      },
      runAndroid: async options => {
        calls.push(['android', options]);
        return androidMetro;
      },
    }
  );

  assert.equal(calls[0][0], 'ios');
  assert.equal(calls[0][1].metroPort, 9090);
  assert.equal(calls[0][1].watchDiagnostics, undefined);
  assert.equal(calls[1][0], 'android');
  assert.equal(calls[1][1].metroStartingPort, 9091);
  assert.equal(calls[1][1].metroPort, undefined);
  assert.equal(calls[1][1].watchDiagnostics, undefined);
  assert.deepEqual(result, { android: androidMetro, ios: iosMetro });
});

test('mobile stops iOS Metro if Android startup fails', async () => {
  let stoppedWith;
  await assert.rejects(
    runMobile(
      { name: 'Example', output: '/tmp/example' },
      {
        runIos: async () => ({
          port: 8081,
          stop: signal => { stoppedWith = signal; },
        }),
        runAndroid: async () => { throw new Error('Android failed'); },
      }
    ),
    /Android failed/
  );

  assert.equal(stoppedWith, 'SIGTERM');
});

test('native names are stable identifiers derived from project directory names', () => {
  assert.equal(nativeProjectName('swerve-predict'), 'SwervePredict');
  assert.equal(nativeProjectName('123 app'), 'App123App');
});

test('extracts the product bundle identifier from Xcode build settings', () => {
  const output = [
    '    PRODUCT_NAME = SmokeApp',
    '    PRODUCT_BUNDLE_IDENTIFIER = org.example.SmokeApp',
  ].join('\n');

  assert.equal(
    parseBuildSetting(output, 'PRODUCT_BUNDLE_IDENTIFIER'),
    'org.example.SmokeApp'
  );
});

test('passes Metro to React Native as a host and port', () => {
  assert.equal(iosJsLocation(8082), 'localhost:8082');
});

test('recognizes only available iOS simulator runtimes', () => {
  const output = JSON.stringify({
    runtimes: [
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
        isAvailable: true,
        version: '18.6',
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-16-4',
        isAvailable: false,
        version: '16.4',
      },
      {
        identifier: 'com.apple.CoreSimulator.SimRuntime.tvOS-26-0',
        isAvailable: true,
        version: '26.0',
      },
    ],
  });

  assert.deepEqual(
    parseAvailableIosSimulatorRuntimeVersions(output),
    ['18.6']
  );
  assert.deepEqual(
    parseAvailableIosSimulatorRuntimes(output),
    [{
      build: null,
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6',
      version: '18.6',
    }]
  );
});

test('reads Apple preferred iOS runtime build matching metadata', () => {
  const preferred = parsePreferredIosSimulatorRuntime(JSON.stringify({
    'appletvos26.5': {
      chosenRuntimeBuild: '23L470',
      platform: 'com.apple.platform.appletvos',
      sdkVersion: '26.5',
    },
    'iphoneos26.5': {
      chosenRuntimeBuild: '23F81a',
      platform: 'com.apple.platform.iphoneos',
      sdkVersion: '26.5.1',
    },
  }));

  assert.deepEqual(preferred, {
    build: '23F81a',
    version: '26.5',
  });
});

test('offers and downloads Apple preferred iOS runtime build', async () => {
  const prompts = [];
  const commands = [];
  let inspections = 0;
  const result = await ensurePreferredIosSimulatorRuntime(
    { env: {}, xcodebuild: 'xcodebuild', xcrun: 'xcrun' },
    {
      cwd: '/tmp/example/ios',
      inspectRuntimes: () => {
        inspections += 1;
        return inspections === 1
          ? [{
            build: '23F77',
            identifier: 'old',
            version: '26.5',
          }]
          : [{
            build: '23F81a',
            identifier: 'new',
            version: '26.5',
          }];
      },
      preferredRuntime: () => ({
        build: '23F81a',
        version: '26.5',
      }),
      promptYesNo: async question => {
        prompts.push(question);
        return true;
      },
      runCommand: (...args) => commands.push(args),
      log: () => {},
    }
  );

  assert.equal(result.changed, true);
  assert.match(prompts[0], /newer iOS 26\.5.*23F81a.*23F77/);
  assert.deepEqual(commands[0].slice(0, 3), [
    'xcodebuild',
    ['-downloadPlatform', 'iOS', '-buildVersion', '26.5'],
    '/tmp/example/ios',
  ]);
});

test('cancels iOS launch when runtime installation is declined', async () => {
  await assert.rejects(
    ensurePreferredIosSimulatorRuntime(
      { env: {}, xcodebuild: 'xcodebuild', xcrun: 'xcrun' },
      {
        inspectRuntimes: () => [],
        preferredRuntime: () => ({
          build: '23F81a',
          version: '26.5',
        }),
        promptYesNo: async () => false,
        log: () => {},
      }
    ),
    /no Simulator runtime is installed/
  );
});

test('offers the Xcode App Store page when Simulator itself is missing', async () => {
  const calls = [];
  await assert.rejects(
    prepareIosEnvironment({
      doctor: () => {
        throw new Error('Xcode command-line tools were not found.');
      },
      promptYesNo: async () => true,
      captureCommand: (...args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /Xcode page is open/
  );
  assert.deepEqual(calls[0][1], [
    'macappstore://itunes.apple.com/app/id497799835',
  ]);
});

test('selects a simulator on the newest installed iOS runtime', () => {
  const selected = selectIosSimulator(
    [
      { id: 'OLD', name: 'iPhone 16', os: '18.6' },
      { id: 'NEW', name: 'iPhone 17', os: '26.5' },
    ],
    { env: {}, xcrun: 'xcrun' },
    new Set(['OLD'])
  );

  assert.equal(selected.id, 'NEW');
});

test('retries an empty Xcode simulator query after warming CoreSimulator', async () => {
  const calls = [];
  const destination = {
    id: 'SIMULATOR-ID',
    name: 'iPhone 16',
    os: '18.6',
  };
  let queries = 0;
  const result = await queryEligibleIosSimulatorsWithRetry(
    '/tmp/example/ios',
    'Example',
    { env: {}, xcrun: 'xcrun' },
    {
      query: () => {
        queries += 1;
        return {
          destinations: queries === 1 ? [] : [destination],
          output: '',
          status: 0,
        };
      },
      warm: () => calls.push('warm'),
      wait: milliseconds => {
        calls.push(['wait', milliseconds]);
        return Promise.resolve();
      },
    }
  );

  assert.equal(queries, 2);
  assert.deepEqual(calls, ['warm', 'warm', ['wait', 500]]);
  assert.deepEqual(result.destinations, [destination]);
});

test('does not offer a runtime download when iOS runtimes are installed', async () => {
  let prompted = false;
  await assert.rejects(
    ensureEligibleIosSimulator(
      '/tmp/example/ios',
      'Example',
      {env: {}, xcrun: 'xcrun'},
      {
        inspectRuntimes: () => ['18.6', '26.5'],
        queryWithRetry: async () => ({
          destinations: [],
          output: '',
          status: 0,
        }),
        promptYesNo: async () => {
          prompted = true;
          return false;
        },
      }
    ),
    /runtimes are installed \(18\.6, 26\.5\)/
  );
  assert.equal(prompted, false);
});

test('does not try to boot a simulator that is already booted', () => {
  const calls = [];
  const captureCommand = (_command, args) => {
    calls.push(args);
    if (args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify({
          devices: {
            runtime: [{udid: 'SIMULATOR-ID', state: 'Booted'}],
          },
        }),
        stderr: '',
      };
    }
    return {status: 0, stdout: '', stderr: ''};
  };

  ensureIosSimulatorBooted(
    {id: 'SIMULATOR-ID', name: 'iPhone 16'},
    {env: {}, xcrun: 'xcrun'},
    captureCommand
  );

  assert.equal(calls.some(args => args[1] === 'boot'), false);
  assert.equal(calls.some(args => args[1] === 'bootstatus'), true);
});

test('accepts a boot race when CoreSimulator already started the device', () => {
  const calls = [];
  let listed = 0;
  const captureCommand = (_command, args) => {
    calls.push(args);
    if (args[1] === 'list') {
      listed += 1;
      return {
        status: 0,
        stdout: JSON.stringify({
          devices: {
            runtime: [{
              udid: 'SIMULATOR-ID',
              state: listed === 1 ? 'Shutdown' : 'Booted',
            }],
          },
        }),
        stderr: '',
      };
    }
    if (args[1] === 'boot') {
      return {
        status: 149,
        stdout: '',
        stderr: 'Unable to boot device in current state: Booted',
      };
    }
    return {status: 0, stdout: '', stderr: ''};
  };

  assert.doesNotThrow(() => ensureIosSimulatorBooted(
    {id: 'SIMULATOR-ID', name: 'iPhone 16'},
    {env: {}, xcrun: 'xcrun'},
    captureCommand
  ));
  assert.equal(calls.some(args => args[1] === 'bootstatus'), true);
});

test('opens the selected simulator window and explicitly activates it', () => {
  const calls = [];
  const captureCommand = (command, args) => {
    calls.push([command, args]);
    if (args[0] === '-p') {
      return {
        status: 0,
        stdout: '/Applications/Xcode.app/Contents/Developer\n',
        stderr: '',
      };
    }
    return {status: 0, stdout: '', stderr: ''};
  };

  showIosSimulator(
    {id: 'SIMULATOR-ID', name: 'iPhone 16'},
    {env: {}, xcodeSelect: 'xcode-select', xcrun: 'xcrun'},
    captureCommand,
    candidate => candidate.endsWith('/Simulator.app')
  );

  assert.deepEqual(calls[1], [
    'open',
    [
      '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
      '--args',
      '-CurrentDeviceUDID',
      'SIMULATOR-ID',
    ],
  ]);
  assert.deepEqual(calls[2], [
    'osascript',
    [
      '-e',
      'tell application id "com.apple.iphonesimulator" to activate',
    ],
  ]);
});

test('recognizes a current CocoaPods installation', t => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-pods-test-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const iosDir = path.join(outputDir, 'ios');
  fs.mkdirSync(path.join(iosDir, 'Pods'), { recursive: true });
  fs.writeFileSync(path.join(iosDir, 'Podfile'), 'platform :ios');
  fs.writeFileSync(path.join(outputDir, 'package.json'), '{}');
  fs.writeFileSync(path.join(outputDir, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(iosDir, 'Podfile.lock'), 'LOCKED');
  fs.writeFileSync(path.join(iosDir, 'Pods', 'Manifest.lock'), 'LOCKED');

  const future = new Date(Date.now() + 1000);
  fs.utimesSync(path.join(iosDir, 'Pods', 'Manifest.lock'), future, future);
  assert.equal(iosPodsAreCurrent(iosDir, outputDir), true);

  fs.writeFileSync(path.join(outputDir, 'package.json'), '{"changed":true}');
  const newer = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(outputDir, 'package.json'), newer, newer);
  assert.equal(iosPodsAreCurrent(iosDir, outputDir), false);
});
