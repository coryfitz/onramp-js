const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const packageJson = require('../package.json');

const {
  FRONTEND_MANIFEST,
  managedFileContents,
  writeFrontendManifest,
} = require('../src/project');
const {
  applyFrontendUpgrade,
  planFrontendUpgrade,
  printFrontendCheckResult,
  updatedFrontendGitignore,
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
  } finally {
    console.log = originalLog;
  }

  assert.match(messages[0], /should be successful/);
  assert.match(messages[1], /will not be successful/);
});
