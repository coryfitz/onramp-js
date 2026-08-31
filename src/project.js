const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const packageJson = require('../package.json');
const templatePackageJson = require('../templates/package.json');

const FRONTEND_SCHEMA_VERSION = 3;
const FRONTEND_MANIFEST = path.join('.onramp', 'project.json');
const MANAGED_FILES = [
  '.nvmrc',
  'babel.config.js',
  'generateRoutes.js',
  'metro.config.js',
  'scripts/build-routes.js',
  'src/navigation/NavigationProvider.tsx',
  'src/navigation/RouteRegistry.tsx',
  'tsconfig.json',
  'webpack.config.js',
];

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function managedFileContents(templatesDir = path.resolve(__dirname, '..', 'templates')) {
  return Object.fromEntries(
    MANAGED_FILES.map(relativePath => [
      relativePath,
      fs.readFileSync(path.join(templatesDir, relativePath), 'utf8'),
    ])
  );
}

function buildFrontendManifest(contents = managedFileContents()) {
  return {
    schemaVersion: FRONTEND_SCHEMA_VERSION,
    onrampJsVersion: packageJson.version,
    reactNativeVersion: templatePackageJson.dependencies['react-native'],
    managedFiles: Object.fromEntries(
      Object.entries(contents).map(([relativePath, content]) => [
        relativePath,
        sha256(content),
      ])
    ),
  };
}

function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.onramp-tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function writeFrontendManifest(outputDir, contents = managedFileContents()) {
  const manifest = buildFrontendManifest(contents);
  atomicWrite(
    path.join(outputDir, FRONTEND_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

function readFrontendManifest(outputDir) {
  const manifestPath = path.join(outputDir, FRONTEND_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

module.exports = {
  atomicWrite,
  buildFrontendManifest,
  FRONTEND_MANIFEST,
  FRONTEND_SCHEMA_VERSION,
  managedFileContents,
  MANAGED_FILES,
  readFrontendManifest,
  sha256,
  writeFrontendManifest,
};
