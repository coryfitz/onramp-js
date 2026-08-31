const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../package.json');
const templatePackageJson = require('../templates/package.json');

test('generated projects use the audited Node and web development toolchain', () => {
  assert.equal(packageJson.engines.node, '>=22.15.0 <23');
  assert.equal(templatePackageJson.engines.node, '>=22.15.0 <23');
  assert.equal(templatePackageJson.devDependencies.webpack, '^5.101.0');
  assert.equal(templatePackageJson.devDependencies['webpack-dev-server'], '^6.0.0');
  assert.equal(templatePackageJson.dependencies['@react-navigation/native'], undefined);
  assert.equal(templatePackageJson.dependencies['@react-navigation/bottom-tabs'], undefined);
  assert.equal(templatePackageJson.dependencies['@react-navigation/native-stack'], undefined);
  assert.equal(
    fs.readFileSync(path.join(__dirname, '..', 'templates', '.nvmrc'), 'utf8'),
    '22\n'
  );
});

test('generated projects use one compatible React Native test and Metro stack', () => {
  const reactNativeVersion = templatePackageJson.dependencies['react-native'];
  assert.equal(reactNativeVersion, '0.86.3');
  assert.equal(templatePackageJson.dependencies.react, '19.2.3');
  assert.equal(templatePackageJson.dependencies['react-dom'], '19.2.3');
  assert.equal(
    templatePackageJson.devDependencies['@react-native/babel-preset'],
    reactNativeVersion
  );
  assert.equal(
    templatePackageJson.devDependencies['@react-native/jest-preset'],
    reactNativeVersion
  );
  assert.equal(
    templatePackageJson.devDependencies['@react-native/metro-config'],
    reactNativeVersion
  );
  assert.equal(templatePackageJson.jest.preset, '@react-native/jest-preset');
});
