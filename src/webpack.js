const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { generateRoutesConfig } = require('./routes');
const { OnRampStaticAssetsPlugin } = require('./static-assets');
const { createWebBabelOptions } = require('./web-babel');

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
            options: createWebBabelOptions(root),
          },
        },
        {
          test: /\.(js|jsx|ts|tsx)$/,
          include: /node_modules[\\/]react-strict-dom/,
          use: {
            loader: 'babel-loader',
            options: createWebBabelOptions(root, { typescript: false }),
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
      new OnRampStaticAssetsPlugin(root),
    ],
    output: {
      path: path.join(root, 'dist'),
      filename: 'bundle.js',
      publicPath: '/',
    },
  };
}

module.exports = { createWebpackConfig };
