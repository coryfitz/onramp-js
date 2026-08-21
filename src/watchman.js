const { capture, findExecutable } = require('./process');

function inspectWatchman({
  env = process.env,
  finder = findExecutable,
  captureCommand = capture,
} = {}) {
  const executable = finder('watchman', env);
  if (!executable) {
    return { status: 'missing' };
  }

  let result;
  try {
    result = captureCommand(executable, ['--version'], {
      env,
      check: false,
    });
  } catch (error) {
    return {
      detail: error.message,
      executable,
      status: 'broken',
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return {
      detail: detail || `exited with status ${result.status}`,
      executable,
      status: 'broken',
    };
  }

  return {
    executable,
    status: 'ready',
    version: result.stdout.trim() || 'unknown',
  };
}

function watchmanRepairMessage(health) {
  const detail = health.detail ? `: ${health.detail}` : '';
  const repair = process.platform === 'darwin'
    ? ' Run `brew update && brew reinstall watchman`, then retry.'
    : ' Repair or remove Watchman, then retry.';
  return `Watchman was found at ${health.executable} but could not run${detail}.${repair}`;
}

function doctorWatchman(options = {}) {
  const health = inspectWatchman(options);
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    console.log(
      'Metro will use the native macOS file watcher to keep Fast Refresh stable.'
    );
    return health;
  }
  if (health.status === 'broken') {
    throw new Error(watchmanRepairMessage(health));
  }
  if (health.status === 'missing') {
    console.log('Watchman is not installed; Metro will use the native file watcher.');
    return health;
  }

  console.log(`Using Watchman ${health.version}`);
  return health;
}

function metroWatchmanConfig(options = {}) {
  const health = inspectWatchman(options);
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    console.log(
      'Metro is using the native macOS file watcher to avoid metadata-only Fast Refresh cycles.'
    );
  } else if (health.status === 'broken') {
    console.warn(`Warning: ${watchmanRepairMessage(health)}`);
    console.warn('Metro is disabling Watchman and using the native file watcher.');
  } else if (health.status === 'missing') {
    console.log('Watchman is not installed; Metro is using the native file watcher.');
  }
  return {
    health,
    useWatchman: platform !== 'darwin' && health.status === 'ready',
  };
}

module.exports = {
  doctorWatchman,
  inspectWatchman,
  metroWatchmanConfig,
  watchmanRepairMessage,
};
