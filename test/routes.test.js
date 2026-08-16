const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateRoutesConfig } = require('../templates/generateRoutes');

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
