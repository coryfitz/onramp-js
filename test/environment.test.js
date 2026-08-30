const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  normalizeEnvironment,
  resolveEnvironmentProfile,
  writeRuntimeConfig,
} = require('../src/environment');
const {prepareNativeConfig} = require('../src/native-config');


function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-environment-'));
  fs.mkdirSync(path.join(root, 'src', 'generated'), {recursive: true});
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({name: 'profile-app'})
  );
  fs.writeFileSync(
    path.join(root, 'app.json'),
    JSON.stringify({
      name: 'ProfileApp',
      displayName: 'Profile App',
      version: '1.2.3',
      android: {package: 'com.example.profile', versionCode: 7},
      ios: {bundleIdentifier: 'com.example.profile', buildNumber: '8'},
      environments: {
        development: {
          identifierSuffix: '.dev',
          displayNameSuffix: ' Dev',
          apiBaseUrl: {
            web: 'http://127.0.0.1:8000',
            ios: 'http://127.0.0.1:8000',
            android: 'http://10.0.2.2:8000',
          },
        },
        staging: {
          identifierSuffix: '.beta',
          displayNameSuffix: ' Beta',
          apiBaseUrl: 'https://staging.example.com/',
        },
        production: {apiBaseUrl: 'https://api.example.com'},
      },
    })
  );
  return root;
}


test('resolves platform URLs and writes one universal runtime profile', () => {
  const root = project();
  const android = resolveEnvironmentProfile(root, 'development', 'android');
  const ios = resolveEnvironmentProfile(root, 'development', 'ios');
  assert.equal(android.apiBaseUrl, 'http://10.0.2.2:8000');
  assert.equal(ios.apiBaseUrl, 'http://127.0.0.1:8000');

  writeRuntimeConfig(root, 'development', 'mobile');
  const runtime = JSON.parse(
    fs.readFileSync(path.join(root, 'src', 'generated', 'runtime-config.json'))
  );
  assert.equal(runtime.appEnvironment, 'development');
  assert.equal(runtime.apiBaseUrl.android, 'http://10.0.2.2:8000');
  assert.equal(runtime.apiBaseUrl.ios, 'http://127.0.0.1:8000');
});


test('applies environment identity suffixes only to the prepared native build', () => {
  const root = project();
  const staging = prepareNativeConfig(root, null, 'staging');
  const production = prepareNativeConfig(root, null, 'production');

  assert.equal(staging.android.package, 'com.example.profile.beta');
  assert.equal(staging.ios.bundleIdentifier, 'com.example.profile.beta');
  assert.equal(staging.displayName, 'Profile App Beta');
  assert.equal(production.android.package, 'com.example.profile');
  assert.equal(production.displayName, 'Profile App');
});


test('rejects unknown environment names', () => {
  assert.throws(() => normalizeEnvironment('preview'), /Environment must be/);
});


test('starter verification commands regenerate the selected runtime profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-runtime-script-'));
  fs.cpSync(path.join(__dirname, '..', 'templates'), root, {recursive: true});
  fs.mkdirSync(path.join(root, 'node_modules'), {recursive: true});
  fs.symlinkSync(
    path.join(__dirname, '..'),
    path.join(root, 'node_modules', 'onramp-js'),
    'dir'
  );
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));

  const result = spawnSync(process.execPath, ['scripts/build-routes.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, ONRAMP_ENVIRONMENT: 'staging'},
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const runtime = JSON.parse(
    fs.readFileSync(path.join(root, 'src', 'generated', 'runtime-config.json'))
  );
  assert.equal(runtime.appEnvironment, 'staging');

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'))
  );
  assert.match(packageJson.scripts.typecheck, /build-routes/);
  assert.match(packageJson.scripts.test, /build-routes/);
  assert.match(
    fs.readFileSync(path.join(root, 'project_gitignore'), 'utf8'),
    /src\/generated\/runtime-config\.json/
  );
});
