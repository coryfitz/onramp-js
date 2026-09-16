const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  attachIosPasteboardSync,
  startIosPasteboardSync,
} = require('../src/ios');

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stderr = new EventEmitter();
  child.kill = signal => {
    child.killed = true;
    child.signal = signal;
  };
  return child;
}

const environment = {
  env: {EXAMPLE: 'value'},
  xcrun: '/usr/bin/xcrun',
};

const simulator = {
  id: 'SIMULATOR-ID',
  name: 'iPhone 18 Pro',
};

test('starts private bidirectional pasteboard sync for the exact iOS simulator', () => {
  const captures = [];
  const spawns = [];
  const logs = [];
  const child = fakeChild();

  const sync = startIosPasteboardSync(simulator, environment, {
    captureCommand: (command, args, options) => {
      captures.push([command, args, options]);
      return {status: 0, stdout: '', stderr: ''};
    },
    log: message => logs.push(message),
    sessionSeconds: 900,
    spawnCommand: (command, args, options) => {
      spawns.push([command, args, options]);
      return child;
    },
  });

  assert.equal(sync.child, child);
  assert.deepEqual(captures, [[
    '/usr/bin/xcrun',
    [
      'devicectl', 'device', 'pasteboard', 'info',
      '--device', 'SIMULATOR-ID', '--timeout', '5', '--quiet',
    ],
    {env: environment.env, check: false},
  ]]);
  assert.deepEqual(spawns, [[
    '/usr/bin/xcrun',
    [
      'devicectl', 'device', 'pasteboard', 'sync-with-host',
      '--device', 'SIMULATOR-ID',
      '--session-timeout', '900',
      '--timeout', '901',
      '--quiet',
    ],
    {
      env: environment.env,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  ]]);
  assert.deepEqual(logs, ['✓ Mac and iPhone 18 Pro clipboards are synchronized']);

  sync.stop('SIGINT');
  assert.equal(child.killed, true);
  assert.equal(child.signal, 'SIGINT');
});

test('keeps app launch nonfatal when the pasteboard command is unavailable', () => {
  const warnings = [];
  const sync = startIosPasteboardSync(simulator, environment, {
    captureCommand: () => {
      throw new Error('devicectl is unavailable');
    },
    spawnCommand: () => assert.fail('sync must not start after inspection fails'),
    warn: message => warnings.push(message),
  });

  assert.equal(sync, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /devicectl is unavailable/);
});

test('does not start clipboard sync when Device Hub cannot access the simulator', () => {
  const warnings = [];
  const sync = startIosPasteboardSync(simulator, environment, {
    captureCommand: () => ({
      status: 1,
      stdout: '',
      stderr: 'The device is unavailable',
    }),
    spawnCommand: () => assert.fail('sync must not start without device access'),
    warn: message => warnings.push(message),
  });

  assert.equal(sync, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not prepare clipboard sharing/);
  assert.match(warnings[0], /The device is unavailable/);
  assert.match(warnings[0], /Reopen the selected simulator in Device Hub/);
});

test('reports an unexpected clipboard sync exit without exposing normal output', () => {
  const warnings = [];
  const child = fakeChild();
  startIosPasteboardSync(simulator, environment, {
    captureCommand: () => ({status: 0, stdout: '', stderr: ''}),
    log: () => {},
    spawnCommand: () => child,
    warn: message => warnings.push(message),
  });

  child.stderr.emit('data', Buffer.from('connection failed'));
  child.emit('exit', 1, null);

  assert.deepEqual(warnings, [
    'Warning: iOS clipboard sharing stopped unexpectedly for iPhone 18 Pro '
      + 'with status 1: connection failed',
  ]);
});

test('stops clipboard sync with Metro whether Metro is stopped or exits', async t => {
  await t.test('explicit stop', () => {
    const metroChild = new EventEmitter();
    const calls = [];
    const metro = {
      child: metroChild,
      stop: signal => calls.push(['metro', signal]),
    };
    const sync = {stop: signal => calls.push(['clipboard', signal])};

    assert.equal(attachIosPasteboardSync(metro, sync), metro);
    assert.equal(metro.pasteboardSync, sync);
    metro.stop('SIGINT');
    assert.deepEqual(calls, [
      ['clipboard', 'SIGINT'],
      ['metro', 'SIGINT'],
    ]);
  });

  await t.test('Metro child exit', () => {
    const metroChild = new EventEmitter();
    const calls = [];
    const metro = {child: metroChild, stop: () => {}};
    attachIosPasteboardSync(metro, {
      stop: signal => calls.push(signal),
    });

    metroChild.emit('exit', 0, null);
    assert.deepEqual(calls, ['SIGTERM']);
  });
});
