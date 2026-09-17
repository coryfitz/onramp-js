import { AppRegistry } from 'react-native';
import { registerRuntimeConfig } from 'onramp-js/runtime-config';
import App from './App';
import { name as appName } from './app.json';
import runtimeConfig from './src/generated/runtime-config.json';

registerRuntimeConfig(runtimeConfig);
AppRegistry.registerComponent(appName, () => App);
