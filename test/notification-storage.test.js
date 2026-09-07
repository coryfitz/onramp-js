const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNotificationContactStorage} = require('../src/notification-storage');
const {createSecureStorage} = require('../src/secure-storage');
const {loadRuntime} = require('./helpers/runtime-ts');

const storageExports = [
  'getNotificationContact', 'saveNotificationContact',
  'clearNotificationContact', 'clearAllNotificationContacts',
];
const service = 'onramp.notification.contacts';
const time = Date.parse('2026-09-07T00:00:00Z');
const contact = {
  email: 'person@example.test', token: 'notification-secret',
  expiresAt: null,
};

function fakeKeychain() {
  const values = new Map();
  const calls = [];
  return {
    values, calls,
    ACCESSIBLE: {WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only'},
    SECURITY_LEVEL: {SECURE_SOFTWARE: 'secure-software'},
    async setGenericPassword(account, password, options) {
      calls.push({operation: 'set', account, options});
      values.set(options.service, {password});
      return {service: options.service};
    },
    async getGenericPassword(options) {
      calls.push({operation: 'get', options});
      return values.get(options.service) || false;
    },
    async resetGenericPassword(options) {
      calls.push({operation: 'remove', options});
      return values.delete(options.service);
    },
  };
}

function harness({platform = 'ios'} = {}) {
  const keychain = fakeKeychain();
  const secure = createSecureStorage({keychain, platform});
  return {
    keychain, secure,
    storage: createNotificationContactStorage({storage: secure}),
  };
}

test('native runtime persists a scoped contact with device-only iOS protection', async () => {
  const {keychain, secure} = harness();
  const imports = {
    '../notification-storage': {createNotificationContactStorage},
    './secure-storage': secure,
  };
  const native = loadRuntime('notification-storage.ts', storageExports, imports);
  await native.saveNotificationContact('https://API.example.test:443/v1/', {
    ...contact, email: ' Person@Example.Test ',
  });
  const set = keychain.calls.find(call => call.operation === 'set');
  assert.deepEqual(set.options, {accessible: 'device-only', service});
  assert.equal(set.account, 'notification-contacts');
  assert.equal(keychain.values.size, 1);
  // A new runtime instance simulates a cold launch using the same Keychain.
  const restored = loadRuntime('notification-storage.ts', storageExports, imports);
  assert.deepEqual(await restored.getNotificationContact('https://api.example.test/v1'), contact);
  assert.equal(await restored.getNotificationContact('http://api.example.test/v1'), null);
  assert.equal(await restored.getNotificationContact('https://api.example.test/v2'), null);
  assert.equal(await restored.getNotificationContact('https://api.example.test'), null);
});

test('remembered contacts use Android secure storage options', async () => {
  const {storage, keychain} = harness({platform: 'android'});
  await storage.saveNotificationContact('https://api.example.test', contact);
  assert.deepEqual(keychain.calls.find(call => call.operation === 'set').options, {
    securityLevel: 'secure-software', service,
  });
});

test('normalizes scopes when native URL preserves hostname case and default ports', async () => {
  class NativeURL extends URL {
    constructor(input) {
      super(input);
      this.nativeOrigin = input.match(/^https?:\/\/[^/]+/)[0];
    }
    get origin() { return this.nativeOrigin; }
  }
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'notification-storage.js'), 'utf8'), {
    URL: NativeURL, module,
  });
  const {secure} = harness();
  const storage = module.exports.createNotificationContactStorage({storage: secure});
  await storage.saveNotificationContact('HTTPS://API.Example.Test:0443/v1/', contact);
  assert.equal((await storage.getNotificationContact('https://api.example.test/v1')).token, contact.token);
  await storage.saveNotificationContact('http://LOCALHOST:8081/backend/', contact);
  assert.equal((await storage.getNotificationContact('http://localhost:8081/backend')).token, contact.token);
  assert.equal(await storage.getNotificationContact('http://localhost:8082/backend'), null);
  for (const apiBaseUrl of ['http://127.0.0.1:8000', 'http://10.0.2.2:8000', 'https://api.swerve.company']) {
    assert.equal(await storage.getNotificationContact(apiBaseUrl), null);
    await storage.saveNotificationContact(apiBaseUrl, contact);
    assert.equal((await storage.getNotificationContact(`${apiBaseUrl}/`)).token, contact.token);
  }
});

test('concurrent saves preserve every scope and ordered clear-all leaves no index behind', async () => {
  const {storage, keychain} = harness();
  await Promise.all(Array.from({length: 20}, (_, i) => storage.saveNotificationContact(
    `https://api.example.test/${i}`, {...contact, token: `secret-${i}`},
  )));
  for (let i = 0; i < 20; i++) {
    assert.equal((await storage.getNotificationContact(`https://api.example.test/${i}`)).token, `secret-${i}`);
  }
  await Promise.all([
    storage.clearNotificationContact('https://api.example.test/0/'),
    storage.saveNotificationContact('https://api.example.test/20', contact),
  ]);
  assert.equal(await storage.getNotificationContact('https://api.example.test/0'), null);
  assert.deepEqual(await storage.getNotificationContact('https://api.example.test/20'), contact);
  await Promise.all([
    storage.saveNotificationContact('https://dev.example.test', contact),
    storage.clearAllNotificationContacts(),
  ]);
  assert.equal(keychain.values.size, 0);
  assert.equal(await storage.getNotificationContact('https://api.example.test/20'), null);
});

test('restores indefinite and legacy finite records years later without consulting the device clock', async () => {
  const {storage, secure, keychain} = harness();
  const legacyContact = {...contact, expiresAt: new Date(time + 1000).toISOString()};
  await storage.saveNotificationContact('https://legacy.example.test', legacyContact);
  await storage.saveNotificationContact('https://indefinite.example.test', contact);
  class FutureDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2199-01-01T00:00:00Z']));
    }
    static now() { throw new Error('The device clock is unavailable.'); }
  }
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'notification-storage.js'), 'utf8'), {
    URL, Date: FutureDate, module,
  });
  const restored = module.exports.createNotificationContactStorage({storage: secure});
  assert.deepEqual({...await restored.getNotificationContact('https://legacy.example.test')}, legacyContact);
  assert.deepEqual({...await restored.getNotificationContact('https://indefinite.example.test')}, contact);
  await restored.saveNotificationContact('https://fresh.example.test', contact);
  assert.deepEqual({...await restored.getNotificationContact('https://fresh.example.test')}, contact);
  const stored = JSON.parse(keychain.values.get(service).password);
  assert.deepEqual(stored.contacts['https://legacy.example.test'], legacyContact);
  assert.deepEqual(stored.contacts['https://indefinite.example.test'], contact);
});

test('malformed secure data fails closed and gets removed', async () => {
  const {storage, keychain} = harness();
  for (const password of ['invalid json', 'null', '{"version":2,"contacts":{}}', JSON.stringify({
    version: 1, contacts: {
      'https://api.example.test': {...contact, token: 'bad\r\nheader'},
      'https://other.example.test': {...contact, email: 'not-an-email'},
      'https://missing.example.test': {...contact, expiresAt: undefined},
      'https://malformed.example.test': {...contact, expiresAt: 'invalid'},
      'https://API.example.test/': contact,
    },
  })]) {
    keychain.values.set(service, {password});
    assert.equal(await storage.getNotificationContact('https://api.example.test'), null);
    assert.equal(keychain.values.size, 0);
  }
});

test('rejects invalid scope, contact and expiration values without storing them', async () => {
  const {storage, keychain} = harness();
  for (const apiBaseUrl of ['', 'bad url', 'ftp://example.test', 'https://user:secret@example.test',
    'https://api.example.test/?secret=1', 'https://api.example.test/#fragment',
    'https://api example.test', 'https://api.example.test:65536']) {
    await assert.rejects(storage.saveNotificationContact(apiBaseUrl, contact));
  }
  for (const invalid of [null, {...contact, email: ''}, {...contact, token: ''},
    {...contact, token: 'bad token'}, {...contact, token: 'a'.repeat(8193)},
    {...contact, expiresAt: '2099'}, {...contact, expiresAt: undefined},
    {...contact, expiresAt: ''}, {...contact, expiresAt: false},
    {...contact, expiresAt: 0}, {...contact, expiresAt: '2099-13-01T00:00:00Z'}]) {
    await assert.rejects(storage.saveNotificationContact('https://api.example.test', invalid));
  }
  assert.equal(keychain.values.size, 0);
  await storage.saveNotificationContact('https://api.example.test', contact);
  assert.deepEqual(await storage.getNotificationContact('https://api.example.test'), contact);
});

test('a failed secure write rejects without poisoning later operations', async () => {
  const {secure} = harness();
  let fail = true;
  const storage = createNotificationContactStorage({
    storage: {
      ...secure,
      async setSecureValue(...args) {
        if (fail) {
          fail = false;
          throw new Error('Device is locked.');
        }
        return secure.setSecureValue(...args);
      },
    },
  });
  await assert.rejects(storage.saveNotificationContact('https://api.example.test', contact), /Device is locked/);
  await storage.saveNotificationContact('https://api.example.test', contact);
  assert.deepEqual(await storage.getNotificationContact('https://api.example.test'), contact);
});

test('web runtime keeps notification capability only in page memory', async () => {
  const persistentStorage = new Proxy({}, {
    get() { throw new Error('Browser persistence must never be accessed.'); },
  });
  const imports = {'../notification-storage': {createNotificationContactStorage}};
  const globals = {localStorage: persistentStorage, sessionStorage: persistentStorage};
  const web = loadRuntime('notification-storage.web.ts', storageExports, imports, globals);
  await web.saveNotificationContact('https://api.example.test', contact);
  assert.deepEqual(await web.getNotificationContact('https://api.example.test'), contact);
  const reloaded = loadRuntime('notification-storage.web.ts', storageExports, imports, globals);
  assert.equal(await reloaded.getNotificationContact('https://api.example.test'), null);
  await web.clearAllNotificationContacts();
  assert.equal(await web.getNotificationContact('https://api.example.test'), null);
});
