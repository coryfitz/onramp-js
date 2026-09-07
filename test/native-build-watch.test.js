const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NATIVE_WATCH_IGNORED,
  nativeWatchPatterns,
  nativeWatchPlatforms,
  startNativeBuildWatch,
} = require('../src/native-build-watch');
const { monitorNativeBuildInputs, runFrontend } = require('../src/run');

class FakeWatcher extends EventEmitter {
  constructor() {
    super();
    this.closeCount = 0;
  }

  close() {
    this.closeCount += 1;
  }
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-native-watch-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'ios'));
  fs.mkdirSync(path.join(root, 'android'));
  fs.writeFileSync(path.join(root, 'app.json'), '{"name":"Example"}\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"example"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'app', 'index.tsx'), 'export default 1;\n');
  fs.writeFileSync(path.join(root, 'ios', 'Podfile'), 'platform :ios, "15.1"\n');
  fs.writeFileSync(
    path.join(root, 'android', 'settings.gradle'),
    'rootProject.name="Example"\n'
  );
  return root;
}

function makeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    clearTimer(id) {
      callbacks.delete(id);
    },
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) {
        callback();
      }
    },
    get size() {
      return callbacks.size;
    },
    setTimer(callback) {
      nextId += 1;
      callbacks.set(nextId, callback);
      return nextId;
    },
  };
}

function makeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  return child;
}

function startHarness(root, platform = 'ios', session = null, overrides = {}) {
  const watcher = new FakeWatcher();
  const processTarget = new EventEmitter();
  const timers = makeTimers();
  const warnings = [];
  let watchCall;
  const control = startNativeBuildWatch(root, platform, session, {
    clearTimer: timers.clearTimer,
    loadChokidar: () => ({
      watch(patterns, options) {
        watchCall = { options, patterns };
        return watcher;
      },
    }),
    processTarget,
    setTimer: timers.setTimer,
    warn: message => warnings.push(message),
    ...overrides,
  });
  return {
    control,
    processTarget,
    timers,
    warnings,
    watchCall,
    watcher,
  };
}

test('watches the shared manifests and only the selected native platform', () => {
  assert.deepEqual(nativeWatchPlatforms('mobile'), ['ios', 'android']);
  assert.deepEqual(nativeWatchPatterns('ios'), [
    'app.json',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'ios/**/*',
  ]);
  assert.throws(() => nativeWatchPlatforms('web'), /ios, android, or mobile/);

  const root = makeProject();
  try {
    const harness = startHarness(root);
    assert.equal(harness.watchCall.options.cwd, root);
    assert.equal(harness.watchCall.options.ignoreInitial, true);
    assert.equal(harness.watchCall.options.persistent, true);
    assert.deepEqual(harness.watchCall.options.ignored, NATIVE_WATCH_IGNORED);
    harness.control.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('debounces native dependency changes and warns only once per run', () => {
  const root = makeProject();
  try {
    const harness = startHarness(root, 'ios');
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"new-native-module":{}}}\n'
    );
    harness.watcher.emit('all', 'change', 'package.json');
    harness.watcher.emit('all', 'change', 'package-lock.json');
    assert.equal(harness.timers.size, 1);
    harness.timers.flush();

    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], /Fast Refresh cannot apply native build changes/);
    assert.match(harness.warnings[0], /Press Ctrl\+C, then rerun the same OnRamp command/);
    assert.match(harness.warnings[0], /--rebuild/);

    fs.appendFileSync(path.join(root, 'ios', 'Podfile'), '# another change\n');
    harness.watcher.emit('all', 'change', 'ios/Podfile');
    harness.timers.flush();
    assert.equal(harness.warnings.length, 1);
    harness.control.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects package metadata and selected-platform native changes', () => {
  const cases = [
    ['ios', 'package.json'],
    ['ios', 'ios/Podfile'],
    ['android', 'android/settings.gradle'],
  ];
  for (const [platform, relativePath] of cases) {
    const root = makeProject();
    try {
      const harness = startHarness(root, platform);
      fs.appendFileSync(path.join(root, relativePath), '\nchanged\n');
      harness.watcher.emit('all', 'change', relativePath);
      harness.timers.flush();
      assert.equal(
        harness.warnings.length,
        1,
        `${relativePath} did not require a ${platform} rebuild`
      );
      harness.control.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('ignores application source, generated output, and the other platform', () => {
  const root = makeProject();
  try {
    const harness = startHarness(root, 'ios');
    fs.writeFileSync(path.join(root, 'app', 'index.tsx'), 'export default 2;\n');
    fs.mkdirSync(path.join(root, 'ios', 'build'));
    fs.writeFileSync(path.join(root, 'ios', 'build', 'generated'), 'changed');
    fs.appendFileSync(
      path.join(root, 'android', 'settings.gradle'),
      '# Android-only change\n'
    );
    harness.watcher.emit('all', 'change', 'app/index.tsx');
    harness.watcher.emit('all', 'change', 'ios/build/generated');
    harness.watcher.emit('all', 'change', 'android/settings.gradle');
    harness.timers.flush();

    assert.deepEqual(harness.warnings, []);
    harness.control.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mobile uses one warning and stays active until both Metro children exit', () => {
  const root = makeProject();
  const android = makeChild();
  const ios = makeChild();
  try {
    const harness = startHarness(root, 'mobile', {
      android: { child: android },
      ios: { child: ios },
    });
    assert.deepEqual(harness.watchCall.patterns.slice(-2), [
      'ios/**/*',
      'android/**/*',
    ]);
    fs.appendFileSync(
      path.join(root, 'android', 'settings.gradle'),
      '# native change\n'
    );
    harness.watcher.emit('all', 'change', 'android/settings.gradle');
    harness.timers.flush();
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], /OnRamp mobile/);

    android.exitCode = 0;
    android.emit('exit', 0);
    assert.equal(harness.watcher.closeCount, 0);
    ios.exitCode = 0;
    ios.emit('exit', 0);
    assert.equal(harness.watcher.closeCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('signal cleanup cancels pending checks and closes idempotently', () => {
  const root = makeProject();
  const child = makeChild();
  try {
    const harness = startHarness(root, 'android', { child });
    fs.appendFileSync(
      path.join(root, 'android', 'settings.gradle'),
      '# native change\n'
    );
    harness.watcher.emit('all', 'change', 'android/settings.gradle');
    assert.equal(harness.timers.size, 1);

    harness.processTarget.emit('SIGINT');
    assert.equal(harness.timers.size, 0);
    assert.equal(harness.watcher.closeCount, 1);
    harness.control.close();
    assert.equal(harness.watcher.closeCount, 1);
    harness.timers.flush();
    assert.deepEqual(harness.warnings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ready checks detect a change made while chokidar starts', () => {
  const root = makeProject();
  try {
    const harness = startHarness(root, 'ios');
    fs.appendFileSync(path.join(root, 'ios', 'Podfile'), '# startup race\n');
    harness.watcher.emit('ready');
    assert.equal(harness.warnings.length, 1);
    harness.control.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses the pre-build fingerprint to detect changes made during launch', () => {
  const root = makeProject();
  try {
    const harness = startHarness(root, 'ios', null, {
      initialFingerprints: { ios: 'before-native-build' },
    });
    harness.watcher.emit('ready');
    assert.equal(harness.warnings.length, 1);
    harness.control.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('monitoring forwards the session pre-build fingerprint', () => {
  const session = {
    nativeBuildBaseline: { ios: 'before-native-build' },
  };
  let call;
  monitorNativeBuildInputs('/tmp/example', 'ios', session, (...args) => {
    call = args;
    return { close() {} };
  });
  assert.equal(call[0], '/tmp/example');
  assert.equal(call[1], 'ios');
  assert.equal(call[2], session);
  assert.deepEqual(call[3], {
    initialFingerprints: session.nativeBuildBaseline,
  });
});

test('retries a fingerprint interrupted by an atomic package replacement', () => {
  const root = makeProject();
  let fingerprintCalls = 0;
  try {
    const harness = startHarness(root, 'ios', null, {
      fingerprint() {
        fingerprintCalls += 1;
        if (fingerprintCalls === 1) {
          return 'before';
        }
        if (fingerprintCalls === 2) {
          throw new Error('file replaced during read');
        }
        return 'after';
      },
    });
    harness.watcher.emit('all', 'change', 'package-lock.json');
    harness.timers.flush();
    assert.equal(harness.warnings.length, 0);
    assert.equal(harness.timers.size, 1);
    harness.timers.flush();
    assert.equal(harness.warnings.length, 1);
    harness.control.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frontend runs attach exactly one watcher to each native session', async () => {
  for (const platform of ['ios', 'android', 'mobile']) {
    const root = makeProject();
    const session = { platform };
    const monitorCalls = [];
    const dependencies = {
      doctorWeb() {},
      monitorNativeBuildInputs(...args) {
        monitorCalls.push(args);
      },
      runAndroid: async () => session,
      runIos: async () => session,
      runMobile: async () => session,
      writeRuntimeConfig() {},
    };
    try {
      await runFrontend({ output: root, platform }, dependencies);
      assert.deepEqual(monitorCalls, [[root, platform, session]]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('web runs never attach the native input watcher', async () => {
  const root = makeProject();
  let monitored = false;
  try {
    await runFrontend(
      { output: root, platform: 'web' },
      {
        doctorWeb() {},
        monitorNativeBuildInputs() {
          monitored = true;
        },
        runWeb() {},
        writeRuntimeConfig() {},
      }
    );
    assert.equal(monitored, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
