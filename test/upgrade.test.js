const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const packageJson = require('../package.json');

const {
  FRONTEND_MANIFEST,
  managedFileContents,
  sha256,
  writeFrontendManifest,
} = require('../src/project');
const {
  applyFrontendUpgrade,
  BROKEN_NATIVE_STYLE_FILE_HASHES,
  LEGACY_MANAGED_HASHES,
  MISALIGNED_NATIVE_BADGE_FILE_HASHES,
  planFrontendUpgrade,
  printFrontendCheckResult,
  updatedNativeStyleImports,
  updatedFrontendGitignore,
  upgradeFrontend,
} = require('../src/upgrade');

const LEGACY_BABEL_CONFIG = `module.exports = {
  // Metro (native) only
  presets: ['module:@react-native/babel-preset'],
  plugins: ['@stylexjs/babel-plugin'],
};
`;

function createProject(t) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-upgrade-test-'));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(outputDir, 'package.json'),
    `${JSON.stringify({ name: 'example', devDependencies: {} }, null, 2)}\n`
  );
  return outputDir;
}

test('fresh generated tooling is already current before its first upgrade', t => {
  const outputDir = createProject(t);
  const templateRoot = path.join(__dirname, '..', 'templates');
  const generatedPackage = JSON.parse(fs.readFileSync(
    path.join(templateRoot, 'package.json'), 'utf8'
  ));
  generatedPackage.name = 'example';
  generatedPackage.devDependencies['onramp-js'] = packageJson.version;
  fs.writeFileSync(path.join(outputDir, 'package.json'),
    `${JSON.stringify(generatedPackage, null, 2)}\n`);
  for (const [relativePath, content] of Object.entries(managedFileContents())) {
    const target = path.join(outputDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.copyFileSync(path.join(templateRoot, 'project_gitignore'), path.join(outputDir, '.gitignore'));
  writeFrontendManifest(outputDir);
  const before = snapshotProject(outputDir);

  const plan = planFrontendUpgrade(outputDir);

  assert.deepEqual(plan.changes, []);
  assert.deepEqual(plan.conflicts, []);
  assert.equal(plan.manifestChanged, false);
  assert.deepEqual(snapshotProject(outputDir), before);
});

test('plans a legacy frontend migration without overwriting known files', t => {
  const outputDir = createProject(t);
  fs.writeFileSync(path.join(outputDir, 'babel.config.js'), LEGACY_BABEL_CONFIG);

  const plan = planFrontendUpgrade(outputDir);

  assert.equal(plan.fromSchema, 0);
  assert.equal(plan.toSchema, 3);
  assert.equal(plan.migrations.length, 3);
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.changes.some(change => change.relativePath === 'babel.config.js'));
  assert.ok(plan.changes.some(change => change.relativePath === 'package.json'));
});

test('migrates framework-owned package and Node requirements', t => {
  const outputDir = createProject(t);
  const legacyPackage = {
    name: 'example',
    dependencies: {
      react: '19.1.0',
      'react-dom': '19.1.0',
      'react-native': '0.81.1',
    },
    devDependencies: {
      '@react-native-community/cli': '^20.0.2',
      '@react-native-community/cli-platform-android': '^20.0.2',
      '@react-native-community/cli-platform-ios': '^20.0.2',
      '@react-native/babel-preset': '0.81.1',
      '@react-native/metro-config': '0.81.1',
      '@types/react': '^19.1.0',
      '@types/react-dom': '^19.1.0',
      'react-test-renderer': '19.1.0',
      typescript: '^5.6.2',
      webpack: '^5.88.0',
      'webpack-dev-server': '^4.15.0',
    },
    engines: { node: '>=20.19.4 <21' },
    jest: { preset: 'react-native' },
  };
  fs.writeFileSync(
    path.join(outputDir, 'package.json'),
    `${JSON.stringify(legacyPackage, null, 2)}\n`
  );
  fs.writeFileSync(path.join(outputDir, '.nvmrc'), '20\n');

  const plan = planFrontendUpgrade(outputDir);

  assert.deepEqual(plan.conflicts, []);
  const packageChange = plan.changes.find(change => change.relativePath === 'package.json');
  const upgraded = JSON.parse(packageChange.content);
  assert.equal(upgraded.dependencies['react-native'], '0.86.3');
  assert.equal(upgraded.dependencies.react, '19.2.3');
  assert.equal(upgraded.devDependencies['@react-native/metro-config'], '0.86.3');
  assert.equal(upgraded.devDependencies['@react-native/jest-preset'], '0.86.3');
  assert.equal(upgraded.devDependencies.webpack, '^5.101.0');
  assert.equal(upgraded.devDependencies['webpack-dev-server'], '^6.0.0');
  assert.equal(upgraded.engines.node, '>=22.15.0 <23');
  assert.equal(upgraded.jest.preset, '@react-native/jest-preset');
  assert.equal(
    plan.changes.find(change => change.relativePath === '.nvmrc').content,
    '22\n'
  );
});

test('does not overwrite customized framework package requirements', t => {
  const outputDir = createProject(t);
  const projectPackage = JSON.parse(
    fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8')
  );
  projectPackage.dependencies = { 'react-native': '0.82.0-custom' };
  fs.writeFileSync(
    path.join(outputDir, 'package.json'),
    `${JSON.stringify(projectPackage, null, 2)}\n`
  );

  const plan = planFrontendUpgrade(outputDir);

  assert.ok(plan.conflicts.some(conflict => (
    conflict.includes('dependencies.react-native uses 0.82.0-custom')
  )));
});

test('repairs the generated import that discards native application styles', t => {
  const outputDir = createProject(t);
  const appDir = path.join(outputDir, 'app', 'profile');
  const routePath = path.join(appDir, '[id].tsx');
  fs.mkdirSync(appDir, { recursive: true });
  const source = "import * as css from '@stylexjs/stylex';\n"
    + "import { html } from 'react-strict-dom';\n"
    + "const styles = css.create({ root: { color: 'red' } });\n";
  fs.writeFileSync(routePath, source);

  const plan = planFrontendUpgrade(outputDir, {
    nativeStyleFileHashes: {
      'app/profile/[id].tsx': sha256(source),
    },
  });
  const routeChange = plan.changes.find(
    change => change.relativePath === 'app/profile/[id].tsx'
  );

  assert.ok(routeChange);
  assert.equal(
    routeChange.reason,
    'restore React Strict DOM native style resolution'
  );
  assert.match(
    routeChange.content,
    /import \{ css, html \} from 'react-strict-dom';/
  );
  assert.doesNotMatch(routeChange.content, /@stylexjs\/stylex/);
});

test('centers the generated profile initial when upgrading an untouched starter', t => {
  const outputDir = createProject(t);
  const routePath = path.join(outputDir, 'app', 'profile', '[id].tsx');
  const brokenSource = '// untouched starter with the native text badge\n';
  const fixedSource = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'app', 'profile', '[id].tsx'),
    'utf8'
  );
  fs.mkdirSync(path.dirname(routePath), { recursive: true });
  fs.writeFileSync(routePath, brokenSource);

  const plan = planFrontendUpgrade(outputDir, {
    nativeStyleFileHashes: {},
    nativeBadgeFileHashes: {
      'app/profile/[id].tsx': sha256(brokenSource),
    },
  });
  const routeChange = plan.changes.find(
    change => change.relativePath === 'app/profile/[id].tsx'
  );

  assert.ok(routeChange);
  assert.equal(
    routeChange.reason,
    'center the generated profile initial on native platforms'
  );
  assert.equal(routeChange.content, fixedSource);
});

test('repairs an older generated profile import and badge in one upgrade', t => {
  const outputDir = createProject(t);
  const routePath = path.join(outputDir, 'app', 'profile', '[id].tsx');
  const brokenSource = "import * as css from '@stylexjs/stylex';\n"
    + "import { html } from 'react-strict-dom';\n";
  const brokenHash = sha256(brokenSource);
  fs.mkdirSync(path.dirname(routePath), { recursive: true });
  fs.writeFileSync(routePath, brokenSource);

  const plan = planFrontendUpgrade(outputDir, {
    nativeStyleFileHashes: { 'app/profile/[id].tsx': brokenHash },
    nativeBadgeFileHashes: { 'app/profile/[id].tsx': [brokenHash] },
  });
  const routeChanges = plan.changes.filter(
    change => change.relativePath === 'app/profile/[id].tsx'
  );

  assert.equal(routeChanges.length, 1);
  assert.equal(
    routeChanges[0].reason,
    'center the generated profile initial on native platforms'
  );
  assert.equal(
    routeChanges[0].content,
    fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'app', 'profile', '[id].tsx'),
      'utf8'
    )
  );
});

test('does not replace a customized profile route while repairing native badge layout', t => {
  const outputDir = createProject(t);
  const routePath = path.join(outputDir, 'app', 'profile', '[id].tsx');
  fs.mkdirSync(path.dirname(routePath), { recursive: true });
  fs.writeFileSync(routePath, '// customized profile route\n');

  const plan = planFrontendUpgrade(outputDir);

  assert.equal(
    plan.changes.some(change => change.relativePath === 'app/profile/[id].tsx'),
    false
  );
});

test('leaves unrelated StyleX imports unchanged during upgrades', () => {
  const source = "import * as css from '@stylexjs/stylex';\n"
    + "const styles = css.create({ root: { color: 'red' } });\n";

  assert.equal(updatedNativeStyleImports(source), source);
});

test('does not rewrite customized application source with the affected imports', t => {
  const outputDir = createProject(t);
  const routePath = path.join(outputDir, 'app', 'index.tsx');
  const source = "import * as css from '@stylexjs/stylex';\n"
    + "import { html } from 'react-strict-dom';\n"
    + "const styles = css.create({ root: { color: 'red' } });\n";
  fs.mkdirSync(path.dirname(routePath), { recursive: true });
  fs.writeFileSync(routePath, source);

  const plan = planFrontendUpgrade(outputDir);

  assert.equal(
    plan.changes.some(change => change.relativePath === 'app/index.tsx'),
    false
  );
  assert.equal(fs.readFileSync(routePath, 'utf8'), source);
});

test('recognizes the affected generated starter and legacy registry hashes', () => {
  assert.deepEqual(BROKEN_NATIVE_STYLE_FILE_HASHES, {
    'app/index.tsx': 'c98a2686fb00ea142dad9a95f7e3eaf0a3e9a834a223739c484684bc5d50a954',
    'app/profile/[id].tsx': 'dc563718506cc5a053acf5f4cc87134fcba9dd0b3bd46653e72c9eac9d62316f',
  });
  assert.ok(LEGACY_MANAGED_HASHES['src/navigation/RouteRegistry.tsx'].includes(
    'aee7d6f66e898cf5332140e6f631a70b2322a72f5c54d829e9acbf0182364de2'
  ));
  assert.deepEqual(MISALIGNED_NATIVE_BADGE_FILE_HASHES, {
    'app/profile/[id].tsx': [
      '8aebcdb9165962a816fc6cd57512d184b40ee5b7b26de33959a878a954f5e4c4',
      'dc563718506cc5a053acf5f4cc87134fcba9dd0b3bd46653e72c9eac9d62316f',
    ],
  });
});

test('preserves a managed frontend customization when its base is unchanged', t => {
  const outputDir = createProject(t);
  const targetContents = managedFileContents();
  for (const [relativePath, content] of Object.entries(targetContents)) {
    const filePath = path.join(outputDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  writeFrontendManifest(outputDir, targetContents);
  fs.appendFileSync(path.join(outputDir, 'webpack.config.js'), '// customized\n');

  const plan = planFrontendUpgrade(outputDir);

  assert.deepEqual(plan.conflicts, []);
  assert.equal(
    plan.changes.some(change => change.relativePath === 'webpack.config.js'),
    false
  );
});

test('merges generated output ignores without replacing project rules', t => {
  const outputDir = createProject(t);
  fs.writeFileSync(path.join(outputDir, '.gitignore'), 'custom-cache/\n');

  const plan = planFrontendUpgrade(outputDir);
  const change = plan.changes.find(item => item.relativePath === '.gitignore');

  assert.match(change.content, /^custom-cache\//);
  assert.match(change.content, /routes\.android\.ts/);
  assert.match(change.content, /runtime-config\.json/);
  assert.match(change.content, /android\/app\/\.cxx\//);
  assert.equal(updatedFrontendGitignore(change.content), change.content);
  assert.deepEqual(plan.conflicts, []);
});

test('reports a conflict when both framework and project changed a managed file', t => {
  const outputDir = createProject(t);
  const targetContents = managedFileContents();
  for (const [relativePath, content] of Object.entries(targetContents)) {
    const filePath = path.join(outputDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  writeFrontendManifest(outputDir, targetContents);
  const manifestPath = path.join(outputDir, FRONTEND_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.managedFiles['webpack.config.js'] = 'old-framework-hash';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.appendFileSync(path.join(outputDir, 'webpack.config.js'), '// customized\n');

  const plan = planFrontendUpgrade(outputDir);

  assert.equal(plan.conflicts.length, 1);
  assert.match(plan.conflicts[0], /webpack\.config\.js was modified/);
});

test('applies a frontend upgrade with a recoverable backup', t => {
  const outputDir = createProject(t);
  fs.writeFileSync(path.join(outputDir, 'babel.config.js'), LEGACY_BABEL_CONFIG);
  const calls = [];
  const plan = planFrontendUpgrade(outputDir);

  const backupDir = applyFrontendUpgrade(
    plan,
    (...args) => calls.push(args)
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'npm');
  assert.ok(fs.existsSync(path.join(outputDir, FRONTEND_MANIFEST)));
  assert.ok(fs.existsSync(path.join(backupDir, 'babel.config.js')));
  const upgradedPackage = require(path.join(outputDir, 'package.json'));
  assert.equal(
    upgradedPackage.devDependencies['onramp-js'],
    packageJson.version
  );
  assert.match(
    upgradedPackage.jest.transformIgnorePatterns[0],
    /onramp-js/
  );
  assert.match(upgradedPackage.scripts.typecheck, /build-routes/);
  assert.ok(upgradedPackage.jest.modulePathIgnorePatterns.includes('/ios/'));
});

test('restores frontend files when dependency installation fails', t => {
  const outputDir = createProject(t);
  fs.writeFileSync(path.join(outputDir, 'babel.config.js'), LEGACY_BABEL_CONFIG);
  const originalPackage = fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8');
  const plan = planFrontendUpgrade(outputDir);

  assert.throws(
    () => applyFrontendUpgrade(plan, () => { throw new Error('install failed'); }),
    /install failed/
  );
  assert.equal(
    fs.readFileSync(path.join(outputDir, 'babel.config.js'), 'utf8'),
    LEGACY_BABEL_CONFIG
  );
  assert.equal(
    fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8'),
    originalPackage
  );
  assert.equal(fs.existsSync(path.join(outputDir, FRONTEND_MANIFEST)), false);
});

test('upgrade check verdict clearly reports success or failure', () => {
  const messages = [];
  const originalLog = console.log;
  console.log = message => messages.push(message);
  try {
    printFrontendCheckResult({ conflicts: [], changes: [{}], manifestChanged: true });
    printFrontendCheckResult({ conflicts: ['conflict'], changes: [], manifestChanged: false });
    printFrontendCheckResult({ conflicts: [], changes: [], manifestChanged: false });
  } finally {
    console.log = originalLog;
  }

  assert.match(messages[0], /should be successful/);
  assert.match(messages[1], /will not be successful/);
  assert.match(messages[2], /already up to date/);
  assert.doesNotMatch(messages[2], /should be successful/);
});

function snapshotProject(outputDir) {
  return fs.readdirSync(outputDir, { recursive: true }).sort().map(relativePath => {
    const filePath = path.join(outputDir, relativePath);
    return [relativePath, fs.statSync(filePath).isDirectory()
      ? null
      : fs.readFileSync(filePath)];
  });
}

for (const state of ['current', 'legacy', 'manifest-only', 'conflict']) {
  test(`Python upgrade check reports ${state} frontend state without project changes`, t => {
    t.mock.method(console, 'log', () => {});
    const outputDir = createProject(t);
    if (state !== 'legacy') {
      applyFrontendUpgrade(planFrontendUpgrade(outputDir), () => {});
    }
    if (state === 'manifest-only') {
      fs.rmSync(path.join(outputDir, FRONTEND_MANIFEST));
    }
    if (state === 'conflict') {
      const manifestPath = path.join(outputDir, FRONTEND_MANIFEST);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.managedFiles['babel.config.js'] = 'old-framework-hash';
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      fs.writeFileSync(path.join(outputDir, 'babel.config.js'), '// customized tooling\n');
    }
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-check-result-'));
    t.after(() => fs.rmSync(reportDir, { recursive: true, force: true }));
    const reportPath = path.join(reportDir, 'result.json');
    const previousWrapper = process.env.ONRAMP_PYTHON_WRAPPER;
    const previousResultPath = process.env.ONRAMP_UPGRADE_CHECK_RESULT;
    process.env.ONRAMP_PYTHON_WRAPPER = '1';
    process.env.ONRAMP_UPGRADE_CHECK_RESULT = reportPath;
    t.after(() => {
      if (previousWrapper === undefined) delete process.env.ONRAMP_PYTHON_WRAPPER;
      else process.env.ONRAMP_PYTHON_WRAPPER = previousWrapper;
      if (previousResultPath === undefined) delete process.env.ONRAMP_UPGRADE_CHECK_RESULT;
      else process.env.ONRAMP_UPGRADE_CHECK_RESULT = previousResultPath;
    });
    const before = snapshotProject(outputDir);

    assert.equal(
      upgradeFrontend({ output: outputDir, check: true }, () => {
        assert.fail('An upgrade check must not install dependencies.');
      }),
      state !== 'conflict'
    );

    assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), {
      schemaVersion: 1,
      success: state !== 'conflict',
      hasChanges: state !== 'current',
    });
    assert.deepEqual(snapshotProject(outputDir), before);
  });
}
