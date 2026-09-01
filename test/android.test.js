const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  activateAndroidEmulator,
  androidApplicationId,
  androidEmulatorArchitectureMismatch,
  androidEmulatorConsolePort,
  androidEmulatorHostProcessId,
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

test('maps an Android emulator serial to its exact macOS host process', () => {
  const calls = [];
  const processId = androidEmulatorHostProcessId(
    'emulator-5554',
    { PATH: '/usr/bin' },
    {
      captureFn: (command, args, options) => {
        calls.push([command, args, options]);
        return {
          status: 0,
          stderr: '',
          stdout: 'p89522\nf41\nf42\n',
        };
      },
      pathExists: candidate => candidate === '/usr/sbin/lsof',
      platform: 'darwin',
    }
  );

  assert.equal(processId, 89522);
  assert.equal(calls[0][0], '/usr/sbin/lsof');
  assert.deepEqual(calls[0][1], [
    '-nP',
    '-iTCP:5554',
    '-sTCP:LISTEN',
    '-Fp',
  ]);
  assert.equal(calls[0][2].check, false);
});

test('accepts only Android emulator console serials', () => {
  assert.equal(androidEmulatorConsolePort('emulator-5554'), 5554);
  assert.equal(androidEmulatorConsolePort('emulator-65535'), 65535);
  assert.equal(androidEmulatorConsolePort('emulator-0'), null);
  assert.equal(androidEmulatorConsolePort('emulator-65536'), null);
  assert.equal(androidEmulatorConsolePort('physical-device'), null);
});

test('activates the selected Android emulator by PID without a process-name guess', () => {
  const calls = [];
  const environment = {
    adb: '/sdk/adb',
    avd: 'Pixel_API_35',
    env: { PATH: '/usr/bin' },
  };
  const activated = activateAndroidEmulator(environment, {
    captureFn: (command, args, options) => {
      calls.push([command, args, options]);
      return { status: 0, stderr: '', stdout: 'activated\n' };
    },
    pathExists: candidate => candidate === '/usr/bin/osascript',
    platform: 'darwin',
    processIdFn: serial => {
      assert.equal(serial, 'emulator-5554');
      return 89522;
    },
    serial: 'emulator-5554',
  });

  assert.deepEqual(activated, {
    method: 'system-events',
    platform: 'darwin',
    reason: null,
    serial: 'emulator-5554',
    status: 'activated',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.equal(calls[0][1][0], '-e');
  assert.match(calls[0][1][1], /System Events/);
  assert.match(calls[0][1][1], /frontmost/);
  assert.equal(calls[0][1][1].includes(environment.avd), false);
  assert.equal(calls[0][1].at(-1), '89522');
  assert.equal(calls[0][2].check, false);
});

test('Android emulator activation is a safe no-op when unavailable', () => {
  const environment = { adb: '/sdk/adb', avd: 'Pixel_API_35', env: {} };
  let captures = 0;
  assert.equal(androidEmulatorHostProcessId(
    'physical-device',
    {},
    {
      captureFn: () => {
        captures += 1;
        throw new Error('should not run');
      },
      platform: 'darwin',
    }
  ), null);
  assert.deepEqual(activateAndroidEmulator(environment, {
    captureFn: () => {
      captures += 1;
      throw new Error('should not run');
    },
    platform: 'linux',
    serial: 'emulator-5554',
  }), {
    method: null,
    platform: 'linux',
    reason: 'process-not-found',
    serial: 'emulator-5554',
    status: 'unavailable',
  });
  assert.equal(captures, 0);

  assert.equal(androidEmulatorHostProcessId(
    'emulator-5554',
    {},
    {
      captureFn: () => ({
        status: 0,
        stderr: '',
        stdout: 'p123\np456\n',
      }),
      pathExists: candidate => candidate === '/usr/sbin/lsof',
      platform: 'darwin',
    }
  ), null);

  const failedActivation = activateAndroidEmulator(environment, {
    captureFn: () => ({ status: 1, stderr: 'refused', stdout: '' }),
    pathExists: candidate => candidate === '/usr/bin/osascript',
    platform: 'darwin',
    processIdFn: () => 89522,
    serial: 'emulator-5554',
  });
  assert.equal(failedActivation.status, 'unavailable');
  assert.equal(failedActivation.reason, 'activation-error');
});

test('maps an Android emulator serial to its exact Windows host process', () => {
  const calls = [];
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const processId = androidEmulatorHostProcessId(
    'emulator-5554',
    { PATH: '', SystemRoot: 'C:\\Windows' },
    {
      captureFn: (command, args, options) => {
        calls.push([command, args, options]);
        return { status: 0, stderr: '', stdout: 'p8123\np8123\n' };
      },
      findExecutableFn: () => null,
      pathExists: candidate => candidate === powershell,
      platform: 'win32',
    }
  );

  assert.equal(processId, 8123);
  assert.equal(calls[0][0], powershell);
  assert.deepEqual(calls[0][1].slice(0, 6), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
  ]);
  assert.match(calls[0][1].at(-1), /Get-NetTCPConnection/);
  assert.match(calls[0][1].at(-1), /\$targetPort = 5554/);
  assert.doesNotMatch(calls[0][1].at(-1), /\$pid\b/i);
  assert.equal(calls[0][2].check, false);
});

test('restores and activates the exact Android emulator window on Windows', () => {
  const calls = [];
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const environment = {
    adb: 'C:\\Android\\adb.exe',
    avd: 'Pixel_API_35',
    env: { PATH: '', SystemRoot: 'C:\\Windows' },
  };
  const activated = activateAndroidEmulator(environment, {
    captureFn: (command, args, options) => {
      calls.push([command, args, options]);
      return { status: 0, stderr: '', stdout: 'activated\n' };
    },
    findExecutableFn: () => null,
    pathExists: candidate => candidate === powershell,
    platform: 'win32',
    processIdFn: serial => {
      assert.equal(serial, 'emulator-5554');
      return 8123;
    },
    serial: 'emulator-5554',
  });

  assert.deepEqual(activated, {
    method: 'win32',
    platform: 'win32',
    reason: null,
    serial: 'emulator-5554',
    status: 'activated',
  });
  assert.equal(calls[0][0], powershell);
  const script = calls[0][1].at(-1);
  assert.match(script, /\$targetProcessId = 8123/);
  assert.match(script, /\$targetPort = 5554/);
  assert.match(script, /EnumWindows/);
  assert.match(script, /ShowWindowAsync/);
  assert.match(script, /IsIconic/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /FlashWindow/);
  assert.equal(script.includes(environment.avd), false);
});

test('reports a nonfatal Windows foreground refusal', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const result = activateAndroidEmulator(
    { avd: 'Pixel_API_35', env: { SystemRoot: 'C:\\Windows' } },
    {
      captureFn: () => ({ status: 0, stderr: '', stdout: 'refused\n' }),
      findExecutableFn: () => null,
      pathExists: candidate => candidate === powershell,
      platform: 'win32',
      processIdFn: () => 8123,
      serial: 'emulator-5554',
    }
  );

  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'activation-refused');
});

test('distinguishes a Windows taskbar request from an activation error', () => {
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const environment = {
    avd: 'Pixel_API_35',
    env: { SystemRoot: 'C:\\Windows' },
  };
  const options = {
    findExecutableFn: () => null,
    pathExists: candidate => candidate === powershell,
    platform: 'win32',
    processIdFn: () => 8123,
    serial: 'emulator-5554',
  };

  const flashed = activateAndroidEmulator(environment, {
    ...options,
    captureFn: () => ({
      status: 0,
      stderr: '',
      stdout: 'refused-taskbar-requested\n',
    }),
  });
  const errored = activateAndroidEmulator(environment, {
    ...options,
    captureFn: () => ({ status: 0, stderr: '', stdout: 'error\n' }),
  });

  assert.equal(flashed.status, 'refused');
  assert.equal(flashed.reason, 'activation-refused-taskbar-requested');
  assert.equal(errored.status, 'unavailable');
  assert.equal(errored.reason, 'activation-error');
});

test('maps a Linux emulator console socket to one exact host process', () => {
  const procRoot = '/virtual/proc';
  const tcpHeader = '  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt uid timeout inode';
  const tcpRow = '   0: 0100007F:15B2 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 98765 1';
  const processId = androidEmulatorHostProcessId(
    'emulator-5554',
    {},
    {
      findExecutableFn: () => null,
      platform: 'linux',
      procRoot,
      readDirectoryFn: candidate => {
        if (candidate === procRoot) {
          return ['8123', 'not-a-process'];
        }
        if (candidate === path.posix.join(procRoot, '8123', 'fd')) {
          return ['4'];
        }
        throw new Error(`Unexpected directory: ${candidate}`);
      },
      readFileFn: candidate => (
        candidate.endsWith('/tcp')
          ? `${tcpHeader}\n${tcpRow}\n`
          : `${tcpHeader}\n`
      ),
      readLinkFn: candidate => {
        assert.equal(
          candidate,
          path.posix.join(procRoot, '8123', 'fd', '4')
        );
        return 'socket:[98765]';
      },
    }
  );

  assert.equal(processId, 8123);
});

test('continues Linux PID discovery when an installed socket tool fails', () => {
  const calls = [];
  const processId = androidEmulatorHostProcessId(
    'emulator-5554',
    { PATH: '/usr/bin' },
    {
      captureFn: (command, args) => {
        calls.push([command, args]);
        if (command === '/usr/bin/lsof') {
          throw new Error('stale lsof executable');
        }
        return {
          status: 0,
          stderr: '',
          stdout: 'LISTEN 0 4096 127.0.0.1:5554 0.0.0.0:* users:(("qemu",pid=8123,fd=7))\n',
        };
      },
      findExecutableFn: command => `/usr/bin/${command}`,
      platform: 'linux',
      procRoot: null,
    }
  );

  assert.equal(processId, 8123);
  assert.deepEqual(calls.map(([command]) => command), [
    '/usr/bin/lsof',
    '/usr/bin/ss',
  ]);
});

test('activates an exact-PID Android emulator window through X11', () => {
  const calls = [];
  const environment = {
    avd: 'Pixel_API_35',
    env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
  };
  const result = activateAndroidEmulator(environment, {
    captureFn: (command, args, options) => {
      calls.push([command, args, options]);
      if (args[0] === '-lp') {
        return {
          status: 0,
          stderr: '',
          stdout: '0x03c00007  0 8123 host Android Emulator - Pixel_API_35:5554\n',
        };
      }
      if (args[0] === '-root') {
        return {
          status: 0,
          stderr: '',
          stdout: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x03c00007\n',
        };
      }
      return { status: 0, stderr: '', stdout: '' };
    },
    findExecutableFn: command => (
      command === 'wmctrl'
        ? '/usr/bin/wmctrl'
        : command === 'xprop'
          ? '/usr/bin/xprop'
          : null
    ),
    platform: 'linux',
    processIdFn: () => 8123,
    serial: 'emulator-5554',
  });

  assert.equal(result.status, 'activated');
  assert.equal(result.method, 'wmctrl');
  assert.deepEqual(calls[1].slice(0, 2), [
    '/usr/bin/wmctrl',
    ['-i', '-a', '0x03c00007'],
  ]);
});

test('uses XWayland as a best-effort request without claiming focus', () => {
  const environment = {
    avd: 'Pixel_API_35',
    env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
  };
  const result = activateAndroidEmulator(environment, {
    captureFn: (_command, args) => (
      args[0] === '-lp'
        ? {
          status: 0,
          stderr: '',
          stdout: '0x03c00007  0 8123 host Android Emulator - Pixel_API_35:5554\n',
        }
        : { status: 0, stderr: '', stdout: '' }
    ),
    findExecutableFn: command => (
      command === 'wmctrl' ? '/usr/bin/wmctrl' : null
    ),
    platform: 'linux',
    processIdFn: () => 8123,
    serial: 'emulator-5554',
  });

  assert.equal(result.status, 'requested');
  assert.equal(result.method, 'xwayland-wmctrl');
  assert.equal(result.reason, 'window-manager-controls-focus');
});

test('focuses the exact emulator container through Sway IPC', () => {
  const calls = [];
  const environment = {
    avd: 'Pixel_API_35',
    env: {
      SWAYSOCK: '/run/user/1000/sway.sock',
      WAYLAND_DISPLAY: 'wayland-1',
    },
  };
  const result = activateAndroidEmulator(environment, {
    captureFn: (command, args, options) => {
      calls.push([command, args, options]);
      if (args.includes('get_tree')) {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            floating_nodes: [],
            nodes: [{
              floating_nodes: [],
              id: 42,
              name: 'Android Emulator - Pixel_API_35:5554',
              nodes: [],
              pid: 8123,
            }],
          }),
        };
      }
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify([{ success: true }]),
      };
    },
    findExecutableFn: command => (
      command === 'swaymsg' ? '/usr/bin/swaymsg' : null
    ),
    platform: 'linux',
    processIdFn: () => 8123,
    serial: 'emulator-5554',
  });

  assert.equal(result.status, 'activated');
  assert.equal(result.method, 'sway');
  assert.deepEqual(calls[1].slice(0, 2), [
    '/usr/bin/swaymsg',
    ['-r', '[con_id=42] focus'],
  ]);
});

test('uses xdotool as the exact-PID X11 fallback', () => {
  const calls = [];
  const environment = {
    avd: 'Pixel_API_35',
    env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
  };
  const result = activateAndroidEmulator(environment, {
    captureFn: (command, args, options) => {
      calls.push([command, args, options]);
      if (args[0] === 'search') {
        return { status: 0, stderr: '', stdout: '10485767\n' };
      }
      if (args[0] === 'getwindowname') {
        return {
          status: 0,
          stderr: '',
          stdout: 'Android Emulator - Pixel_API_35:5554\n',
        };
      }
      if (args[0] === 'getactivewindow') {
        return { status: 0, stderr: '', stdout: '10485767\n' };
      }
      return { status: 0, stderr: '', stdout: '' };
    },
    findExecutableFn: command => (
      command === 'xdotool' ? '/usr/bin/xdotool' : null
    ),
    platform: 'linux',
    processIdFn: () => 8123,
    serial: 'emulator-5554',
  });

  assert.equal(result.status, 'activated');
  assert.equal(result.method, 'xdotool');
  assert.ok(calls.some(([, args]) => (
    args[0] === 'windowactivate' && args[1] === '10485767'
  )));
});

test('explains when pure Wayland cannot portably force foreground focus', () => {
  const result = activateAndroidEmulator(
    {
      avd: 'Pixel_API_35',
      env: { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
    },
    {
      findExecutableFn: () => null,
      platform: 'linux',
      processIdFn: () => 8123,
      serial: 'emulator-5554',
    }
  );

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'wayland-focus-policy');
});

test(
  'maps a real host listener to the current process on Linux and Windows',
  { skip: !['linux', 'win32'].includes(process.platform) },
  async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const processId = androidEmulatorHostProcessId(
        `emulator-${address.port}`,
        process.env,
        { platform: process.platform }
      );
      assert.equal(processId, process.pid);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
);

test(
  'compiles the native Windows activation helper on Windows',
  { skip: process.platform !== 'win32' },
  () => {
    const result = activateAndroidEmulator(
      { avd: 'OnRamp_Test', env: process.env },
      {
        platform: 'win32',
        processIdFn: () => process.pid,
        serial: 'emulator-5554',
      }
    );

    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'window-not-found');
  }
);

test('foregrounds an already-running selected Android emulator', async () => {
  const activations = [];
  const environment = {
    adb: '/sdk/platform-tools/adb',
    avd: 'Pixel_API_35',
    emulator: '/sdk/emulator/emulator',
    env: { ANDROID_HOME: '/sdk' },
  };
  const serial = await ensureAndroidEmulator(environment, {
    activateFn: (activatedEnvironment, options) => {
      activations.push([activatedEnvironment, options]);
      return true;
    },
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        return {
          status: 0,
          stderr: '',
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        };
      }
      if (args.includes('emu')) {
        return { status: 0, stderr: '', stdout: 'Pixel_API_35\nOK\n' };
      }
      throw new Error(`Unexpected Android command: ${args.join(' ')}`);
    },
    log: () => {},
    platform: 'darwin',
  });

  assert.equal(serial, 'emulator-5554');
  assert.equal(activations.length, 1);
  assert.equal(activations[0][0], environment);
  assert.equal(activations[0][1].serial, 'emulator-5554');
  assert.equal(activations[0][1].platform, 'darwin');
});

test('keeps a running Android emulator usable when host activation is refused', async () => {
  const environment = {
    adb: '/sdk/platform-tools/adb',
    avd: 'Pixel_API_35',
    emulator: '/sdk/emulator/emulator',
    env: { ANDROID_HOME: '/sdk' },
  };
  const serial = await ensureAndroidEmulator(environment, {
    activateFn: () => {
      throw new Error('macOS refused activation');
    },
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        return {
          status: 0,
          stderr: '',
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        };
      }
      return { status: 0, stderr: '', stdout: 'Pixel_API_35\nOK\n' };
    },
    log: () => {},
    platform: 'darwin',
  });

  assert.equal(serial, 'emulator-5554');
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
  const activations = [];
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
    activateFn: (activatedEnvironment, options) => {
      activations.push([activatedEnvironment, options]);
      return true;
    },
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
  assert.equal(activations.length, 1);
  assert.equal(activations[0][0], environment);
  assert.equal(activations[0][1].serial, 'emulator-5554');
});

test('runs React Native on the selected Android emulator with its exact application ID', () => {
  assert.deepEqual(androidRunArguments(8081, 'emulator-5556', 'com.example.app.dev'), [
    'react-native',
    'run-android',
    '--device',
    'emulator-5556',
    '--port',
    '8081',
    '--no-packager',
    '--active-arch-only',
    '--appId',
    'com.example.app.dev',
  ]);
});

test('resolves the effective debug application ID including a Gradle suffix', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-android-id-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
  fs.writeFileSync(gradlePath, `
android {
    namespace "com.example.app"
    defaultConfig {
        applicationId "com.example.app"
    }
    buildTypes {
        debug {
            buildConfigField "String", "JSON", '{"nested": true}'
            applicationIdSuffix ".dev"
        }
        staging {
            applicationIdSuffix ".beta"
        }
    }
}
`);

  assert.equal(androidApplicationId(root), 'com.example.app.dev');
});

test('keeps an unsuffixed debug application ID unchanged', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-android-id-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
  fs.writeFileSync(gradlePath, `
android {
    defaultConfig {
        applicationId = "com.example.app"
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
    }
}
`);

  assert.equal(androidApplicationId(root), 'com.example.app');
});

test('supports assignment syntax for a debug application ID suffix', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-android-id-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
  fs.writeFileSync(gradlePath, `
android {
    defaultConfig {
        applicationId = "com.example.app"
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".local"
        }
    }
}
`);

  assert.equal(androidApplicationId(root), 'com.example.app.local');
});

test('ignores comments and quoted Gradle identity decoys', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-android-id-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
  fs.writeFileSync(gradlePath, `
// android { defaultConfig { applicationId "com.comment.decoy" } }
android {
    def example = 'defaultConfig { applicationId "com.string.decoy" }'
    defaultConfig {
        // applicationId "com.comment.decoy"
        applicationId "com.example.app"
    }
    // buildTypes { debug { applicationIdSuffix ".comment" } }
    def otherExample = 'buildTypes { debug { applicationIdSuffix ".string" } }'
    buildTypes {
        debug {
            // applicationIdSuffix ".comment"
            def suffixExample = 'applicationIdSuffix ".string"'
            applicationIdSuffix ".dev"
        }
    }
}
`);

  assert.equal(androidApplicationId(root), 'com.example.app.dev');
});

test('rejects a dynamic debug application ID suffix', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-android-id-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  fs.mkdirSync(path.dirname(gradlePath), { recursive: true });
  fs.writeFileSync(gradlePath, `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
    buildTypes {
        debug {
            applicationIdSuffix project.findProperty("debugSuffix")
        }
    }
}
`);

  assert.throws(
    () => androidApplicationId(root),
    /applicationIdSuffix is not a static string literal/
  );

  fs.writeFileSync(gradlePath, `
android {
    defaultConfig {
        applicationId "com.example.app"
    }
    buildTypes {
        debug {
            applicationIdSuffix "." + project.findProperty("debugSuffix")
        }
    }
}
`);
  assert.throws(
    () => androidApplicationId(root),
    /applicationIdSuffix is not a static string literal/
  );
});

test('opens a cached Android app and reconnects it to Metro', () => {
  const calls = [];
  launchInstalledAndroidApp(
    { adb: '/sdk/adb', env: { ANDROID_HOME: '/sdk' } },
    'emulator-5554',
    'com.example.app.dev',
    8081,
    (command, args) => {
      calls.push([command, args]);
      return args.includes('resolve-activity')
        ? {
          status: 0,
          stdout: 'com.example.app.dev/com.example.app.MainActivity\n',
          stderr: '',
        }
        : { status: 0, stdout: '', stderr: '' };
    }
  );

  assert.deepEqual(calls[0][1], [
    '-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081',
  ]);
  assert.ok(calls.some(([, args]) => args.includes('force-stop')));
  assert.deepEqual(calls.at(-1)[1].slice(-2), [
    '-n', 'com.example.app.dev/com.example.app.MainActivity',
  ]);
});

test('fails clearly when a cached Android launcher activity cannot be resolved', () => {
  const calls = [];
  assert.throws(
    () => launchInstalledAndroidApp(
      { adb: '/sdk/adb', env: { ANDROID_HOME: '/sdk' } },
      'emulator-5554',
      'com.example.app.dev',
      8081,
      (command, args) => {
        calls.push([command, args]);
        return args.includes('resolve-activity')
          ? { status: 1, stdout: '', stderr: 'No launcher activity found' }
          : { status: 0, stdout: '', stderr: '' };
      }
    ),
    /Could not resolve the Android launcher activity for com\.example\.app\.dev.*No launcher/
  );
  assert.equal(calls.some(([, args]) => args.includes('am')), false);
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
  const activations = [];
  const spawns = [];
  let deviceQueries = 0;
  const environment = {
    adb: '/sdk/platform-tools/adb',
    avd: 'Pixel_API_36',
    emulator: '/sdk/emulator/emulator',
    env: { ANDROID_HOME: '/sdk' },
  };

  const serial = await ensureAndroidEmulator(environment, {
    activateFn: (_activatedEnvironment, options) => {
      activations.push(options.serial);
      return true;
    },
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
  assert.deepEqual(activations, ['emulator-5556']);
});
