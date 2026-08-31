const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createWebBabelOptions,
  removeCompiledStrictDomCssImport,
} = require('../src/web-babel');

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
  assert.equal(options.plugins[2], removeCompiledStrictDomCssImport);
  assert(options.presets.some(preset => preset[0] === '@babel/preset-typescript'));
  assert.deepEqual(resolved, [
    {
      request: 'react-strict-dom/babel-preset',
      root: '/example/project',
    },
    { request: '@stylexjs/babel-plugin', root: '/example/project' },
  ]);
});

test('web Babel removes only the compiled React Strict DOM css import', () => {
  const cssSpecifier = {
    type: 'ImportSpecifier',
    imported: { type: 'Identifier', name: 'css' },
    local: { type: 'Identifier', name: 'styles' },
  };
  const htmlSpecifier = {
    type: 'ImportSpecifier',
    imported: { type: 'Identifier', name: 'html' },
    local: { type: 'Identifier', name: 'html' },
  };
  const strictDomImport = {
    node: {
      source: { value: 'react-strict-dom' },
      specifiers: [cssSpecifier, htmlSpecifier],
    },
    isImportDeclaration: () => true,
    remove: () => assert.fail('the html import must remain'),
  };
  const otherImport = {
    node: {
      source: { value: 'other-package' },
      specifiers: [cssSpecifier],
    },
    isImportDeclaration: () => true,
  };
  const types = {
    isIdentifier: (node, shape) => (
      node?.type === 'Identifier' && node.name === shape.name
    ),
    isImportSpecifier: node => node?.type === 'ImportSpecifier',
  };
  const plugin = removeCompiledStrictDomCssImport({ types });
  let crawled = false;

  plugin.visitor.Program.exit({
    scope: {
      crawl: () => {
        crawled = true;
      },
      getBinding: name => {
        assert.equal(name, 'styles');
        return { referenced: false };
      },
    },
    get: name => {
      assert.equal(name, 'body');
      return [strictDomImport, otherImport];
    },
  });

  assert.equal(crawled, true);
  assert.deepEqual(strictDomImport.node.specifiers, [htmlSpecifier]);
  assert.deepEqual(otherImport.node.specifiers, [cssSpecifier]);
});

test('web Babel preserves a React Strict DOM css import that remains referenced', () => {
  const cssSpecifier = {
    type: 'ImportSpecifier',
    imported: { type: 'Identifier', name: 'css' },
    local: { type: 'Identifier', name: 'css' },
  };
  const strictDomImport = {
    node: {
      source: { value: 'react-strict-dom' },
      specifiers: [cssSpecifier],
    },
    isImportDeclaration: () => true,
    remove: () => assert.fail('a referenced import must remain'),
  };
  const types = {
    isIdentifier: (node, shape) => (
      node?.type === 'Identifier' && node.name === shape.name
    ),
    isImportSpecifier: node => node?.type === 'ImportSpecifier',
  };
  const plugin = removeCompiledStrictDomCssImport({ types });

  plugin.visitor.Program.exit({
    scope: {
      crawl: () => {},
      getBinding: name => {
        assert.equal(name, 'css');
        return { referenced: true };
      },
    },
    get: name => {
      assert.equal(name, 'body');
      return [strictDomImport];
    },
  });

  assert.deepEqual(strictDomImport.node.specifiers, [cssSpecifier]);
});

test('React Strict DOM dependency compilation can omit the TypeScript preset', () => {
  const options = createWebBabelOptions('/example/project', {
    typescript: false,
    resolveModule: request => request,
    loadModule: () => () => ({ plugins: [['react-strict-transform']] }),
  });

  assert(!options.presets.some(preset => preset[0] === '@babel/preset-typescript'));
});
