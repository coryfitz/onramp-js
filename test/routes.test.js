const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateRoutesConfig, routesFileName } = require('../src/routes');

test('does not rewrite unchanged generated routes', t => {
  const originalCwd = process.cwd();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-routes-test-'));
  const appDir = path.join(projectRoot, 'app');
  const outFile = path.join(projectRoot, 'src', 'generated', 'routes.ts');

  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.tsx'), 'export default function Home() {}\n');

  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  process.chdir(projectRoot);
  assert.equal(generateRoutesConfig(), true);

  const sentinel = new Date('2000-01-01T00:00:00.000Z');
  fs.utimesSync(outFile, sentinel, sentinel);
  const originalMtime = fs.statSync(outFile).mtimeMs;

  assert.equal(generateRoutesConfig(), false);
  assert.equal(fs.statSync(outFile).mtimeMs, originalMtime);
});

test('writes platform route registries independently', t => {
  const originalPlatform = process.env.ONRAMP_PLATFORM;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-routes-platform-test-'));
  const appDir = path.join(projectRoot, 'app');
  const generatedDir = path.join(projectRoot, 'src', 'generated');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.tsx'), 'export default function Home() {}\n');
  fs.writeFileSync(path.join(appDir, 'settings.ios.tsx'), 'export default function Ios() {}\n');
  fs.writeFileSync(path.join(appDir, 'settings.android.tsx'), 'export default function Android() {}\n');

  t.after(() => {
    if (originalPlatform === undefined) delete process.env.ONRAMP_PLATFORM;
    else process.env.ONRAMP_PLATFORM = originalPlatform;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  process.env.ONRAMP_PLATFORM = 'ios';
  assert.equal(generateRoutesConfig(projectRoot), true);
  const iosPath = path.join(generatedDir, routesFileName('ios'));
  const iosContent = fs.readFileSync(iosPath, 'utf8');
  assert.match(iosContent, /settings\.ios/);
  const iosMtime = fs.statSync(iosPath).mtimeMs;

  process.env.ONRAMP_PLATFORM = 'android';
  assert.equal(generateRoutesConfig(projectRoot), true);
  const androidPath = path.join(generatedDir, routesFileName('android'));
  const androidContent = fs.readFileSync(androidPath, 'utf8');
  assert.match(androidContent, /settings\.android/);
  assert.equal(fs.readFileSync(iosPath, 'utf8'), iosContent);
  assert.equal(fs.statSync(iosPath).mtimeMs, iosMtime);
  assert.notEqual(androidPath, iosPath);
});
