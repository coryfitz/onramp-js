import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerRuntimeConfig } from 'onramp-js/runtime-config';
import App from './App';
import runtimeConfig from './src/generated/runtime-config.json';

registerRuntimeConfig(runtimeConfig);
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
