function resolveFromProject(request, projectRoot) {
  return require.resolve(request, { paths: [projectRoot] });
}

function removeCompiledStrictDomCssImport({ types: t }) {
  return {
    name: 'onramp-remove-compiled-strict-dom-css-import',
    visitor: {
      Program: {
        exit(programPath) {
          programPath.scope.crawl();
          for (const statementPath of programPath.get('body')) {
            if (
              !statementPath.isImportDeclaration()
              || statementPath.node.source.value !== 'react-strict-dom'
            ) {
              continue;
            }

            const specifiers = statementPath.node.specifiers.filter(specifier => {
              if (
                !t.isImportSpecifier(specifier)
                || !t.isIdentifier(specifier.imported, { name: 'css' })
              ) {
                return true;
              }

              const binding = programPath.scope.getBinding(specifier.local.name);
              return binding?.referenced === true;
            });
            if (specifiers.length === 0) {
              statementPath.remove();
            } else {
              statementPath.node.specifiers = specifiers;
            }
          }
        },
      },
    },
  };
}

function createWebBabelOptions(
  projectRoot,
  { typescript = true, resolveModule = resolveFromProject, loadModule = require } = {},
) {
  const strictDomPresetPath = resolveModule(
    'react-strict-dom/babel-preset',
    projectRoot,
  );
  const strictDomPreset = loadModule(strictDomPresetPath);
  const [reactStrictPlugin] = strictDomPreset(undefined, {
    debug: true,
    dev: true,
    platform: 'web',
  }).plugins;
  const stylexPluginPath = resolveModule('@stylexjs/babel-plugin', projectRoot);

  const presets = [
    ['@babel/preset-env', { targets: 'defaults' }],
    ['@babel/preset-react', { runtime: 'automatic' }],
  ];
  if (typescript) presets.push(['@babel/preset-typescript']);

  return {
    babelrc: false,
    configFile: false,
    presets,
    plugins: [
      // This order is a cross-platform contract. React Strict DOM identifies
      // its css.create calls, StyleX emits their web rules, and the final pass
      // removes only the named css import that those transforms consumed.
      // Native compilation keeps React Strict DOM's runtime style objects.
      reactStrictPlugin,
      [
        stylexPluginPath,
        {
          dev: true,
          genConditionalClasses: true,
          importSources: [{ from: 'react-strict-dom', as: 'css' }],
          runtimeInjection: true,
          styleResolution: 'property-specificity',
          treeshakeCompensation: true,
          unstable_moduleResolution: {
            type: 'commonJS',
            rootDir: projectRoot,
          },
        },
      ],
      removeCompiledStrictDomCssImport,
    ],
  };
}

module.exports = {
  createWebBabelOptions,
  removeCompiledStrictDomCssImport,
  resolveFromProject,
};
