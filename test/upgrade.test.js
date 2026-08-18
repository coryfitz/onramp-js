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
  assert.equal(plan.toSchema, 1);
  assert.equal(plan.migrations.length, 1);
  assert.deepEqual(plan.conflicts, []);
  assert.ok(plan.changes.some(change => change.relativePath === 'babel.config.js'));
  assert.ok(plan.changes.some(change => change.relativePath === 'package.json'));
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
  assert.equal(
    require(path.join(outputDir, 'package.json')).devDependencies['onramp-js'],
    packageJson.version
  );
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
