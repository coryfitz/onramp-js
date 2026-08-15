const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

const config = {
  resolver: { platforms: ['ios', 'android', 'native'] },
};

module.exports = mergeConfig(defaultConfig, config);
