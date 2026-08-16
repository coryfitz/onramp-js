const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseRepairArgs,
  parseRunArgs,
} = require('../bin/onramp-js');
const { nextCommands, npmInstallArgs } = require('../src/create');
const {
  iosJsLocation,
  iosPodsAreCurrent,
  parseBuildSetting,
} = require('../src/ios');
const { nativeProjectName } = require('../src/native');
const { isPythonWrapper, run } = require('../src/process');
const { runMobile } = require('../src/run');

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

test('parses mobile as a native run target', () => {
  const options = parseRunArgs(['mobile', '--metro-port', '9090']);

  assert.equal(options.platform, 'mobile');
  assert.equal(options.metroPort, 9090);
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
  assert.equal(calls[1][0], 'android');
  assert.equal(calls[1][1].metroStartingPort, 9091);
  assert.equal(calls[1][1].metroPort, undefined);
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
