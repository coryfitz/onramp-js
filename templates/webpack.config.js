const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { generateRoutesConfig } = require('./generateRoutes');

process.env.ONRAMP_PLATFORM = 'web';
generateRoutesConfig();

class OnRampRoutesPlugin {
  apply(compiler) {
    compiler.hooks.beforeRun.tap('OnRampRoutesPlugin', generateRoutesConfig);
    compiler.hooks.watchRun.tap('OnRampRoutesPlugin', generateRoutesConfig);
  }
}

module.exports = {
  entry: './index.web.js',
  mode: 'development',
  devServer: {
    port: 'auto',
    historyApiFallback: true,
    static: { directory: path.join(__dirname, 'assets') },
    watchFiles: ['app/**/*'],
  },
  module: {
    rules: [
      // App code
      {
        test: /\.(js|jsx|ts|tsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            // Use only these options for web (avoid metro config bleed-through)
            babelrc: false,
            configFile: false,
            presets: [
              ['@babel/preset-env', { targets: 'defaults' }],
              ['@babel/preset-react', { runtime: 'automatic' }],
              ['@babel/preset-typescript'],
              ['react-strict-dom/babel-preset', { platform: 'web' }]
            ],
            plugins: [
              ['@stylexjs/babel-plugin', {
                dev: true,
                runtimeInjection: false,
                genConditionalClasses: true,
                treeshakeCompensation: true,
                unstable_moduleResolution: { type: 'commonJS', rootDir: __dirname }
              }]
            ]
          }
        }
      },
      // Transpile react-strict-dom itself for web
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
              ['react-strict-dom/babel-preset', { platform: 'web' }]
            ],
            plugins: [
              ['@stylexjs/babel-plugin', {
                dev: true,
                runtimeInjection: false,
                genConditionalClasses: true,
                treeshakeCompensation: true,
                unstable_moduleResolution: { type: 'commonJS', rootDir: __dirname }
              }]
            ]
          }
        }
      }
    ]
  },
  resolve: {
    extensions: ['.web.js','.web.jsx','.web.ts','.web.tsx','.js','.jsx','.ts','.tsx'],
    alias: { 'react-native$': 'react-strict-dom' }
  },
  plugins: [
    new OnRampRoutesPlugin(),
    new HtmlWebpackPlugin({ template: 'index.html', inject: true }),
  ],
  output: { path: path.resolve(__dirname, 'dist'), filename: 'bundle.js', publicPath: '/' }
};
