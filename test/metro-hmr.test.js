const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isEmptyHmrUpdate,
  patchHmrServerClass,
  suppressEmptyMetroHmrUpdates,
} = require('../src/metro-hmr');

function update({ added = [], modified = [], deleted = [] } = {}) {
  return {
    type: 'update',
    body: {
      added,
      modified,
      deleted,
      isInitialUpdate: false,
      revisionId: 'revision-1',
    },
  };
}

function fakeHmrServerClass() {
  return class FakeHmrServer {
    constructor(message) {
      this.message = message;
      this.initialCalls = 0;
      this.prepareCalls = 0;
    }

    async _handleFileChange() {
      this.initialCalls += 1;
    }

    async _prepareMessage() {
      this.prepareCalls += 1;
      return this.message;
    }
  };
}

function clientGroup(messages) {
  return {
    clients: new Set([
      {
        sendFn(serialized) {
          messages.push(JSON.parse(serialized));
        },
      },
    ]),
  };
}

test('recognizes only HMR updates with no module changes', () => {
  assert.equal(isEmptyHmrUpdate(update()), true);
  assert.equal(isEmptyHmrUpdate(update({ modified: [[1, 'code']] })), false);
  assert.equal(isEmptyHmrUpdate({ type: 'error', body: {} }), false);
});

test('suppresses non-initial empty HMR cycles before clients see Refreshing', async () => {
  const HmrServer = fakeHmrServerClass();
  const messages = [];
  const points = [];
  const endings = [];
  const logger = {
    point(value) {
      points.push(value);
    },
    end(value) {
      endings.push(value);
    },
  };

  assert.equal(patchHmrServerClass(HmrServer), true);
  const server = new HmrServer(update());
  await server._handleFileChange(
    clientGroup(messages),
    { isInitialUpdate: false },
    { changeId: 'metadata-only', logger }
  );

  assert.equal(server.prepareCalls, 1);
  assert.deepEqual(messages, []);
  assert.deepEqual(points, [
    'fileChange_end',
    'hmrPrepareAndSendMessage_start',
    'hmrPrepareAndSendMessage_end',
  ]);
  assert.deepEqual(endings, ['SUCCESS']);
});

test('preserves real updates, errors, initial registration, and patch idempotence', async () => {
  const HmrServer = fakeHmrServerClass();
  assert.equal(patchHmrServerClass(HmrServer), true);
  assert.equal(patchHmrServerClass(HmrServer), true);

  const realMessages = [];
  const realUpdate = update({ modified: [[7, 'updated code']] });
  const realServer = new HmrServer(realUpdate);
  await realServer._handleFileChange(
    clientGroup(realMessages),
    { isInitialUpdate: false },
    { changeId: 'source-edit' }
  );
  assert.deepEqual(realMessages, [
    { type: 'update-start', body: { isInitialUpdate: false } },
    realUpdate,
    { type: 'update-done', body: { changeId: 'source-edit' } },
  ]);

  const errorMessages = [];
  const error = { type: 'error', body: { message: 'Transform failed' } };
  const errorServer = new HmrServer(error);
  await errorServer._handleFileChange(
    clientGroup(errorMessages),
    { isInitialUpdate: false },
    { changeId: 'bad-edit' }
  );
  assert.deepEqual(errorMessages, [
    { type: 'update-start', body: { isInitialUpdate: false } },
    error,
    { type: 'update-done', body: { changeId: 'bad-edit' } },
  ]);

  await realServer._handleFileChange(
    clientGroup([]),
    { isInitialUpdate: true },
    undefined
  );
  assert.equal(realServer.initialCalls, 1);
});

test('loads Metro HMR through its package path and fails open when unavailable', () => {
  const HmrServer = fakeHmrServerClass();
  const loaded = [];
  assert.equal(suppressEmptyMetroHmrUpdates({
    resolvePackage(specifier) {
      assert.equal(specifier, 'metro/package.json');
      return '/project/node_modules/metro/package.json';
    },
    loadModule(filePath) {
      loaded.push(filePath);
      return { default: HmrServer };
    },
  }), true);
  assert.deepEqual(loaded, ['/project/node_modules/metro/src/HmrServer.js']);

  const warnings = [];
  assert.equal(suppressEmptyMetroHmrUpdates({
    resolvePackage() {
      throw new Error('Metro missing');
    },
    warn(message) {
      warnings.push(message);
    },
  }), false);
  assert.match(warnings.join('\n'), /Metro missing/);
});
