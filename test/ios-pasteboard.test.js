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

test('restarts clipboard synchronization after an unexpected clean relay exit', () => {
  const warnings = [];
  const logs = [];
  const timers = [];
  const children = [fakeChild(), fakeChild()];
  let spawnIndex = 0;
  const sync = startIosPasteboardSync(simulator, environment, {
    captureCommand: () => ({status: 0, stdout: '', stderr: ''}),
    log: message => logs.push(message),
    retryDelaysMs: [100, 200],
    scheduleRetry: (callback, delay) => {
      const timer = {callback, delay};
      timers.push(timer);
      return timer;
    },
    spawnCommand: () => children[spawnIndex++],
    warn: message => warnings.push(message),
  });

  children[0].emit('exit', 0, null);

  assert.deepEqual(warnings, [
    'Warning: iOS clipboard sharing was interrupted for iPhone 18 Pro: '
      + 'status 0. Reconnecting automatically.',
  ]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 100);
  assert.equal(sync.child, null);

  timers[0].callback();
  assert.equal(sync.child, children[1]);
  assert.deepEqual(logs, [
    '✓ Mac and iPhone 18 Pro clipboards are synchronized',
    '✓ Mac and iPhone 18 Pro clipboards are synchronized again',
  ]);
});

test('backs off while a disconnected simulator is unavailable, then recovers', () => {
  const warnings = [];
  const logs = [];
  const timers = [];
  const children = [fakeChild(), fakeChild()];
  const inspections = [
    {status: 0, stdout: '', stderr: ''},
    {status: 1, stdout: '', stderr: 'The device is unavailable'},
    {status: 0, stdout: '', stderr: ''},
  ];
  let spawnIndex = 0;
  const sync = startIosPasteboardSync(simulator, environment, {
    captureCommand: () => inspections.shift(),
    log: message => logs.push(message),
    retryDelaysMs: [100, 200],
    scheduleRetry: (callback, delay) => {
      const timer = {callback, delay};
      timers.push(timer);
      return timer;
    },
    spawnCommand: () => children[spawnIndex++],
    warn: message => warnings.push(message),
  });

  children[0].emit('exit', 1, null);
  assert.equal(timers[0].delay, 100);
  timers[0].callback();
  assert.equal(timers[1].delay, 200);
  assert.equal(sync.child, null);
  timers[1].callback();

  assert.equal(sync.child, children[1]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Reconnecting automatically/);
  assert.deepEqual(logs, [
    '✓ Mac and iPhone 18 Pro clipboards are synchronized',
    '✓ Mac and iPhone 18 Pro clipboards are synchronized again',
  ]);
});

test('does not schedule duplicate restarts when one child errors and exits', () => {
  const timers = [];
  const child = fakeChild();
  startIosPasteboardSync(simulator, environment, {
    captureCommand: () => ({status: 0, stdout: '', stderr: ''}),
    log: () => {},
    scheduleRetry: (callback, delay) => {
      const timer = {callback, delay};
      timers.push(timer);
      return timer;
    },
    spawnCommand: () => child,
    warn: () => {},
  });

  child.emit('error', new Error('connection failed'));
  child.emit('exit', 1, null);
  assert.equal(timers.length, 1);
});

test('stopping during reconnect backoff cancels the retry and completes the session', async () => {
  const timers = [];
  const cancelled = [];
  const child = fakeChild();
  let spawnCount = 0;
  const sync = startIosPasteboardSync(simulator, environment, {
    cancelRetry: timer => cancelled.push(timer),
    captureCommand: () => ({status: 0, stdout: '', stderr: ''}),
    log: () => {},
    scheduleRetry: (callback, delay) => {
      const timer = {callback, delay};
      timers.push(timer);
      return timer;
    },
    spawnCommand: () => {
      spawnCount += 1;
      return child;
    },
    warn: () => {},
  });

  child.emit('exit', 1, null);
  sync.stop('SIGTERM');
  await sync.completion;

  assert.deepEqual(cancelled, [timers[0]]);
  timers[0].callback();
  assert.equal(spawnCount, 1);
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
