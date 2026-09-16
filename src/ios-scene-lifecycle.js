const fs = require('fs');
const path = require('path');

const SCENE_MANIFEST = `\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<false/>
\t\t<key>UISceneConfigurations</key>
\t\t<dict>
\t\t\t<key>UIWindowSceneSessionRoleApplication</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>UISceneConfigurationName</key>
\t\t\t\t\t<string>Default Configuration</string>
\t\t\t\t\t<key>UISceneDelegateClassName</key>
\t\t\t\t\t<string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</dict>
`;

const CONFIGURATION_METHOD = `
  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
`;

const SCENE_DELEGATE = `

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let startReactNative = appDelegate.startReactNative else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    startReactNative(window)
    self.window = window
  }
}
`;

function matchingDelimiter(content, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  let state = 'code';
  let blockCommentDepth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        state = 'code';
      }
      continue;
    }

    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = 'string';
      continue;
    }
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function swiftCodeDepthAt(content, targetIndex) {
  let braceDepth = 0;
  let state = 'code';
  let blockCommentDepth = 0;
  for (let index = 0; index <= targetIndex && index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];

    if (index === targetIndex) {
      return state === 'code' ? braceDepth : null;
    }
    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockCommentDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        state = 'code';
      }
      continue;
    }

    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = 'string';
      continue;
    }
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth -= 1;
  }
  return null;
}

function skipSwiftTrivia(content, startIndex = 0) {
  let index = startIndex;
  while (index < content.length) {
    if (/\s/.test(content[index])) {
      index += 1;
      continue;
    }
    if (content.startsWith('//', index)) {
      const newline = content.indexOf('\n', index + 2);
      return newline === -1 ? content.length : skipSwiftTrivia(content, newline + 1);
    }
    if (content.startsWith('/*', index)) {
      let depth = 1;
      index += 2;
      while (index < content.length && depth > 0) {
        if (content.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (content.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) return startIndex;
      continue;
    }
    break;
  }
  return index;
}

function containsOnlySwiftTrivia(content, startIndex = 0) {
  return skipSwiftTrivia(content, startIndex) === content.length;
}

function hasSwiftCodePattern(source, pattern) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))]
    .some(match => swiftCodeDepthAt(source, match.index) !== null);
}

function hasAppDelegateExtension(source) {
  return hasSwiftCodePattern(source, /\bextension\s+AppDelegate\b/);
}

const IGNORED_SWIFT_SCAN_DIRECTORIES = new Set([
  '.git',
  'build',
  'DerivedData',
  'node_modules',
  'Pods',
]);

function swiftFilesWithin(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !IGNORED_SWIFT_SCAN_DIRECTORIES.has(entry.name)) {
      files.push(...swiftFilesWithin(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.swift')) {
      files.push(entryPath);
    }
  }
  return files;
}

function validateBootstrap(bootstrap, filePath) {
  const factoryMatches = [...bootstrap.matchAll(/\bfactory\.startReactNative\b/g)]
    .filter(match => swiftCodeDepthAt(bootstrap, match.index) !== null);
  if (factoryMatches.length !== 1 || swiftCodeDepthAt(bootstrap, factoryMatches[0].index) !== 0) {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'the React Native factory bootstrap has been customized.'
    );
  }

  const factoryStart = factoryMatches[0].index;
  const callOpen = skipSwiftTrivia(
    bootstrap,
    factoryStart + factoryMatches[0][0].length
  );
  if (bootstrap[callOpen] !== '(') {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'the React Native factory call was not recognized.'
    );
  }
  const callClose = matchingDelimiter(bootstrap, callOpen, '(', ')');
  if (callClose === -1 || !containsOnlySwiftTrivia(bootstrap, callClose + 1)) {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'custom code follows the React Native factory call.'
    );
  }

  const prefixStart = skipSwiftTrivia(bootstrap);
  if (prefixStart === factoryStart) return;

  const declaration = /let\s+initialProperties\s*(?::\s*\[\s*String\s*:\s*Any\s*\])?\s*=\s*/y;
  declaration.lastIndex = prefixStart;
  const declarationMatch = declaration.exec(bootstrap);
  if (!declarationMatch || bootstrap[declaration.lastIndex] !== '[') {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'custom code precedes the React Native factory call.'
    );
  }
  const propertiesClose = matchingDelimiter(bootstrap, declaration.lastIndex, '[', ']');
  if (
    propertiesClose === -1
    || !containsOnlySwiftTrivia(bootstrap.slice(0, factoryStart), propertiesClose + 1)
    || !/\binitialProperties\s*:\s*initialProperties\b/.test(
      bootstrap.slice(callOpen + 1, callClose)
    )
  ) {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'the React Native initial properties bootstrap was not recognized.'
    );
  }
}

function appDelegateRange(source) {
  const matches = [...source.matchAll(
    /(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|open\s+|final\s+)*class\s+AppDelegate\s*:\s*UIResponder\s*,\s*UIApplicationDelegate\s*\{/g
  )].filter(match => swiftCodeDepthAt(source, match.index) === 0);
  if (matches.length !== 1) return null;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf('{');
  const close = matchingDelimiter(source, open, '{', '}');
  return close === -1 ? null : { open, close };
}

function didFinishRange(source, appDelegate) {
  const marker = source.indexOf('didFinishLaunchingWithOptions', appDelegate.open);
  if (marker === -1 || marker > appDelegate.close) return null;
  const start = source.lastIndexOf('func application', marker);
  const open = source.indexOf('{', marker);
  if (start === -1 || start < appDelegate.open || open === -1 || open > appDelegate.close) {
    return null;
  }
  const close = matchingDelimiter(source, open, '{', '}');
  return close === -1 || close > appDelegate.close ? null : { start, open, close };
}

function indentBlock(content) {
  return content.split('\n').map(line => (line ? `  ${line}` : line)).join('\n');
}

function migrateAppDelegate(source, filePath) {
  const appDelegate = appDelegateRange(source);
  const didFinish = appDelegate && didFinishRange(source, appDelegate);
  if (!appDelegate || !didFinish) {
    throw new Error(
      `Could not add required iOS scene lifecycle support to ${filePath}; `
      + 'the AppDelegate format was not recognized.'
    );
  }

  const appDelegateBody = source.slice(appDelegate.open + 1, appDelegate.close);
  const topLevelFunctions = [...appDelegateBody.matchAll(/\bfunc\b/g)]
    .filter(match => swiftCodeDepthAt(appDelegateBody, match.index) === 0);
  const didFinishOffset = didFinish.start - appDelegate.open - 1;
  if (topLevelFunctions.length !== 1 || topLevelFunctions[0].index !== didFinishOffset) {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'its AppDelegate contains custom lifecycle methods.'
    );
  }

  const methodBody = source.slice(didFinish.open + 1, didFinish.close);
  const windowPattern = /^([ \t]*)(?:self\.)?window\s*=\s*UIWindow\(\s*frame:\s*UIScreen\.main\.bounds\s*\)[ \t]*$/gm;
  const windowMatches = [...methodBody.matchAll(windowPattern)];
  const returnMatches = [...methodBody.matchAll(/^[ \t]*return[ \t]+true[ \t]*$/gm)];
  if (
    windowMatches.length !== 1
    || swiftCodeDepthAt(methodBody, windowMatches[0].index) !== 0
    || returnMatches.length !== 1
    || swiftCodeDepthAt(methodBody, returnMatches[0].index) !== 0
  ) {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'its React Native window bootstrap has been customized.'
    );
  }

  const windowMatch = windowMatches[0];
  const returnMatch = returnMatches[0];
  const windowStart = windowMatch.index;
  const windowEnd = windowStart + windowMatch[0].length;
  const returnStart = returnMatch.index;
  const returnEnd = returnStart + returnMatch[0].length;
  if (!containsOnlySwiftTrivia(methodBody, returnEnd)) {
    throw new Error(
      `Could not safely migrate ${filePath} to the required iOS scene lifecycle; `
      + 'custom code follows the AppDelegate launch result.'
    );
  }
  const bootstrap = methodBody
    .slice(windowEnd, returnStart)
    .replace(/^(?:[ \t]*\r?\n)+/, '')
    .replace(/(?:\r?\n[ \t]*)+$/, '');
  validateBootstrap(bootstrap, filePath);

  const indent = windowMatch[1];
  const wrappedBootstrap = `${indent}self.startReactNative = { [weak self] window in\n`
    + `${indentBlock(bootstrap)}\n`
    + `${indent}  self?.window = window\n`
    + `${indent}}\n\n`;
  let migrated = source.slice(0, didFinish.open + 1)
    + methodBody.slice(0, windowStart)
    + wrappedBootstrap
    + methodBody.slice(returnStart)
    + source.slice(didFinish.close);

  const migratedAppDelegate = appDelegateRange(migrated);
  const appDelegateSource = migrated.slice(
    migratedAppDelegate.open + 1,
    migratedAppDelegate.close
  );
  const windowProperty = /^([ \t]*)(?:public\s+)?var\s+window:\s*UIWindow\?[ \t]*$/m.exec(
    appDelegateSource
  );
  if (!windowProperty) {
    throw new Error(
      `Could not add required iOS scene lifecycle support to ${filePath}; `
      + 'the AppDelegate window property was not found.'
    );
  }
  const propertyEnd = migratedAppDelegate.open + 1
    + windowProperty.index + windowProperty[0].length;
  migrated = migrated.slice(0, propertyEnd)
    + `\n${windowProperty[1]}var startReactNative: ((UIWindow) -> Void)?`
    + migrated.slice(propertyEnd);

  const finalAppDelegate = appDelegateRange(migrated);
  migrated = migrated.slice(0, finalAppDelegate.close)
    + CONFIGURATION_METHOD
    + migrated.slice(finalAppDelegate.close);

  const withConfiguration = appDelegateRange(migrated);
  migrated = migrated.slice(0, withConfiguration.close + 1)
    + SCENE_DELEGATE.trimEnd()
    + migrated.slice(withConfiguration.close + 1);
  return migrated;
}

function addSceneManifest(infoPlist, filePath) {
  if (/<key>UIApplicationSceneManifest<\/key>/.test(infoPlist)) {
    return infoPlist;
  }
  const launchStoryboard = /^[ \t]*<key>UILaunchStoryboardName<\/key>/m.exec(infoPlist);
  if (launchStoryboard) {
    return infoPlist.slice(0, launchStoryboard.index)
      + SCENE_MANIFEST
      + infoPlist.slice(launchStoryboard.index);
  }
  const rootDictionaryEnd = infoPlist.lastIndexOf('</dict>');
  if (rootDictionaryEnd === -1) {
    throw new Error(
      `Could not add required iOS scene lifecycle support to ${filePath}; `
      + 'the Info.plist format was not recognized.'
    );
  }
  return infoPlist.slice(0, rootDictionaryEnd)
    + SCENE_MANIFEST
    + infoPlist.slice(rootDictionaryEnd);
}

function ensureIosSceneLifecycle(infoPlistPath, iosRoot = path.dirname(infoPlistPath)) {
  const infoPlist = fs.readFileSync(infoPlistPath, 'utf8');
  if (/<key>UIApplicationSceneManifest<\/key>/.test(infoPlist)) {
    return false;
  }

  const appDelegatePath = path.join(path.dirname(infoPlistPath), 'AppDelegate.swift');
  if (!fs.existsSync(appDelegatePath)) {
    throw new Error(
      `Could not add required iOS scene lifecycle support because ${appDelegatePath} does not exist.`
    );
  }
  const appDelegate = fs.readFileSync(appDelegatePath, 'utf8');
  const alreadyUsesDefaultScene = (
    hasSwiftCodePattern(appDelegate, /\bconfigurationForConnecting\b/)
    && hasSwiftCodePattern(
      appDelegate,
      /\bclass\s+SceneDelegate\s*:[^{]*\bUIWindowSceneDelegate\b/
    )
  );
  if (!alreadyUsesDefaultScene) {
    for (const swiftFile of swiftFilesWithin(iosRoot)) {
      if (hasAppDelegateExtension(fs.readFileSync(swiftFile, 'utf8'))) {
        throw new Error(
          `Could not safely migrate ${appDelegatePath} to the required iOS scene lifecycle; `
          + `custom AppDelegate behavior was found in ${swiftFile}.`
        );
      }
    }
  }
  const migratedAppDelegate = alreadyUsesDefaultScene
    ? appDelegate
    : migrateAppDelegate(appDelegate, appDelegatePath);
  const migratedInfoPlist = addSceneManifest(infoPlist, infoPlistPath);

  fs.writeFileSync(appDelegatePath, migratedAppDelegate, 'utf8');
  fs.writeFileSync(infoPlistPath, migratedInfoPlist, 'utf8');
  return true;
}

module.exports = {
  addSceneManifest,
  ensureIosSceneLifecycle,
  migrateAppDelegate,
};
