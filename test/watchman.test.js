const assert = require('node:assert/strict');
const test = require('node:test');

const {
  doctorWatchman,
  inspectWatchman,
  metroWatchmanConfig,
} = require('../src/watchman');

test('reports a healthy Watchman binary and enables it for Metro', () => {
  const options = {
    finder: () => '/usr/local/bin/watchman',
    captureCommand: () => ({
      status: 0,
      stderr: '',
      stdout: '2026.07.27.00\n',
    }),
  };

  assert.deepEqual(inspectWatchman(options), {
    executable: '/usr/local/bin/watchman',
    status: 'ready',
    version: '2026.07.27.00',
  });
  assert.equal(metroWatchmanConfig(options).useWatchman, true);
});

test('explicit doctor rejects an installed but broken Watchman', () => {
  const options = {
    finder: () => '/opt/homebrew/bin/watchman',
    captureCommand: () => ({
      status: null,
      stderr: 'dyld: Library not loaded: libfmt.11.dylib',
      stdout: '',
    }),
  };

  assert.throws(
    () => doctorWatchman(options),
    /Watchman was found.*libfmt\.11\.dylib.*retry/s
  );
});

test('Metro disables a broken Watchman instead of relying on implicit fallback', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    const result = metroWatchmanConfig({
      finder: () => '/opt/homebrew/bin/watchman',
      captureCommand: () => ({ status: 1, stderr: 'broken', stdout: '' }),
    });

    assert.equal(result.useWatchman, false);
    assert.match(warnings.join('\n'), /disabling Watchman/);
  } finally {
    console.warn = originalWarn;
  }
});

test('Metro uses its native watcher when Watchman is absent', () => {
  const messages = [];
  const originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    const result = metroWatchmanConfig({ finder: () => null });
    assert.equal(result.useWatchman, false);
    assert.match(messages.join('\n'), /native file watcher/);
  } finally {
    console.log = originalLog;
  }
});
