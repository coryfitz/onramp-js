const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureIosPodsDeploymentTarget,
  reactNativeMinimumIosVersion,
} = require('../src/ios-pods-deployment-target');

function fixture(t, {helpers, project}) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-pods-target-'));
  t.after(() => fs.rmSync(outputDir, {recursive: true, force: true}));
  const iosDir = path.join(outputDir, 'ios');
  const helpersPath = path.join(
    outputDir,
    'node_modules',
    'react-native',
    'scripts',
    'cocoapods',
    'helpers.rb',
  );
  const projectPath = path.join(
    iosDir,
    'Pods',
    'Pods.xcodeproj',
    'project.pbxproj',
  );
  fs.mkdirSync(path.dirname(helpersPath), {recursive: true});
  fs.mkdirSync(path.dirname(projectPath), {recursive: true});
  fs.writeFileSync(helpersPath, helpers);
  fs.writeFileSync(projectPath, project);
  return {iosDir, outputDir, projectPath};
}

const HELPERS = `
module Helpers
  class Constants
    def self.min_ios_version_supported
      return '15.1'
    end

    def self.min_xcode_version_supported
      return '16.1'
    end
  end
end
`;

test('raises only explicit generated Pod targets below React Native minimum', t => {
  const project = `
    IPHONEOS_DEPLOYMENT_TARGET = 13.0;
    IPHONEOS_DEPLOYMENT_TARGET = 15.0;
    IPHONEOS_DEPLOYMENT_TARGET = 15.1;
    IPHONEOS_DEPLOYMENT_TARGET = 16.0;
    IPHONEOS_DEPLOYMENT_TARGET = "14.4";
    IPHONEOS_DEPLOYMENT_TARGET = $(inherited);
    // IPHONEOS_DEPLOYMENT_TARGET = 12.0;
    OTHER_SETTING = 13.0;
  `;
  const fixtureProject = fixture(t, {helpers: HELPERS, project});

  assert.deepEqual(
    ensureIosPodsDeploymentTarget(fixtureProject.iosDir, fixtureProject.outputDir),
    {minimum: '15.1', raised: 3},
  );
  const updated = fs.readFileSync(fixtureProject.projectPath, 'utf8');
  assert.equal(
    [...updated.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = 15\.1;/g)].length,
    3,
  );
  assert.match(updated, /IPHONEOS_DEPLOYMENT_TARGET = 16\.0;/);
  assert.match(updated, /IPHONEOS_DEPLOYMENT_TARGET = "15\.1";/);
  assert.match(updated, /IPHONEOS_DEPLOYMENT_TARGET = \$\(inherited\);/);
  assert.match(updated, /\/\/ IPHONEOS_DEPLOYMENT_TARGET = 12\.0;/);
  assert.match(updated, /OTHER_SETTING = 13\.0;/);

  const modified = fs.statSync(fixtureProject.projectPath).mtimeMs;
  assert.deepEqual(
    ensureIosPodsDeploymentTarget(fixtureProject.iosDir, fixtureProject.outputDir),
    {minimum: '15.1', raised: 0},
  );
  assert.equal(fs.statSync(fixtureProject.projectPath).mtimeMs, modified);
});

test('repairs every regular CocoaPods project in multi-project mode', t => {
  const fixtureProject = fixture(t, {
    helpers: HELPERS,
    project: 'IPHONEOS_DEPLOYMENT_TARGET = 15.1;\n',
  });
  const secondary = path.join(
    fixtureProject.iosDir,
    'Pods',
    'AsyncStorage.xcodeproj',
    'project.pbxproj',
  );
  fs.mkdirSync(path.dirname(secondary));
  fs.writeFileSync(secondary, [
    'IPHONEOS_DEPLOYMENT_TARGET = 13.0;',
    'IPHONEOS_DEPLOYMENT_TARGET = 13.0;',
    'IPHONEOS_DEPLOYMENT_TARGET = 13.0;',
    '',
  ].join('\n'));

  assert.deepEqual(
    ensureIosPodsDeploymentTarget(fixtureProject.iosDir, fixtureProject.outputDir),
    {minimum: '15.1', raised: 3},
  );
  assert.equal(
    [...fs.readFileSync(secondary, 'utf8').matchAll(/DEPLOYMENT_TARGET = 15\.1/g)].length,
    3,
  );
});

test('reads the minimum from the React Native helper method only', t => {
  const fixtureProject = fixture(t, {
    helpers: `
      OTHER_VERSION = '99.0'
      def self.min_ios_version_supported
        return "17.2"
      end
    `,
    project: 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;\n',
  });
  assert.equal(reactNativeMinimumIosVersion(fixtureProject.outputDir), '17.2');
  assert.deepEqual(
    ensureIosPodsDeploymentTarget(fixtureProject.iosDir, fixtureProject.outputDir),
    {minimum: '17.2', raised: 1},
  );
});

test('fails clearly instead of guessing when generated inputs are unavailable', t => {
  const missingProject = fixture(t, {helpers: HELPERS, project: ''});
  fs.rmSync(missingProject.projectPath);
  assert.throws(
    () => ensureIosPodsDeploymentTarget(missingProject.iosDir, missingProject.outputDir),
    /could not read the generated CocoaPods project/i,
  );

  const missingVersion = fixture(t, {
    helpers: 'def self.some_other_method\n  return \'15.1\'\nend\n',
    project: 'IPHONEOS_DEPLOYMENT_TARGET = 13.0;\n',
  });
  assert.throws(
    () => ensureIosPodsDeploymentTarget(missingVersion.iosDir, missingVersion.outputDir),
    /could not determine React Native's minimum iOS version/i,
  );
});
