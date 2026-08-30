const { generateRoutesConfig } = require('onramp-js/routes');
const { writeRuntimeConfig } = require('onramp-js/environment');

generateRoutesConfig();
writeRuntimeConfig(
  process.cwd(),
  process.env.ONRAMP_ENVIRONMENT || 'development',
  process.env.ONRAMP_PLATFORM || 'web'
);
