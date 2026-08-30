const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
