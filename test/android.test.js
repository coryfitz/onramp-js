const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  androidEmulatorArchitectureMismatch,
  androidEmulatorLaunchArgs,
  androidRunArguments,
  compareVersions,
  connectedAndroidEmulators,
  enableHostClipboardSharing,
  ensureAndroidEmulator,
  launchInstalledAndroidApp,
  parseMachOArchitectures,
  parseEmulatorVersion,
  requireClipboardCapableEmulator,
  selectAndroidAvd,
} = require('../src/android');

test('parses and compares Android Emulator versions', () => {
  assert.deepEqual(
    parseEmulatorVersion('Android emulator version 37.1.11.0 (build_id 123)'),
    [37, 1, 11, 0]
  );
  assert.equal(compareVersions([37, 1, 11], [33, 1, 23]), 1);
  assert.equal(compareVersions([33, 1, 23, 0], [33, 1, 23]), 0);
  assert.equal(compareVersions([32, 1, 11], [33, 1, 23]), -1);
});

test('rejects emulator versions with unreliable host clipboard transport', () => {
  assert.throws(
    () => requireClipboardCapableEmulator(
      '/sdk/emulator/emulator',
      {},
      () => ({
        status: 0,
        stdout: 'Android emulator version 32.1.11.0',
        stderr: '',
      })
    ),
    /33\.1\.23 or newer.*found 32\.1\.11\.0/
  );
});

test('detects a non-native Android Emulator executable on macOS', () => {
  assert.deepEqual(
    parseMachOArchitectures(
      'Mach-O universal binary with 2 architectures: [x86_64] [arm64]'
    ),
    ['x86_64', 'arm64']
  );
  assert.deepEqual(
    androidEmulatorArchitectureMismatch('/sdk/emulator/emulator', {}, {
      architecture: 'arm64',
      captureFn: () => ({
        status: 0,
        stdout: 'Non-fat file is architecture: x86_64\n',
        stderr: '',
      }),
      pathExists: () => true,
      platform: 'darwin',
    }),
    { expected: 'arm64', installed: ['x86_64'] }
  );
});

test('enables the Android Emulator clipboard preference on macOS', () => {
  const calls = [];
  const enabled = enableHostClipboardSharing(
    { PATH: process.env.PATH },
    {
      platform: 'darwin',
      captureFn: (...args) => calls.push(args),
      findExecutableFn: () => '/usr/bin/defaults',
      pathExists: () => true,
    }
  );

  assert.equal(enabled, true);
  assert.deepEqual(
    calls[0][1],
    ['write', 'com.android.Emulator', 'set.clipboardSharing', '-bool', 'true']
  );
});

test('recognizes only online Android emulators', () => {
  const emulators = connectedAndroidEmulators('/sdk/adb', {}, () => ({
    status: 0,
    stderr: '',
    stdout: [
      'List of devices attached',
      'emulator-5554\tdevice',
      'emulator-5556\toffline',
      'R5CT123456\tdevice',
      '',
    ].join('\n'),
  }));

  assert.deepEqual(emulators, ['emulator-5554']);
});

test('selects a valid numbered stable AVD instead of the first entry', () => {
  const metadata = new Map([
    ['Preview_API', { avd: 'Preview_API', stable: false, valid: true }],
    ['Broken_API', { avd: 'Broken_API', stable: true, valid: false }],
    ['Pixel_API_35', { avd: 'Pixel_API_35', stable: true, valid: true }],
  ]);
  const selected = selectAndroidAvd(
    [...metadata.keys()],
    '/sdk',
    {},
    avd => metadata.get(avd)
  );

  assert.equal(selected, 'Pixel_API_35');
});

test('rejects preview-only AVDs whose clipboard transport is unreliable', () => {
  assert.throws(
    () => selectAndroidAvd(
      ['Preview_API'],
      '/sdk',
      {},
      avd => ({ avd, stable: false, valid: true })
    ),
    /No stable Android virtual device.*preview or codename/
  );
});

test('cold-launches an AVD and waits for Android to finish booting', async () => {
  const captures = [];
  const spawns = [];
  let deviceQueries = 0;
  const environment = {
    adb: '/sdk/platform-tools/adb',
    avd: 'Pixel_API_35',
    emulator: '/sdk/emulator/emulator',
    env: { ANDROID_HOME: '/sdk' },
  };

  const serial = await ensureAndroidEmulator(environment, {
    captureFn: (command, args) => {
      captures.push([command, args]);
      if (args[0] === 'devices') {
        deviceQueries += 1;
        return {
          status: 0,
          stderr: '',
          stdout: deviceQueries === 1
            ? 'List of devices attached\n'
            : 'List of devices attached\nemulator-5554\tdevice\n',
        };
      }
      if (args.includes('emu')) {
        return { status: 0, stderr: '', stdout: 'Pixel_API_35\nOK\n' };
      }
      return { status: 0, stderr: '', stdout: '1\n' };
    },
    delay: async () => {},
    log: () => {},
    now: (() => {
      let time = 0;
      return () => { time += 10; return time; };
    })(),
    spawnFn: (...args) => {
      spawns.push(args);
      return { unref() {} };
    },
  });

  assert.equal(serial, 'emulator-5554');
  assert.deepEqual(androidEmulatorLaunchArgs('Pixel_API_35'), [
    '@Pixel_API_35',
    '-no-snapshot-load',
    '-no-boot-anim',
  ]);
  assert.equal(spawns[0][0], environment.emulator);
  assert.deepEqual(spawns[0][1], androidEmulatorLaunchArgs(environment.avd));
  assert.deepEqual(spawns[0][2].stdio, ['ignore', 'ignore', 'pipe']);
  assert.ok(captures.some(([, args]) => args.includes('sys.boot_completed')));
});

test('runs React Native on the selected Android emulator only', () => {
  assert.deepEqual(androidRunArguments(8081, 'emulator-5556'), [
    'react-native',
    'run-android',
    '--device',
    'emulator-5556',
    '--port',
    '8081',
    '--no-packager',
    '--active-arch-only',
  ]);
});

test('opens a cached Android app and reconnects it to Metro', () => {
  const calls = [];
  launchInstalledAndroidApp(
    { adb: '/sdk/adb', env: { ANDROID_HOME: '/sdk' } },
    'emulator-5554',
    'com.example.app',
    8081,
    (command, args) => {
      calls.push([command, args]);
      return args.includes('resolve-activity')
        ? { status: 0, stdout: 'com.example.app/.MainActivity\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    }
  );

  assert.deepEqual(calls[0][1], [
    '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081',
  ]);
  assert.ok(calls.some(([, args]) => args.includes('force-stop')));
  assert.deepEqual(calls.at(-1)[1].slice(-2), [
    '-n', 'com.example.app/.MainActivity',
  ]);
});

test('reports an Android Emulator fatal error without waiting for boot timeout', async () => {
  const environment = {
    adb: '/sdk/platform-tools/adb',
    avd: 'OnRamp_API_37_1',
    emulator: '/sdk/emulator/emulator',
    env: { ANDROID_HOME: '/sdk' },
  };
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};

  const launch = ensureAndroidEmulator(environment, {
    captureFn: () => ({
      status: 0,
      stderr: '',
      stdout: 'List of devices attached\n',
    }),
    delay: () => new Promise(resolve => setImmediate(resolve)),
    log: () => {},
    now: (() => {
      let time = 0;
      return () => { time += 10; return time; };
    })(),
    spawnFn: () => {
      setImmediate(() => {
        child.stderr.write(
          '\x1b[0;39mFATAL | System image must match the host architecture.\n'
        );
        child.stderr.end();
        child.emit('close', 1, null);
      });
      return child;
    },
    timeoutMs: 1000,
  });

  await assert.rejects(
    launch,
    /failed to start: Android Emulator exited with status 1[\s\S]*FATAL \| System image must match/
  );
});

test('launches the selected AVD when a different emulator is running', async () => {
  const spawns = [];
  let deviceQueries = 0;
  const environment = {
    adb: '/sdk/platform-tools/adb',
    avd: 'Pixel_API_36',
    emulator: '/sdk/emulator/emulator',
    env: { ANDROID_HOME: '/sdk' },
  };

  const serial = await ensureAndroidEmulator(environment, {
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        deviceQueries += 1;
        return {
          status: 0,
          stderr: '',
          stdout: deviceQueries < 3
            ? 'List of devices attached\nemulator-5554\tdevice\n'
            : [
              'List of devices attached',
              'emulator-5554\tdevice',
              'emulator-5556\tdevice',
              '',
            ].join('\n'),
        };
      }
      if (args.includes('emu')) {
        return {
          status: 0,
          stderr: '',
          stdout: args[1] === 'emulator-5556'
            ? 'Pixel_API_36\nOK\n'
            : 'Pixel_API_35\nOK\n',
        };
      }
      return { status: 0, stderr: '', stdout: '1\n' };
    },
    delay: async () => {},
    log: () => {},
    now: (() => {
      let time = 0;
      return () => { time += 10; return time; };
    })(),
    spawnFn: (...args) => {
      spawns.push(args);
      return { unref() {} };
    },
  });

  assert.equal(serial, 'emulator-5556');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0][1], [
    '@Pixel_API_36',
    '-no-snapshot-load',
    '-no-boot-anim',
  ]);
});
