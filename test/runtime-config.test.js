const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {loadRuntime} = require('./helpers/runtime-ts');

test('runtime configuration resolves web without importing React Native Platform', () => {
  const runtimeDir = path.join(__dirname, '..', 'src', 'runtime');
  const runtimeConfig = fs.readFileSync(
    path.join(runtimeDir, 'RuntimeConfig.tsx'),
    'utf8'
  );
  const webPlatform = fs.readFileSync(
    path.join(runtimeDir, 'runtime-platform.web.ts'),
    'utf8'
  );

  assert.match(runtimeConfig, /from '\.\/runtime-platform'/);
  assert.doesNotMatch(runtimeConfig, /from 'react-native'/);
  assert.match(webPlatform, /runtimePlatform: RuntimePlatform = 'web'/);
});

test('registered runtime configuration supplies generated ports to legacy app roots', () => {
  const {
    effectiveRuntimeConfig,
    registerRuntimeConfig,
  } = loadRuntime(
    'runtime-config-state.ts',
    ['effectiveRuntimeConfig', 'registerRuntimeConfig'],
  );
  const generated = {
    appEnvironment: 'development',
    apiBaseUrl: {
      ios: 'http://127.0.0.1:8123',
      android: 'http://10.0.2.2:8123',
    },
  };

  registerRuntimeConfig(generated);

  assert.deepEqual(
    JSON.parse(JSON.stringify(effectiveRuntimeConfig({rootTag: 1}))),
    generated,
  );
  assert.equal(
    effectiveRuntimeConfig({apiBaseUrl: 'https://api.example.com'}).apiBaseUrl,
    'https://api.example.com',
  );
});

test('native and web entrypoints register generated runtime configuration', () => {
  const templateRoot = path.join(__dirname, '..', 'templates');
  for (const entrypoint of ['index.js', 'index.web.js']) {
    const source = fs.readFileSync(path.join(templateRoot, entrypoint), 'utf8');
    assert.match(source, /registerRuntimeConfig/);
    assert.match(source, /generated\/runtime-config\.json/);
    assert.match(source, /registerRuntimeConfig\(runtimeConfig\)/);
  }
});
