const Keychain = require('react-native-keychain');
const { Platform } = require('react-native');
const { createSecureStorage } = require('../secure-storage');

const secureStorage = createSecureStorage({
  keychain: Keychain,
  platform: () => Platform.OS,
});

module.exports = {
  ...secureStorage,
  createSecureStorage,
};
