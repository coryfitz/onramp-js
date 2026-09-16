const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configureIosHostKeyboard,
  prepareIosHostKeyboard,
  showIosSimulator,
} = require('../src/ios');

const environment = {
  env: {EXAMPLE: 'value'},
  xcodeSelect: 'xcode-select',
};

test('opens a prepared Device Hub without changing preferences after connection', () => {
  const calls = [];
  const captureCommand = (command, args, options) => {
    calls.push([command, args, options]);
    return {status: 0, stdout: '', stderr: ''};
  };

  showIosSimulator(
    {id: 'SIMULATOR-ID', name: 'iPhone 17'},
    environment,
    captureCommand,
    () => assert.fail('a prepared application must not be resolved again'),
    {
      kind: 'device-hub',
      path: '/Applications/Xcode.app/Contents/Applications/DeviceHub.app',
    }
  );

  assert.deepEqual(calls, [[
    'open',
    ['devices://device/open?id=SIMULATOR-ID'],
    {env: environment.env, check: false},
  ]]);
});

test('configures Device Hub then disconnects the exact active simulator before opening', async () => {
  const calls = [];
  const logs = [];
  const warnings = [];
  let preferenceReads = 0;
  let state = 'Booted';
  const result = await prepareIosHostKeyboard(
    {id: 'SIMULATOR-ID', name: 'iPhone 17'},
    {...environment, xcrun: 'xcrun'},
    {
      application: {kind: 'device-hub', path: '/DeviceHub.app'},
      captureCommand: (command, args, options) => {
        calls.push([command, args, options]);
        if (command === '/usr/bin/defaults' && args.includes('read')) {
          preferenceReads += 1;
          return preferenceReads === 1
            ? {status: 1, stdout: '', stderr: 'Domain not found'}
            : {status: 0, stdout: '1\n', stderr: ''};
        }
        if (command === 'xcrun' && args[1] === 'shutdown') {
          state = 'Shutdown';
        }
        return {status: 0, stdout: '', stderr: ''};
      },
      log: message => logs.push(message),
      simulatorState: () => state,
      warn: warning => warnings.push(warning),
    }
  );

  assert.deepEqual(
    calls.map(call => call.slice(0, 2)),
    [
      [
        '/usr/bin/defaults',
        [
          '-container', 'com.apple.dt.Devices', 'read',
          'com.apple.dt.Devices', 'alwaysSimulateHardwareKeyboard',
        ],
      ],
      [
        '/usr/bin/defaults',
        [
          '-container', 'com.apple.dt.Devices', 'write',
          'com.apple.dt.Devices', 'alwaysSimulateHardwareKeyboard',
          '-bool', 'true',
        ],
      ],
      [
        '/usr/bin/defaults',
        [
          '-container', 'com.apple.dt.Devices', 'read',
          'com.apple.dt.Devices', 'alwaysSimulateHardwareKeyboard',
        ],
      ],
      ['xcrun', ['simctl', 'shutdown', 'SIMULATOR-ID']],
    ]
  );
  assert.equal(result.preference.changed, true);
  assert.equal(result.reconnect.restarted, true);
  assert.equal(result.connectionVerified, true);
  assert.deepEqual(warnings, []);
  assert.match(logs.join('\n'), /disconnected safely/);
});

test('does not rewrite an already enabled Device Hub keyboard preference', () => {
  const calls = [];
  const logs = [];
  const warnings = [];
  assert.deepEqual(
    configureIosHostKeyboard(
      'device-hub',
      environment,
      (command, args, options) => {
        calls.push([command, args, options]);
        return {status: 0, stdout: 'true\n', stderr: ''};
      },
      warning => warnings.push(warning),
      message => logs.push(message)
    ),
    {changed: false, enabled: true}
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].includes('read'), true);
  assert.equal(calls[0][1].includes('write'), false);
  assert.deepEqual(warnings, []);
  assert.deepEqual(logs, ['✓ Xcode Device Hub hardware-keyboard default is enabled']);
});

test('does not claim an already-connected Device Hub simulator adopted the default', async () => {
  const calls = [];
  const logs = [];
  const warnings = [];
  const result = await prepareIosHostKeyboard(
    {id: 'SIMULATOR-ID', name: 'iPhone 17'},
    {...environment, xcrun: 'xcrun'},
    {
      application: {kind: 'device-hub', path: '/DeviceHub.app'},
      captureCommand: (command, args) => {
        calls.push([command, args]);
        return {status: 0, stdout: '1\n', stderr: ''};
      },
      log: message => logs.push(message),
      simulatorState: () => 'Booted',
      warn: warning => warnings.push(warning),
    }
  );

  assert.equal(result.preference.enabled, true);
  assert.equal(result.preference.changed, false);
  assert.equal(result.connectionVerified, false);
  assert.equal(calls.some(([, args]) => args.includes('shutdown')), false);
  assert.equal(logs.some(message => /input is enabled for/.test(message)), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot verify it for the existing iPhone 17 connection/);
  assert.match(warnings[0], /Device > Keyboard > Simulate Hardware Keyboard/);
});

test('does not claim a current Device Hub connection when exact shutdown fails', async () => {
  const logs = [];
  const warnings = [];
  let preferenceReads = 0;
  const result = await prepareIosHostKeyboard(
    {id: 'SIMULATOR-ID', name: 'iPhone 17'},
    {...environment, xcrun: 'xcrun'},
    {
      application: {kind: 'device-hub', path: '/DeviceHub.app'},
      captureCommand: (command, args) => {
        if (command === '/usr/bin/defaults' && args.includes('read')) {
          preferenceReads += 1;
          return preferenceReads === 1
            ? {status: 1, stdout: '', stderr: 'Domain not found'}
            : {status: 0, stdout: '1\n', stderr: ''};
        }
        if (command === 'xcrun' && args[1] === 'shutdown') {
          return {status: 1, stdout: '', stderr: 'device is busy'};
        }
        return {status: 0, stdout: '', stderr: ''};
      },
      log: message => logs.push(message),
      simulatorState: () => 'Booted',
      warn: warning => warnings.push(warning),
    }
  );

  assert.equal(result.preference.changed, true);
  assert.equal(result.reconnect.restarted, false);
  assert.equal(result.connectionVerified, false);
  assert.equal(logs.some(message => /input is enabled for/.test(message)), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /device is busy/);
  assert.match(warnings[0], /Device > Keyboard > Simulate Hardware Keyboard/);
});

test('warns and continues when exact Device Hub shutdown times out', async () => {
  const logs = [];
  const warnings = [];
  let preferenceReads = 0;
  let now = 0;
  const result = await prepareIosHostKeyboard(
    {id: 'SIMULATOR-ID', name: 'iPhone 17'},
    {...environment, xcrun: 'xcrun'},
    {
      application: {kind: 'device-hub', path: '/DeviceHub.app'},
      captureCommand: (command, args) => {
        if (command === '/usr/bin/defaults' && args.includes('read')) {
          preferenceReads += 1;
          return preferenceReads === 1
            ? {status: 1, stdout: '', stderr: 'Domain not found'}
            : {status: 0, stdout: '1\n', stderr: ''};
        }
        return {status: 0, stdout: '', stderr: ''};
      },
      delay: async () => {},
      log: message => logs.push(message),
      now: () => {
        now += 10;
        return now;
      },
      pollMs: 1,
      simulatorState: () => 'Booted',
      timeoutMs: 5,
      warn: warning => warnings.push(warning),
    }
  );

  assert.equal(result.preference.changed, true);
  assert.equal(result.reconnect.restarted, false);
  assert.equal(result.connectionVerified, false);
  assert.equal(logs.some(message => /input is enabled for/.test(message)), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not shut down within 0 seconds/);
  assert.match(warnings[0], /Device > Keyboard > Simulate Hardware Keyboard/);
});

test('warns and continues when macOS denies the Device Hub container write', () => {
  const calls = [];
  const logs = [];
  const warnings = [];
  const enabled = configureIosHostKeyboard(
    'device-hub',
    environment,
    (command, args) => {
      calls.push([command, args]);
      return {
        status: 1,
        stdout: '',
        stderr: 'Could not write Device Hub preferences',
      };
    },
    warning => warnings.push(warning),
    message => logs.push(message)
  );

  assert.deepEqual(enabled, {changed: false, enabled: false});
  assert.equal(calls.length, 2);
  assert.deepEqual(logs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not write Device Hub preferences/);
  assert.match(
    warnings[0],
    /Device Hub > Settings > Interaction.*Always simulate hardware keyboard/
  );
  assert.match(
    warnings[0],
    /Device > Keyboard > Simulate Hardware Keyboard/
  );
});

test('does not report success when Device Hub keyboard verification is disabled', () => {
  const logs = [];
  const warnings = [];
  const enabled = configureIosHostKeyboard(
    'device-hub',
    environment,
    (_command, args) => (
      args.includes('read')
        ? {status: 0, stdout: '0\n', stderr: ''}
        : {status: 0, stdout: '', stderr: ''}
    ),
    warning => warnings.push(warning),
    message => logs.push(message)
  );

  assert.deepEqual(enabled, {changed: false, enabled: false});
  assert.deepEqual(logs, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not read back as enabled \(0\)/);
});

test('writes and verifies a missing legacy Simulator keyboard preference', () => {
  const calls = [];
  const logs = [];
  const warnings = [];
  let reads = 0;
  const enabled = configureIosHostKeyboard(
    'simulator',
    environment,
    (command, args, options) => {
      calls.push([command, args, options]);
      if (args.includes('read')) {
        reads += 1;
        return reads === 1
          ? {status: 1, stdout: '', stderr: 'Domain not found'}
          : {status: 0, stdout: 'YES\n', stderr: ''};
      }
      return {status: 0, stdout: '', stderr: ''};
    },
    warning => warnings.push(warning),
    message => logs.push(message)
  );

  assert.deepEqual(enabled, {changed: true, enabled: true});
  assert.deepEqual(
    calls.map(call => call[1]),
    [
      ['read', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard'],
      [
        'write',
        'com.apple.iphonesimulator',
        'ConnectHardwareKeyboard',
        '-bool',
        'true',
      ],
      ['read', 'com.apple.iphonesimulator', 'ConnectHardwareKeyboard'],
    ]
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(logs, ['✓ Mac keyboard input is enabled in Simulator']);
});

test('warns and continues with guidance when the legacy Simulator write fails', () => {
  const logs = [];
  const warnings = [];
  assert.deepEqual(
    configureIosHostKeyboard(
      'simulator',
      environment,
      (_command, args) => (
        args.includes('write')
          ? {status: 1, stdout: '', stderr: 'write failed'}
          : {status: 1, stdout: '', stderr: 'Domain not found'}
      ),
      warning => warnings.push(warning),
      message => logs.push(message)
    ),
    {changed: false, enabled: false}
  );
  assert.deepEqual(logs, []);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /write failed.*I\/O > Keyboard > Connect Hardware Keyboard/
  );
});
