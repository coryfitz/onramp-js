const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { generateRoutesConfig } = require('./routes');

function createWebpackConfig(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  process.env.ONRAMP_PLATFORM = 'web';

  const generateRoutes = () => generateRoutesConfig(root);
  generateRoutes();

  class OnRampRoutesPlugin {
    apply(compiler) {
      compiler.hooks.beforeRun.tap('OnRampRoutesPlugin', generateRoutes);
      compiler.hooks.watchRun.tap('OnRampRoutesPlugin', generateRoutes);
    }
  }

  return {
    context: root,
    entry: './index.web.js',
    mode: 'development',
    devServer: {
      port: 'auto',
      historyApiFallback: true,
      static: { directory: path.join(root, 'assets') },
      watchFiles: ['app/**/*'],
    },
    module: {
      rules: [
        {
          test: /\.(js|jsx|ts|tsx)$/,
          exclude: filePath => (
            /node_modules/.test(filePath)
            && !/node_modules[\\/]onramp-js[\\/]src[\\/]runtime/.test(filePath)
          ),
          use: {
            loader: 'babel-loader',
            options: {
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', { targets: 'defaults' }],
                ['@babel/preset-react', { runtime: 'automatic' }],
                ['@babel/preset-typescript'],
                ['react-strict-dom/babel-preset', { platform: 'web' }],
              ],
              plugins: [
                ['@stylexjs/babel-plugin', {
                  dev: true,
                  runtimeInjection: false,
                  genConditionalClasses: true,
                  treeshakeCompensation: true,
                  unstable_moduleResolution: { type: 'commonJS', rootDir: root },
                }],
              ],
            },
          },
        },
        {
          test: /\.(js|jsx|ts|tsx)$/,
          include: /node_modules[\\/]react-strict-dom/,
          use: {
            loader: 'babel-loader',
            options: {
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', { targets: 'defaults' }],
                ['@babel/preset-react', { runtime: 'automatic' }],
                ['react-strict-dom/babel-preset', { platform: 'web' }],
              ],
              plugins: [
                ['@stylexjs/babel-plugin', {
                  dev: true,
                  runtimeInjection: false,
                  genConditionalClasses: true,
                  treeshakeCompensation: true,
                  unstable_moduleResolution: { type: 'commonJS', rootDir: root },
                }],
              ],
            },
          },
        },
      ],
    },
    resolve: {
      extensions: ['.web.js', '.web.jsx', '.web.ts', '.web.tsx', '.js', '.jsx', '.ts', '.tsx'],
      alias: { 'react-native$': 'react-strict-dom' },
    },
    plugins: [
      new OnRampRoutesPlugin(),
      new HtmlWebpackPlugin({
        template: path.join(root, 'index.html'),
        inject: true,
      }),
    ],
    output: {
      path: path.join(root, 'dist'),
      filename: 'bundle.js',
      publicPath: '/',
    },
  };
}

module.exports = { createWebpackConfig };
