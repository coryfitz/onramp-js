const assert = require('node:assert/strict');
const test = require('node:test');

const { createWebBabelOptions } = require('../src/web-babel');

test('web Babel injects React Strict DOM StyleX rules at runtime', () => {
  const resolved = [];
  const reactStrictPlugin = ['react-strict-transform', { debug: true }];
  const resolveModule = (request, root) => {
    resolved.push({ request, root });
    return `resolved:${request}`;
  };
  const loadModule = modulePath => {
    assert.equal(modulePath, 'resolved:react-strict-dom/babel-preset');
    return () => ({
      plugins: [reactStrictPlugin, ['embedded-stylex-without-output']],
    });
  };

  const options = createWebBabelOptions('/example/project', {
    resolveModule,
    loadModule,
  });

  assert.deepEqual(options.plugins[0], reactStrictPlugin);
  assert.equal(options.plugins[1][0], 'resolved:@stylexjs/babel-plugin');
  assert.equal(options.plugins[1][1].runtimeInjection, true);
  assert.equal(options.plugins[1][1].styleResolution, 'property-specificity');
  assert.deepEqual(options.plugins[1][1].importSources, [
    { from: 'react-strict-dom', as: 'css' },
  ]);
  assert.equal(options.plugins[1][1].unstable_moduleResolution.rootDir, '/example/project');
  assert(options.presets.some(preset => preset[0] === '@babel/preset-typescript'));
  assert.deepEqual(resolved, [
    {
      request: 'react-strict-dom/babel-preset',
      root: '/example/project',
    },
    { request: '@stylexjs/babel-plugin', root: '/example/project' },
  ]);
});

test('React Strict DOM dependency compilation can omit the TypeScript preset', () => {
  const options = createWebBabelOptions('/example/project', {
    typescript: false,
    resolveModule: request => request,
    loadModule: () => () => ({ plugins: [['react-strict-transform']] }),
  });

  assert(!options.presets.some(preset => preset[0] === '@babel/preset-typescript'));
});
