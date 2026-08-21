function requireService(service) {
  if (typeof service !== 'string' || !service.trim()) {
    throw new Error('Secure storage service must be a non-empty string.');
  }
  return service.trim();
}

function platformValue(platform) {
  return typeof platform === 'function' ? platform() : platform;
}

function secureSetOptions(keychain, platform, service) {
  const currentPlatform = platformValue(platform);
  if (currentPlatform === 'ios') {
    return {
      accessible: keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      service,
    };
  }
  if (currentPlatform === 'android') {
    return {
      securityLevel: keychain.SECURITY_LEVEL.SECURE_SOFTWARE,
      service,
    };
  }
  throw new Error('OnRamp secure storage supports iOS and Android only.');
}

function createSecureStorage({ keychain, platform }) {
  if (!keychain) throw new Error('react-native-keychain is required for secure storage.');

  async function setSecureValue(service, value, account = 'onramp') {
    const normalizedService = requireService(service);
    if (typeof value !== 'string') {
      throw new Error('Secure storage values must be strings.');
    }
    const saved = await keychain.setGenericPassword(
      String(account),
      value,
      secureSetOptions(keychain, platform, normalizedService)
    );
    if (!saved) {
      throw new Error(`Could not save secure value for ${normalizedService}.`);
    }
  }

  async function getSecureValue(service) {
    const normalizedService = requireService(service);
    const result = await keychain.getGenericPassword({ service: normalizedService });
    return result ? result.password : null;
  }

  async function removeSecureValue(service) {
    const normalizedService = requireService(service);
    return keychain.resetGenericPassword({ service: normalizedService });
  }

  async function setSecureJson(service, value, account = 'onramp') {
    await setSecureValue(service, JSON.stringify(value), account);
  }

  async function getSecureJson(service) {
    const value = await getSecureValue(service);
    return value === null ? null : JSON.parse(value);
  }

  return {
    getSecureJson,
    getSecureValue,
    removeSecureValue,
    setSecureJson,
    setSecureValue,
  };
}

module.exports = { createSecureStorage, secureSetOptions };
