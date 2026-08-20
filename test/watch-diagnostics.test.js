const assert = require('node:assert/strict');
const test = require('node:test');

const {
  startWatchDiagnostics,
  watchDiagnosticsEnabled,
} = require('../src/watch-diagnostics');

test('watch diagnostics are opt-in', () => {
  assert.equal(watchDiagnosticsEnabled({}), false);
  assert.equal(
    watchDiagnosticsEnabled({ ONRAMP_WATCH_DIAGNOSTICS: '1' }),
    true
  );
});

test('watch diagnostics report exact project-relative source events', () => {
  const handlers = {};
  const messages = [];
  const watcher = {
    close() {},
    on(eventName, handler) {
      handlers[eventName] = handler;
      return this;
    },
  };
  const originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    const result = startWatchDiagnostics(
      '/tmp/example',
      { ONRAMP_WATCH_DIAGNOSTICS: '1' },
      {
        loadChokidar: () => ({
          watch(patterns, options) {
            assert.ok(patterns.includes('app/**/*'));
            assert.equal(options.cwd, '/tmp/example');
            assert.equal(options.ignoreInitial, true);
            return watcher;
          },
        }),
      }
    );

    assert.equal(result, watcher);
    handlers.all('change', 'app/index.tsx');
    assert.match(
      messages.join('\n'),
      /\[watch-diagnostics\] change: app\/index\.tsx/
    );
  } finally {
    console.log = originalLog;
  }
});
