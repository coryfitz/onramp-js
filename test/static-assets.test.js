const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  OnRampStaticAssetsPlugin,
  copyStaticAssets,
} = require('../src/static-assets');

test('production assets retain files and nested directories', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-assets-test-'));
  const outputDirectory = path.join(projectRoot, 'dist');
  const nestedDirectory = path.join(projectRoot, 'assets', 'screenshots');
  fs.mkdirSync(nestedDirectory, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'assets', 'icon.txt'), 'icon');
  fs.writeFileSync(path.join(nestedDirectory, 'portfolio.txt'), 'portfolio');

  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  copyStaticAssets(projectRoot, outputDirectory);

  assert.equal(fs.readFileSync(path.join(outputDirectory, 'icon.txt'), 'utf8'), 'icon');
  assert.equal(
    fs.readFileSync(path.join(outputDirectory, 'screenshots', 'portfolio.txt'), 'utf8'),
    'portfolio',
  );
});

test('static asset plugin copies files after Webpack emits', t => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-assets-plugin-'));
  const outputDirectory = path.join(projectRoot, 'dist');
  fs.mkdirSync(path.join(projectRoot, 'assets'));
  fs.writeFileSync(path.join(projectRoot, 'assets', 'screen.txt'), 'screen');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  let afterEmit;
  const compiler = {
    hooks: {
      afterEmit: {
        tap(name, callback) {
          assert.equal(name, 'OnRampStaticAssetsPlugin');
          afterEmit = callback;
        },
      },
    },
    options: { output: { path: outputDirectory } },
  };

  new OnRampStaticAssetsPlugin(projectRoot).apply(compiler);
  assert.equal(typeof afterEmit, 'function');
  afterEmit();

  assert.equal(fs.readFileSync(path.join(outputDirectory, 'screen.txt'), 'utf8'), 'screen');
});
