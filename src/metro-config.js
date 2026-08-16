const path = require('path');
const { generateRoutesConfig, watchRoutesConfig } = require('./routes');

function shouldWatchRoutes(argv = process.argv) {
  return argv.includes('start');
}

function createMetroConfig(projectRoot = process.cwd()) {
  const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
  const root = path.resolve(projectRoot);
  process.env.ONRAMP_PLATFORM = process.env.ONRAMP_PLATFORM || 'native';
  generateRoutesConfig(root);
  if (shouldWatchRoutes()) {
    const routeWatcher = watchRoutesConfig(root);
    process.once('exit', () => routeWatcher.close());
  }

  return mergeConfig(getDefaultConfig(root), {
    resolver: { platforms: ['ios', 'android', 'native'] },
  });
}

module.exports = { createMetroConfig, shouldWatchRoutes };
