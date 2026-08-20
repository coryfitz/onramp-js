const path = require('path');

const WATCH_PATTERNS = [
  'app/**/*',
  'src/**/*',
  'assets/**/*',
  '*.{js,jsx,ts,tsx,json,cjs,mjs}',
];

function watchDiagnosticsEnabled(env = process.env) {
  return env.ONRAMP_WATCH_DIAGNOSTICS === '1';
}

function loadProjectChokidar(projectRoot) {
  const modulePath = require.resolve('chokidar', { paths: [projectRoot] });
  return require(modulePath);
}

function startWatchDiagnostics(
  projectRoot,
  env = process.env,
  { loadChokidar = loadProjectChokidar } = {}
) {
  if (!watchDiagnosticsEnabled(env)) {
    return null;
  }

  const root = path.resolve(projectRoot);
  const chokidar = loadChokidar(root);
  const watcher = chokidar.watch(WATCH_PATTERNS, {
    cwd: root,
    ignored: [
      '**/.git/**',
      '**/.onramp/**',
      '**/node_modules/**',
      'android/.gradle/**',
      'android/app/build/**',
      'ios/Pods/**',
      'ios/build/**',
    ],
    ignoreInitial: true,
    persistent: true,
  });

  console.log('Watch diagnostics enabled; source changes that can trigger Fast Refresh will appear below.');
  watcher.on('all', (eventName, filePath) => {
    console.log(`[watch-diagnostics] ${eventName}: ${filePath}`);
  });
  watcher.on('error', error => {
    console.error(`[watch-diagnostics] watcher error: ${error.message}`);
  });
  return watcher;
}

module.exports = {
  WATCH_PATTERNS,
  startWatchDiagnostics,
  watchDiagnosticsEnabled,
};
