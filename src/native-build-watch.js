const path = require('path');
const {
  SHARED_NATIVE_INPUTS,
  nativeBuildFingerprint,
} = require('./native-build-cache');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_FINGERPRINT_RETRIES = 3;
const NATIVE_WATCH_IGNORED = [
  '**/.git/**',
  '**/.onramp/**',
  '**/node_modules/**',
  'android/.cxx/**',
  'android/.gradle/**',
  'android/.kotlin/**',
  'android/**/build/**',
  'ios/DerivedData/**',
  'ios/Pods/**',
  'ios/**/build/**',
  'ios/**/xcuserdata/**',
];

function loadProjectChokidar(projectRoot) {
  const modulePath = require.resolve('chokidar', { paths: [projectRoot] });
  return require(modulePath);
}

function nativeWatchPlatforms(platform) {
  if (platform === 'ios' || platform === 'android') {
    return [platform];
  }
  if (platform === 'mobile') {
    return ['ios', 'android'];
  }
  throw new Error('Native build watching supports only ios, android, or mobile.');
}

function nativeWatchPatterns(platform) {
  return [
    ...SHARED_NATIVE_INPUTS,
    ...nativeWatchPlatforms(platform).map(value => `${value}/**/*`),
  ];
}

function nativeSessions(session) {
  if (!session) {
    return [];
  }
  if (session.android || session.ios) {
    return [session.android, session.ios].filter(Boolean);
  }
  return [session];
}

function startNativeBuildWatch(
  projectRoot,
  platform,
  session,
  {
    clearTimer = clearTimeout,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    fingerprint = nativeBuildFingerprint,
    initialFingerprints,
    loadChokidar = loadProjectChokidar,
    processTarget = process,
    fingerprintRetries = DEFAULT_FINGERPRINT_RETRIES,
    setTimer = setTimeout,
    warn = message => console.warn(message),
  } = {}
) {
  const root = path.resolve(projectRoot);
  const platforms = nativeWatchPlatforms(platform);
  const baseline = new Map(
    platforms.map(value => [
      value,
      initialFingerprints && initialFingerprints[value]
        ? initialFingerprints[value]
        : fingerprint(root, value),
    ])
  );
  const chokidar = loadChokidar(root);
  const watcher = chokidar.watch(nativeWatchPatterns(platform), {
    cwd: root,
    ignored: NATIVE_WATCH_IGNORED,
    ignoreInitial: true,
    persistent: true,
  });
  const sessions = nativeSessions(session);
  const activeChildren = new Set();
  const childExitHandlers = new Map();
  let closed = false;
  let pendingTimer = null;
  let retryCount = 0;
  let warned = false;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    processTarget.removeListener('SIGINT', close);
    processTarget.removeListener('SIGTERM', close);
    for (const [child, handler] of childExitHandlers) {
      child.removeListener('exit', handler);
    }
    childExitHandlers.clear();
    activeChildren.clear();
    watcher.close();
  };

  function checkForChanges() {
    if (closed || warned) {
      return;
    }
    try {
      const changed = platforms.some(value => (
        fingerprint(root, value) !== baseline.get(value)
      ));
      if (!changed) {
        retryCount = 0;
        return;
      }
      warned = true;
      warn(
        `Native build inputs changed while OnRamp ${platform} is running. `
        + 'Fast Refresh cannot apply native build changes to an app that is already installed. '
        + 'Press Ctrl+C, then rerun the same OnRamp command; OnRamp will rebuild the affected native app. '
        + 'If the problem remains, rerun with --rebuild.'
      );
    } catch (_error) {
      // A package manager may be replacing files while this check runs. Retry a
      // few times so its final atomic rename cannot hide a required rebuild.
      if (retryCount < fingerprintRetries) {
        retryCount += 1;
        scheduleCheck(false);
      }
    }
  }

  function scheduleCheck(resetRetries = true) {
    if (closed || warned) {
      return;
    }
    if (resetRetries) {
      retryCount = 0;
    }
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
    }
    pendingTimer = setTimer(() => {
      pendingTimer = null;
      checkForChanges();
    }, debounceMs);
  }

  watcher.on('all', () => scheduleCheck());
  // This closes the small gap between taking the baseline and chokidar
  // completing its initial directory scan.
  watcher.on('ready', checkForChanges);
  watcher.on('error', error => {
    if (closed) {
      return;
    }
    warn(`Warning: OnRamp could not monitor native build inputs: ${error.message}`);
  });

  processTarget.once('SIGINT', close);
  processTarget.once('SIGTERM', close);
  for (const candidate of sessions) {
    const child = candidate && candidate.child;
    if (!child || typeof child.once !== 'function') {
      continue;
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      continue;
    }
    activeChildren.add(child);
    const handleExit = () => {
      activeChildren.delete(child);
      childExitHandlers.delete(child);
      if (activeChildren.size === 0) {
        close();
      }
    };
    childExitHandlers.set(child, handleExit);
    child.once('exit', handleExit);
  }
  if (sessions.length > 0 && activeChildren.size === 0) {
    close();
  }

  return { close, watcher };
}

module.exports = {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_FINGERPRINT_RETRIES,
  NATIVE_WATCH_IGNORED,
  loadProjectChokidar,
  nativeWatchPatterns,
  nativeWatchPlatforms,
  startNativeBuildWatch,
};
