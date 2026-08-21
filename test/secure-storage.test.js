const assert = require('node:assert/strict');
const test = require('node:test');

const { createSecureStorage, secureSetOptions } = require('../src/secure-storage');

function fakeKeychain() {
  const values = new Map();
  const calls = [];
  return {
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' },
    SECURITY_LEVEL: { SECURE_SOFTWARE: 'secure-software' },
    calls,
    async getGenericPassword(options) {
      calls.push(['get', options]);
      return values.get(options.service) || false;
    },
    async resetGenericPassword(options) {
      calls.push(['remove', options]);
      return values.delete(options.service);
    },
    async setGenericPassword(account, password, options) {
      calls.push(['set', account, password, options]);
      values.set(options.service, { username: account, password });
      return { service: options.service };
    },
  };
}

test('uses device-only iOS protection without enabling cloud sync', () => {
  const keychain = fakeKeychain();
  const options = secureSetOptions(keychain, 'ios', 'com.example.secret');

  assert.deepEqual(options, {
    accessible: 'device-only',
    service: 'com.example.secret',
  });
  assert.equal(Object.hasOwn(options, 'cloudSync'), false);
});

test('requires Android Keystore-backed software security', () => {
  const keychain = fakeKeychain();
  assert.deepEqual(
    secureSetOptions(keychain, 'android', 'com.example.secret'),
    {
      securityLevel: 'secure-software',
      service: 'com.example.secret',
    }
  );
});

test('stores, reads, and removes string and JSON values', async () => {
  const keychain = fakeKeychain();
  const storage = createSecureStorage({ keychain, platform: 'android' });

  await storage.setSecureValue('token', 'secret', 'account-id');
  assert.equal(await storage.getSecureValue('token'), 'secret');
  await storage.setSecureJson('settings', { enabled: true });
  assert.deepEqual(await storage.getSecureJson('settings'), { enabled: true });
  assert.equal(await storage.removeSecureValue('token'), true);
  assert.equal(await storage.getSecureValue('token'), null);
  assert.equal(keychain.calls[0][1], 'account-id');
});

test('rejects unsupported platforms and invalid values', async () => {
  const keychain = fakeKeychain();
  const webStorage = createSecureStorage({ keychain, platform: 'web' });
  await assert.rejects(
    webStorage.setSecureValue('token', 'secret'),
    /supports iOS and Android only/
  );
  const storage = createSecureStorage({ keychain, platform: 'ios' });
  await assert.rejects(storage.setSecureValue('', 'secret'), /non-empty string/);
  await assert.rejects(storage.setSecureValue('token', 42), /must be strings/);
});
