const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const {generateRoutesConfig, watchRoutesConfig} = require('./generateRoutes');

process.env.ONRAMP_PLATFORM = process.env.ONRAMP_PLATFORM || 'native';
generateRoutesConfig();
const routeWatcher = watchRoutesConfig();
process.once('exit', () => routeWatcher.close());

const defaultConfig = getDefaultConfig(__dirname);

const config = {
  resolver: { platforms: ['ios', 'android', 'native'] },
};

module.exports = mergeConfig(defaultConfig, config);
