const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  defaultNativePackage,
  humanDisplayName,
  nativeProjectName,
  prepareNativeConfig,
  syncNativeProjects,
} = require('../src/native-config');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createNativeProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-native-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'swerve-predict', version: '0.0.1' }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(root, 'app.json'),
    `${JSON.stringify({
      name: 'SwervePredict',
      displayName: 'Swerve & Predict',
      version: '1.2.3',
      icon: './assets/logo.png',
      android: { package: 'com.swerve.predict', versionCode: 7 },
      ios: { bundleIdentifier: 'com.swerve.predict.ios', buildNumber: '9' },
    }, null, 2)}\n`
  );
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'templates', 'assets', 'logo.png'),
    path.join(root, 'assets', 'logo.png')
  );

  write(
    path.join(root, 'android', 'app', 'build.gradle'),
    `android {\n    namespace "com.swervepredict"\n    defaultConfig {\n        applicationId "com.swervepredict"\n        versionCode 1\n        versionName "1.0"\n    }\n}\n`
  );
  write(
    path.join(root, 'android', 'settings.gradle'),
    "rootProject.name = 'com.swerve.predict'\n"
  );
  write(
    path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'swervepredict', 'MainActivity.kt'),
    'package com.swervepredict\n\nclass MainActivity\n'
  );
  write(
    path.join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
    '<resources>\n    <string name="app_name">SwervePredict</string>\n</resources>\n'
  );
  write(
    path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    '<manifest><application android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round" /></manifest>\n'
  );

  write(
    path.join(root, 'ios', 'SwervePredict.xcodeproj', 'project.pbxproj'),
    `PRODUCT_BUNDLE_IDENTIFIER = "org.reactjs.native.example.SwervePredict";\nCURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 1.0;\nPRODUCT_BUNDLE_IDENTIFIER = "org.reactjs.native.example.SwervePredict";\nCURRENT_PROJECT_VERSION = 1;\nMARKETING_VERSION = 1.0;\n`
  );
  write(
    path.join(root, 'ios', 'SwervePredict', 'Info.plist'),
    '<plist><dict>\n<key>CFBundleDisplayName</key>\n<string>SwervePredict</string>\n</dict></plist>\n'
  );
  write(
    path.join(root, 'ios', 'SwervePredict', 'LaunchScreen.storyboard'),
    '<label text="SwervePredict" id="GJd-Yh-RWb"></label>\n'
  );
  return root;
}

test('derives stable identifiers and readable default display names', () => {
  assert.equal(nativeProjectName('swerve-predict'), 'SwervePredict');
  assert.equal(humanDisplayName('swerve-predict'), 'Swerve Predict');
  assert.equal(humanDisplayName('SwervePredict'), 'Swerve Predict');
  assert.equal(defaultNativePackage('SwervePredict'), 'com.swervepredict');
});

test('synchronizes declarative identity, versions, and icons idempotently', t => {
  const root = createNativeProject(t);
  const config = prepareNativeConfig(root, 'swerve-predict');

  assert.deepEqual(syncNativeProjects(root, config), ['android', 'ios']);
  assert.deepEqual(syncNativeProjects(root, config), []);

  const androidGradle = fs.readFileSync(
    path.join(root, 'android', 'app', 'build.gradle'),
    'utf8'
  );
  assert.match(androidGradle, /namespace "com\.swerve\.predict"/);
  assert.match(androidGradle, /applicationId "com\.swerve\.predict"/);
  assert.match(androidGradle, /versionCode 7/);
  assert.match(androidGradle, /versionName "1\.2\.3"/);
  assert.equal([...androidGradle.matchAll(/apply from: rootProject\.file\("onramp-release-signing\.gradle"\)/g)].length, 1);
  assert.equal(
    fs.readFileSync(path.join(root, 'android', 'onramp-release-signing.gradle'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'src', 'android-release-signing.gradle'), 'utf8')
  );
  assert.match(
    fs.readFileSync(path.join(root, 'android', 'settings.gradle'), 'utf8'),
    /rootProject\.name = 'SwervePredict'/
  );
  assert.match(
    fs.readFileSync(
      path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'swervepredict', 'MainActivity.kt'),
      'utf8'
    ),
    /package com\.swerve\.predict/
  );
  assert.match(
    fs.readFileSync(
      path.join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
      'utf8'
    ),
    /Swerve &amp; Predict/
  );
  assert.match(
    fs.readFileSync(
      path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8'
    ),
    /android:icon="@drawable\/onramp_app_icon"/
  );
  assert.ok(fs.existsSync(path.join(
    root,
    'android',
    'app',
    'src',
    'main',
    'res',
    'drawable-nodpi',
    'onramp_app_icon.png'
  )));

  const iosProject = fs.readFileSync(
    path.join(root, 'ios', 'SwervePredict.xcodeproj', 'project.pbxproj'),
    'utf8'
  );
  assert.equal(
    [...iosProject.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "com\.swerve\.predict\.ios";/g)].length,
    2
  );
  assert.equal([...iosProject.matchAll(/CURRENT_PROJECT_VERSION = 9;/g)].length, 2);
  assert.equal([...iosProject.matchAll(/MARKETING_VERSION = 1\.2\.3;/g)].length, 2);
  assert.match(
    fs.readFileSync(path.join(root, 'ios', 'SwervePredict', 'Info.plist'), 'utf8'),
    /Swerve &amp; Predict/
  );
  assert.match(
    fs.readFileSync(
      path.join(root, 'ios', 'SwervePredict', 'LaunchScreen.storyboard'),
      'utf8'
    ),
    /Swerve &amp; Predict/
  );
  const iconContents = JSON.parse(fs.readFileSync(path.join(
    root,
    'ios',
    'SwervePredict',
    'Images.xcassets',
    'AppIcon.appiconset',
    'Contents.json'
  ), 'utf8'));
  assert.equal(iconContents.images[0].filename, 'onramp-icon-1024.png');
  assert.equal(iconContents.images[0].size, '1024x1024');
});

test('preserves configuration-owned iOS display names across development and production sync', t => {
  const root = createNativeProject(t);
  const plist = path.join(root, 'ios', 'SwervePredict', 'Info.plist');
  for (const expression of ['$(APP_DISPLAY_NAME)', '${APP_DISPLAY_NAME}', '$(PRODUCT_NAME) Beta']) {
    write(plist, `<plist><dict><key>CFBundleDisplayName</key><string>${expression}</string></dict></plist>\n`);
    const config = prepareNativeConfig(root, 'swerve-predict');
    syncNativeProjects(root, {...config, displayName: 'Swerve Predict Dev'}, ['ios']);
    assert.ok(fs.readFileSync(plist, 'utf8').includes(`<string>${expression}</string>`));
    syncNativeProjects(root, {...config, displayName: 'Swerve Predict'}, ['ios']);
    assert.ok(fs.readFileSync(plist, 'utf8').includes(`<string>${expression}</string>`));
  }
});

test('keeps the shared iOS launch screen free of the last development profile suffix', t => {
  const root = createNativeProject(t);
  const appJsonPath = path.join(root, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.environments = {development: {displayNameSuffix: ' Dev'}};
  write(appJsonPath, JSON.stringify(appJson));
  const config = prepareNativeConfig(root, 'swerve-predict', 'development');
  assert.equal(config.baseDisplayName, 'Swerve & Predict');
  assert.equal(config.displayName, 'Swerve & Predict Dev');
  syncNativeProjects(root, config, ['ios']);
  const launchScreen = fs.readFileSync(path.join(root, 'ios', 'SwervePredict', 'LaunchScreen.storyboard'), 'utf8');
  assert.match(launchScreen, /text="Swerve &amp; Predict"/);
  assert.doesNotMatch(launchScreen, / Dev/);
  assert.match(fs.readFileSync(path.join(root, 'ios', 'SwervePredict', 'Info.plist'), 'utf8'), /Swerve &amp; Predict Dev/);
  assert.deepEqual(syncNativeProjects(root, config, ['ios']), []);
});

test('adds the release signing guard without replacing custom Android build types or credentials', t => {
  const root = createNativeProject(t);
  const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
  const original = fs.readFileSync(gradlePath, 'utf8') + `
android {
    signingConfigs { customUpload { keyAlias providers.environmentVariable("MY_KEY_ALIAS").orNull } }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release { signingConfig signingConfigs.customUpload }
    }
}
`;
  write(gradlePath, original);
  const config = prepareNativeConfig(root, 'swerve-predict');
  syncNativeProjects(root, config, ['android']);
  const updated = fs.readFileSync(gradlePath, 'utf8');
  assert.ok(updated.includes('release { signingConfig signingConfigs.customUpload }'));
  assert.ok(updated.includes('debug { signingConfig signingConfigs.debug }'));
  assert.ok(updated.includes('keyAlias providers.environmentVariable("MY_KEY_ALIAS").orNull'));
  assert.deepEqual(syncNativeProjects(root, config, ['android']), []);
  const script = fs.readFileSync(path.join(root, 'android', 'onramp-release-signing.gradle'), 'utf8');
  assert.ok(script.includes('variant.preBuildProvider.configure { dependsOn(verifySigning) }'));
  assert.ok(script.includes('onrampMissingSigning.size() == 4'));
  assert.ok(script.includes('config.keyAlias?.equalsIgnoreCase("androiddebugkey")'));
  assert.ok(script.includes('ONRAMP_ANDROID_ALLOW_UNSIGNED_RELEASE'));
  assert.doesNotMatch(script, /storePassword\s*[= ]\s*["']android["']/);
});

test('rejects unsafe or invalid declarative native settings', t => {
  const root = createNativeProject(t);
  const appJsonPath = path.join(root, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  appJson.android.package = 'not a package';
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);

  assert.throws(
    () => prepareNativeConfig(root, 'swerve-predict'),
    /reverse-domain identifier/
  );

  appJson.android.package = 'com.swerve.predict';
  appJson.icon = '../outside.png';
  fs.writeFileSync(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
  assert.throws(
    () => prepareNativeConfig(root, 'swerve-predict'),
    /must stay inside/
  );
});
