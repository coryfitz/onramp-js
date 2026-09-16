const fs = require('fs');
const path = require('path');

const ENVIRONMENTS = ['development', 'staging', 'production'];
const LOCAL_BACKEND_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '10.0.2.2',
]);

function normalizeEnvironment(value = process.env.ONRAMP_ENVIRONMENT || 'development') {
  const environment = String(value).trim().toLowerCase();
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(
      `Environment must be ${ENVIRONMENTS.join(', ')}; received ${value}.`
    );
  }
  return environment;
}

function defaultApiBaseUrl(environment, platform) {
  if (environment !== 'development') return '';
  return platform === 'android'
    ? 'http://10.0.2.2:8000'
    : 'http://127.0.0.1:8000';
}

function readEnvironmentProfiles(outputDir) {
  const appJsonPath = path.join(outputDir, 'app.json');
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  return appJson.environments || {};
}

function resolveEnvironmentProfile(outputDir, requested, platform = 'web') {
  const environment = normalizeEnvironment(requested);
  const profile = readEnvironmentProfiles(outputDir)[environment] || {};
  const configuredUrl = profile.apiBaseUrl;
  const apiBaseUrl = typeof configuredUrl === 'string'
    ? configuredUrl
    : configuredUrl?.[platform] || configuredUrl?.default || '';
  return {
    appEnvironment: environment,
    apiBaseUrl: (apiBaseUrl || defaultApiBaseUrl(environment, platform)).replace(/\/$/, ''),
    displayNameSuffix: String(profile.displayNameSuffix || ''),
    identifierSuffix: String(profile.identifierSuffix || ''),
  };
}

function normalizeBackendPort(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Backend port must be an integer between 1 and 65535.');
  }
  return port;
}

function withLocalBackendPort(apiBaseUrl, backendPort) {
  if (!apiBaseUrl || backendPort === undefined) return apiBaseUrl;
  let parsed;
  try {
    parsed = new URL(apiBaseUrl);
  } catch (_) {
    return apiBaseUrl;
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.username
    || parsed.password
    || !LOCAL_BACKEND_HOSTS.has(parsed.hostname)
  ) {
    return apiBaseUrl;
  }
  parsed.port = String(backendPort);
  return parsed.toString().replace(/\/$/, '');
}

function writeRuntimeConfig(outputDir, requested, platform, options = {}) {
  const profile = resolveEnvironmentProfile(outputDir, requested, platform);
  const backendPort = normalizeBackendPort(options.backendPort);
  const apiBaseUrl = Object.fromEntries(
    ['web', 'ios', 'android'].map(target => [
      target,
      withLocalBackendPort(
        resolveEnvironmentProfile(outputDir, requested, target).apiBaseUrl,
        backendPort
      ),
    ])
  );
  const destination = path.join(outputDir, 'src', 'generated', 'runtime-config.json');
  const content = `${JSON.stringify({
    appEnvironment: profile.appEnvironment,
    apiBaseUrl,
  }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) {
    fs.writeFileSync(destination, content, 'utf8');
  }
  return profile;
}

module.exports = {
  ENVIRONMENTS,
  normalizeEnvironment,
  readEnvironmentProfiles,
  resolveEnvironmentProfile,
  writeRuntimeConfig,
};
