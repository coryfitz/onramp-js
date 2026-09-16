const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ensureIosSceneLifecycle,
  migrateAppDelegate,
} = require('../src/ios-scene-lifecycle');

const LEGACY_APP_DELEGATE = `import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "ExampleApp",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func bundleURL() -> URL? {
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
  }
}
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Example App</string>
\t<key>UILaunchStoryboardName</key>
\t<string>LaunchScreen</string>
</dict>
</plist>
`;

function project(t, appDelegate = LEGACY_APP_DELEGATE, infoPlist = INFO_PLIST) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-ios-scenes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appRoot = path.join(root, 'ios', 'ExampleApp');
  fs.mkdirSync(appRoot, { recursive: true });
  const appDelegatePath = path.join(appRoot, 'AppDelegate.swift');
  const infoPlistPath = path.join(appRoot, 'Info.plist');
  fs.writeFileSync(appDelegatePath, appDelegate, 'utf8');
  fs.writeFileSync(infoPlistPath, infoPlist, 'utf8');
  return { appDelegatePath, infoPlistPath };
}

test('migrates the React Native bootstrap to a single UIKit scene idempotently', t => {
  const files = project(t);

  assert.equal(ensureIosSceneLifecycle(files.infoPlistPath), true);
  assert.equal(ensureIosSceneLifecycle(files.infoPlistPath), false);

  const appDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
  assert.match(appDelegate, /var startReactNative: \(\(UIWindow\) -> Void\)\?/);
  assert.match(appDelegate, /self\.startReactNative = \{ \[weak self\] window in/);
  assert.match(appDelegate, /configuration\.delegateClass = SceneDelegate\.self/);
  assert.match(appDelegate, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/);
  assert.match(appDelegate, /let window = UIWindow\(windowScene: windowScene\)/);
  assert.match(appDelegate, /startReactNative\(window\)/);
  assert.match(appDelegate, /self\?\.window = window/);
  assert.doesNotMatch(appDelegate, /UIWindow\(frame: UIScreen\.main\.bounds\)/);
  assert.equal([...appDelegate.matchAll(/factory\.startReactNative\(/g)].length, 1);

  const infoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');
  assert.match(infoPlist, /<key>UIApplicationSceneManifest<\/key>/);
  assert.match(infoPlist, /<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
  assert.match(infoPlist, /\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate/);
});

test('preserves custom initial properties inside the scene-owned bootstrap', () => {
  const customized = LEGACY_APP_DELEGATE.replace(
    '    factory.startReactNative(',
    `    let initialProperties: [String: Any] = [
      "apiBaseUrl": Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String ?? "",
    ]

    factory.startReactNative(`
  ).replace(
    '      in: window,\n      launchOptions:',
    '      in: window,\n      initialProperties: initialProperties,\n      launchOptions:'
  );

  const migrated = migrateAppDelegate(customized, 'AppDelegate.swift');
  const closure = migrated.slice(
    migrated.indexOf('self.startReactNative ='),
    migrated.indexOf('return true')
  );
  assert.match(closure, /let initialProperties: \[String: Any\]/);
  assert.match(closure, /initialProperties: initialProperties/);
  assert.match(closure, /apiBaseUrl/);
});

test('leaves a project with an existing scene manifest untouched', t => {
  const existing = INFO_PLIST.replace(
    '<key>UILaunchStoryboardName</key>',
    '<key>UIApplicationSceneManifest</key><dict></dict>\n\t<key>UILaunchStoryboardName</key>'
  );
  const files = project(t, 'custom app delegate\n', existing);

  assert.equal(ensureIosSceneLifecycle(files.infoPlistPath), false);
  assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), 'custom app delegate\n');
  assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), existing);
});

test('refuses an unknown legacy bootstrap before changing either native file', t => {
  const files = project(
    t,
    LEGACY_APP_DELEGATE.replace(
      'window = UIWindow(frame: UIScreen.main.bounds)',
      'window = CustomWindowFactory.makeWindow()'
    )
  );
  const beforeAppDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
  const beforeInfoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');

  assert.throws(
    () => ensureIosSceneLifecycle(files.infoPlistPath),
    /could not safely migrate/i
  );
  assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), beforeAppDelegate);
  assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), beforeInfoPlist);
});

test('refuses to delay arbitrary app startup code into scene connection', t => {
  for (const customized of [
    LEGACY_APP_DELEGATE.replace(
      '    factory.startReactNative(',
      '    Analytics.start()\n\n    factory.startReactNative('
    ),
    LEGACY_APP_DELEGATE.replace(
      '\n\n    return true',
      '\n\n    Analytics.didStartReactNative()\n\n    return true'
    ),
  ]) {
    const files = project(t, customized);
    const beforeAppDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
    const beforeInfoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');

    assert.throws(
      () => ensureIosSceneLifecycle(files.infoPlistPath),
      /could not safely migrate/i
    );
    assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), beforeAppDelegate);
    assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), beforeInfoPlist);
  }
});

test('refuses custom AppDelegate callbacks that would change meaning with scenes', t => {
  const customized = LEGACY_APP_DELEGATE.replace(
    '\n}\n\nclass ReactNativeDelegate',
    `

  func applicationDidBecomeActive(_ application: UIApplication) {
    Analytics.applicationDidBecomeActive()
  }
}

class ReactNativeDelegate`
  );
  const files = project(t, customized);
  const beforeAppDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
  const beforeInfoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');

  assert.throws(
    () => ensureIosSceneLifecycle(files.infoPlistPath),
    /custom lifecycle methods/i
  );
  assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), beforeAppDelegate);
  assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), beforeInfoPlist);
});

test('refuses AppDelegate extensions in the main or sibling Swift source', t => {
  for (const separateFile of [false, true]) {
    const extensionSource = `
extension AppDelegate {
  func applicationDidBecomeActive(_ application: UIApplication) {
    Analytics.applicationDidBecomeActive()
  }
}
`;
    const files = project(
      t,
      separateFile ? LEGACY_APP_DELEGATE : LEGACY_APP_DELEGATE + extensionSource
    );
    const iosRoot = path.dirname(path.dirname(files.infoPlistPath));
    if (separateFile) {
      const sharedRoot = path.join(iosRoot, 'Shared');
      fs.mkdirSync(sharedRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sharedRoot, 'AppDelegate+Notifications.swift'),
        extensionSource,
        'utf8'
      );
    }
    const beforeAppDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
    const beforeInfoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');

    assert.throws(
      () => ensureIosSceneLifecycle(files.infoPlistPath, iosRoot),
      /custom AppDelegate behavior/i
    );
    assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), beforeAppDelegate);
    assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), beforeInfoPlist);
  }
});

test('refuses an AppDelegate with a custom superclass or inherited behavior', t => {
  const customized = LEGACY_APP_DELEGATE.replace(
    'class AppDelegate: UIResponder, UIApplicationDelegate',
    'class AppDelegate: CustomBaseDelegate, UIApplicationDelegate'
  );
  const files = project(t, customized);
  const beforeAppDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
  const beforeInfoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');

  assert.throws(
    () => ensureIosSceneLifecycle(files.infoPlistPath),
    /AppDelegate format was not recognized/i
  );
  assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), beforeAppDelegate);
  assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), beforeInfoPlist);
});

test('refuses a legacy window bootstrap nested in control flow', t => {
  const customized = LEGACY_APP_DELEGATE.replace(
    '    window = UIWindow(frame: UIScreen.main.bounds)',
    `    if shouldCreateWindow {
      window = UIWindow(frame: UIScreen.main.bounds)
    }`
  );
  const files = project(t, customized);
  const beforeAppDelegate = fs.readFileSync(files.appDelegatePath, 'utf8');
  const beforeInfoPlist = fs.readFileSync(files.infoPlistPath, 'utf8');

  assert.throws(
    () => ensureIosSceneLifecycle(files.infoPlistPath),
    /could not safely migrate/i
  );
  assert.equal(fs.readFileSync(files.appDelegatePath, 'utf8'), beforeAppDelegate);
  assert.equal(fs.readFileSync(files.infoPlistPath, 'utf8'), beforeInfoPlist);
});
