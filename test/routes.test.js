const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateRoutesConfig, routesFileName } = require('../src/routes');

test('the starter app demonstrates home and dynamic file routes', () => {
  const templates = path.join(__dirname, '..', 'templates', 'app');
  const home = fs.readFileSync(path.join(templates, 'index.tsx'), 'utf8');
  const profile = fs.readFileSync(path.join(templates, 'profile', '[id].tsx'), 'utf8');
  const starter = `${home}\n${profile}`;

  assert.match(home, /navigate\('\/profile\/ada'\)/);
  assert.match(profile, /function ProfilePage\(\{ id \}/);
  assert.match(profile, /app\/profile\/\[id\]\.tsx/);
  assert.equal(fs.existsSync(path.join(templates, 'about.tsx')), false);
  assert.doesNotMatch(starter, /window\.location/);
});

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
  assert.match(iosContent, /import \* as routeModule\d+ from '\.\.\/\.\.\/app\/settings\.ios';/);
  assert.match(iosContent, /Promise\.resolve\(routeModule\d+\)/);
  assert.doesNotMatch(iosContent, /\(\) => import\(/);
  const iosMtime = fs.statSync(iosPath).mtimeMs;

  process.env.ONRAMP_PLATFORM = 'android';
  assert.equal(generateRoutesConfig(projectRoot), true);
  const androidPath = path.join(generatedDir, routesFileName('android'));
  const androidContent = fs.readFileSync(androidPath, 'utf8');
  assert.match(androidContent, /settings\.android/);
  assert.match(
    androidContent,
    /import \* as routeModule\d+ from '\.\.\/\.\.\/app\/settings\.android';/
  );
  assert.match(androidContent, /Promise\.resolve\(routeModule\d+\)/);
  assert.doesNotMatch(androidContent, /\(\) => import\(/);
  assert.equal(fs.readFileSync(iosPath, 'utf8'), iosContent);
  assert.equal(fs.statSync(iosPath).mtimeMs, iosMtime);
  assert.notEqual(androidPath, iosPath);
});

test('keeps file-based route semantics while splitting only web routes', t => {
  const originalPlatform = process.env.ONRAMP_PLATFORM;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-routes-loading-test-'));
  const appDir = path.join(projectRoot, 'app');
  const generatedDir = path.join(projectRoot, 'src', 'generated');

  fs.mkdirSync(path.join(appDir, 'blog'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.tsx'), 'export default function Home() {}\n');
  fs.writeFileSync(path.join(appDir, 'blog', 'index.tsx'), 'export default function Blog() {}\n');
  fs.writeFileSync(
    path.join(appDir, 'profile', '[id].tsx'),
    'export default function Profile() {}\n'
  );

  t.after(() => {
    if (originalPlatform === undefined) delete process.env.ONRAMP_PLATFORM;
    else process.env.ONRAMP_PLATFORM = originalPlatform;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  process.env.ONRAMP_PLATFORM = 'web';
  assert.equal(generateRoutesConfig(projectRoot), true);
  const webContent = fs.readFileSync(path.join(generatedDir, routesFileName('web')), 'utf8');
  assert.match(webContent, /"path": "\/"/);
  assert.match(webContent, /"path": "\/index"/);
  assert.match(webContent, /"path": "\/blog"/);
  assert.match(webContent, /"path": "\/blog\/index"/);
  assert.match(webContent, /"path": "\/profile\/:id"/);
  assert.match(webContent, /"isDynamic": true/);
  assert.match(webContent, /\(\) => import\('\.\.\/\.\.\/app\/index'\)/);
  assert.doesNotMatch(webContent, /import \* as routeModule/);
  assert.doesNotMatch(webContent, /Promise\.resolve\(routeModule/);

  process.env.ONRAMP_PLATFORM = 'native';
  assert.equal(generateRoutesConfig(projectRoot), true);
  const nativeContent = fs.readFileSync(path.join(generatedDir, routesFileName('native')), 'utf8');
  assert.match(nativeContent, /"path": "\/"/);
  assert.match(nativeContent, /"path": "\/index"/);
  assert.match(nativeContent, /"path": "\/blog"/);
  assert.match(nativeContent, /"path": "\/blog\/index"/);
  assert.match(nativeContent, /"path": "\/profile\/:id"/);
  assert.match(nativeContent, /"isDynamic": true/);
  assert.match(nativeContent, /import \* as routeModule\d+ from '\.\.\/\.\.\/app\/index';/);
  assert.match(nativeContent, /\(\) => Promise\.resolve\(routeModule\d+\)/);
  assert.doesNotMatch(nativeContent, /\(\) => import\(/);

  assert.equal((nativeContent.match(/from '\.\.\/\.\.\/app\/index';/g) || []).length, 1);
  assert.equal(
    (nativeContent.match(/"\.\.\/\.\.\/app\/index": \(\) => Promise\.resolve/g) || []).length,
    1
  );
});
