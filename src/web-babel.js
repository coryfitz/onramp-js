function resolveFromProject(request, projectRoot) {
  return require.resolve(request, { paths: [projectRoot] });
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
    ],
  };
}

module.exports = { createWebBabelOptions, resolveFromProject };
