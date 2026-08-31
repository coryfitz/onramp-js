const fs = require('fs');
const path = require('path');

const packageJson = require('../package.json');
const templatePackageJson = require('../templates/package.json');
const {
  atomicWrite,
  buildFrontendManifest,
  FRONTEND_MANIFEST,
  FRONTEND_SCHEMA_VERSION,
  managedFileContents,
  readFrontendManifest,
  sha256,
} = require('./project');
const { isPythonWrapper, run } = require('./process');

const FRONTEND_GITIGNORE_ENTRIES = [
  'src/generated/runtime-config.json',
  'src/generated/routes.android.ts',
  'src/generated/routes.ios.ts',
  'src/generated/routes.web.ts',
  'android/.kotlin/',
  'android/app/.cxx/',
  '.bundle/',
  '.metro-health-check*',
  '.onramp/backups/',
];

const LEGACY_MANAGED_HASHES = {
  '.nvmrc': [
    '5378796307535df3ec8d8b15a2e2dc5641419c3d3060cfe32238c0fa973f7aa3',
  ],
  'babel.config.js': [
    '44d42353b1c8986f910673427f2cabf3e85d7bee374deaf3e3855f47a2c784c9',
  ],
  'generateRoutes.js': [
    'ba5f572b1ba16a631e043618c2149741fcfd384029cd67f3d0126e921b7d2ce8',
    '97969ae34773f437a02939e0fca3d70210dd7e29e6c6c6c6b8ee1f9c642ef1b3',
    '6dbbc87bbe5f555434829e0f9c1a0c160347cb6010fe782faa1a482a94450c57',
  ],
  'metro.config.js': [
    '6d6f641d82744e7c285b4fc4fd16226cb85159d6510f729b38624d205b2b8158',
    '059501a3e4789dd5f4e678b5493477a2a2e43a9a7bcabfe5b1225853117dbbb8',
  ],
  'scripts/build-routes.js': [
    '7185a64d6bc3bc0fe2cf12719f4f25e14b0d6fe1d4ad138960a994e4e3210b5a',
    '950b8ed6dc4832d479cf52da73ce464fe5d234daab548a676474ad624bb0541a',
  ],
  'src/navigation/NavigationProvider.tsx': [
    'b2b15a122634eafd00ef0892b4d629b72d94e9d135478d3714e2d1f3717ed233',
  ],
  'src/navigation/RouteRegistry.tsx': [
    'cd47104819f460467921ee6a2bc59dff3727b9223a36169499affc734226b897',
    'aee7d6f66e898cf5332140e6f631a70b2322a72f5c54d829e9acbf0182364de2',
  ],
  'tsconfig.json': [
    'ed4f7b9cefd9a46c0be9e0a9b80aae60f84eabbf248af016cfc229a8e2041ee1',
    '14d4d3ab6d7b5dbebe1f4d2db7732b6beda5391ef84fe0e41d29feb44942d286',
  ],
  'webpack.config.js': [
    '155bca7673ad0b4d02a92c948d99ed5bb82a634ed6d1a3d4007a0e52d948ed62',
    '9aa02f5f6458efeddc7a198ef910e41f54ce74e8d1d7e325c11b168a418ae411',
  ],
};

const FRONTEND_MIGRATIONS = new Map([
  [0, 'adopt package-owned tooling and versioned frontend metadata'],
  [1, 'isolate generated route modules by platform'],
  [2, 'upgrade the secure Node, React Native, Metro, and webpack toolchain'],
]);

const MANAGED_PACKAGE_DEPENDENCIES = {
  dependencies: [
    'react',
    'react-dom',
    'react-native',
  ],
  devDependencies: [
    '@react-native-community/cli',
    '@react-native-community/cli-platform-android',
    '@react-native-community/cli-platform-ios',
    '@react-native/babel-preset',
    '@react-native/jest-preset',
    '@react-native/metro-config',
    '@types/react',
    '@types/react-dom',
    'react-test-renderer',
    'typescript',
    'webpack',
    'webpack-dev-server',
  ],
};

const LEGACY_MANAGED_PACKAGE_SPECS = {
  dependencies: {
    react: ['19.0.0', '19.1.0'],
    'react-dom': ['19.0.0', '19.1.0'],
    'react-native': ['0.81.0', '0.81.1'],
  },
  devDependencies: {
    '@react-native-community/cli': ['^20.0.0', '^20.0.2', '20.1.0'],
    '@react-native-community/cli-platform-android': ['^20.0.0', '^20.0.2', '20.1.0'],
    '@react-native-community/cli-platform-ios': ['^20.0.0', '^20.0.2', '20.1.0'],
    '@react-native/babel-preset': ['0.81.0', '0.81.1'],
    '@react-native/metro-config': ['0.81.0', '0.81.1'],
    '@types/react': ['^19.0.0', '^19.1.0'],
    '@types/react-dom': ['^19.0.0', '^19.1.0'],
    'react-test-renderer': ['19.0.0', '19.1.0'],
    typescript: ['^5.6.2'],
    webpack: ['^5.88.0'],
    'webpack-dev-server': ['^4.15.0'],
  },
};

const LEGACY_NODE_ENGINES = ['>=20.19.4 <21'];
const BROKEN_NATIVE_STYLE_IMPORT = (
  /import \* as css from '@stylexjs\/stylex';\r?\nimport \{ html \} from 'react-strict-dom';/g
);
const BROKEN_NATIVE_STYLE_FILE_HASHES = {
  'app/index.tsx': 'c98a2686fb00ea142dad9a95f7e3eaf0a3e9a834a223739c484684bc5d50a954',
  'app/profile/[id].tsx': 'dc563718506cc5a053acf5f4cc87134fcba9dd0b3bd46653e72c9eac9d62316f',
};

function updatedNativeStyleImports(content) {
  return content.replace(
    BROKEN_NATIVE_STYLE_IMPORT,
    "import { css, html } from 'react-strict-dom';"
  );
}

function migrateManagedPackageDependencies(targetPackage, conflicts) {
  for (const [section, dependencies] of Object.entries(MANAGED_PACKAGE_DEPENDENCIES)) {
    targetPackage[section] = targetPackage[section] || {};
    for (const dependency of dependencies) {
      const targetSpec = templatePackageJson[section][dependency];
      const currentSpec = targetPackage[section][dependency];
      const knownLegacySpecs = LEGACY_MANAGED_PACKAGE_SPECS[section]?.[dependency] || [];
      if (
        currentSpec === undefined
        || currentSpec === targetSpec
        || knownLegacySpecs.includes(currentSpec)
      ) {
        targetPackage[section][dependency] = targetSpec;
        continue;
      }
      conflicts.push(
        `package.json ${section}.${dependency} uses ${currentSpec}; `
        + `OnRamp will not replace the customized requirement with ${targetSpec}.`
      );
    }
  }

  targetPackage.engines = targetPackage.engines || {};
  const targetNodeEngine = templatePackageJson.engines.node;
  const currentNodeEngine = targetPackage.engines.node;
  if (
    currentNodeEngine === undefined
    || currentNodeEngine === targetNodeEngine
    || LEGACY_NODE_ENGINES.includes(currentNodeEngine)
  ) {
    targetPackage.engines.node = targetNodeEngine;
  } else {
    conflicts.push(
      `package.json engines.node uses ${currentNodeEngine}; `
      + `OnRamp will not replace the customized requirement with ${targetNodeEngine}.`
    );
  }
}

function frontendMigrationSteps(fromSchema, toSchema) {
  const steps = [];
  for (let schema = fromSchema; schema < toSchema; schema += 1) {
    const description = FRONTEND_MIGRATIONS.get(schema);
    if (!description) {
      throw new Error(`No frontend migration is registered for schema ${schema} -> ${schema + 1}.`);
    }
    steps.push({ from: schema, to: schema + 1, description });
  }
  return steps;
}

function desiredPackageSpec() {
  return process.env.ONRAMP_JS_PACKAGE_SPEC || packageJson.version;
}

function updatedFrontendGitignore(content) {
  const existing = new Set(content.split(/\r?\n/).map(line => line.trim()));
  const missing = FRONTEND_GITIGNORE_ENTRIES.filter(entry => !existing.has(entry));
  if (!missing.length) return content;
  let updated = content;
  if (updated && !updated.endsWith('\n')) updated += '\n';
  return `${updated}\n# OnRamp generated and recoverable output\n${missing.join('\n')}\n`;
}

function planFrontendUpgrade(
  outputDir,
  { nativeStyleFileHashes = BROKEN_NATIVE_STYLE_FILE_HASHES } = {},
) {
  const root = path.resolve(outputDir);
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error(`No OnRamp frontend found at ${root}`);
  }

  const manifest = readFrontendManifest(root);
  if (manifest && manifest.schemaVersion > FRONTEND_SCHEMA_VERSION) {
    throw new Error(
      `This frontend uses schema ${manifest.schemaVersion}, but onramp-js ${packageJson.version} supports schema ${FRONTEND_SCHEMA_VERSION}.`
    );
  }

  const targetContents = managedFileContents();
  const changes = [];
  const conflicts = [];
  const legacy = !manifest;

  for (const [relativePath, targetContent] of Object.entries(targetContents)) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) {
      changes.push({ relativePath, content: targetContent, reason: 'restore managed file' });
      continue;
    }

    const currentContent = fs.readFileSync(filePath, 'utf8');
    const currentHash = sha256(currentContent);
    if (currentHash === sha256(targetContent)) {
      continue;
    }

    const expectedHash = manifest?.managedFiles?.[relativePath];
    const targetHash = sha256(targetContent);
    if (!legacy && expectedHash === targetHash) {
      // The framework base is unchanged, so preserve any project customization.
      continue;
    }
    const isUnmodified = expectedHash
      ? expectedHash === currentHash
      : (LEGACY_MANAGED_HASHES[relativePath] || []).includes(currentHash);

    if (isUnmodified) {
      changes.push({ relativePath, content: targetContent, reason: 'update managed file' });
    } else {
      conflicts.push(
        `${relativePath} was modified after generation; OnRamp will not overwrite it.`
      );
    }
  }

  for (const [relativePath, brokenHash] of Object.entries(nativeStyleFileHashes)) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) continue;
    const currentContent = fs.readFileSync(filePath, 'utf8');
    if (sha256(currentContent) !== brokenHash) continue;
    const targetContent = updatedNativeStyleImports(currentContent);
    if (targetContent !== currentContent) {
      changes.push({
        relativePath,
        content: targetContent,
        reason: 'restore React Strict DOM native style resolution',
      });
    }
  }

  const gitignorePath = path.join(root, '.gitignore');
  const currentGitignore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  const targetGitignore = updatedFrontendGitignore(currentGitignore);
  if (targetGitignore !== currentGitignore) {
    changes.push({
      relativePath: '.gitignore',
      content: targetGitignore,
      reason: 'ignore generated native and route output',
    });
  }

  const currentPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const targetPackage = JSON.parse(JSON.stringify(currentPackage));
  migrateManagedPackageDependencies(targetPackage, conflicts);
  targetPackage.scripts = targetPackage.scripts || {};
  if (
    !targetPackage.scripts.typecheck
    || targetPackage.scripts.typecheck === 'tsc --noEmit'
  ) {
    targetPackage.scripts.typecheck = (
      'node scripts/build-routes.js && tsc --noEmit'
    );
  }
  if (['jest', 'jest --runInBand'].includes(targetPackage.scripts.test)) {
    targetPackage.scripts.test = (
      'node scripts/build-routes.js && jest --runInBand'
    );
  }
  targetPackage.jest = targetPackage.jest || {};
  if (
    targetPackage.jest.preset === undefined
    || targetPackage.jest.preset === 'react-native'
  ) {
    targetPackage.jest.preset = '@react-native/jest-preset';
  }
  targetPackage.jest.modulePathIgnorePatterns = (
    targetPackage.jest.modulePathIgnorePatterns || ['/.onramp/backups/']
  );
  for (const ignoredPath of ['/ios/', '/android/']) {
    if (!targetPackage.jest.modulePathIgnorePatterns.includes(ignoredPath)) {
      targetPackage.jest.modulePathIgnorePatterns.push(ignoredPath);
    }
  }
  targetPackage.jest.testPathIgnorePatterns = (
    targetPackage.jest.testPathIgnorePatterns || ['/node_modules/', '/ios/']
  );
  targetPackage.jest.transformIgnorePatterns = (
    targetPackage.jest.transformIgnorePatterns || [
      'node_modules/(?!(react-native|@react-native|react-strict-dom|@stylexjs|onramp-js)/)',
    ]
  ).map(pattern => (
    pattern.includes('onramp-js')
      ? pattern
      : pattern.replace('@stylexjs)', '@stylexjs|onramp-js)')
  ));
  if (targetPackage.jest.watchman === undefined) {
    targetPackage.jest.watchman = false;
  }
  targetPackage.devDependencies = targetPackage.devDependencies || {};
  targetPackage.devDependencies['onramp-js'] = desiredPackageSpec();
  const targetPackageContent = `${JSON.stringify(targetPackage, null, 2)}\n`;
  const currentPackageContent = fs.readFileSync(packagePath, 'utf8');
  if (currentPackageContent !== targetPackageContent) {
    changes.push({
      relativePath: 'package.json',
      content: targetPackageContent,
      reason: `set onramp-js to ${desiredPackageSpec()}`,
    });
  }

  const targetManifest = buildFrontendManifest(targetContents);
  const manifestContent = `${JSON.stringify(targetManifest, null, 2)}\n`;
  const manifestPath = path.join(root, FRONTEND_MANIFEST);
  const currentManifestContent = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8')
    : null;

  return {
    changes,
    conflicts,
    fromSchema: manifest?.schemaVersion || 0,
    migrations: frontendMigrationSteps(
      manifest?.schemaVersion || 0,
      FRONTEND_SCHEMA_VERSION
    ),
    manifestContent,
    manifestChanged: currentManifestContent !== manifestContent,
    outputDir: root,
    toSchema: FRONTEND_SCHEMA_VERSION,
  };
}

function printFrontendPlan(plan) {
  console.log(
    `Frontend schema ${plan.fromSchema} -> ${plan.toSchema} with onramp-js ${packageJson.version}`
  );
  for (const migration of plan.migrations) {
    console.log(
      `  migrate schema ${migration.from} -> ${migration.to} (${migration.description})`
    );
  }
  for (const change of plan.changes) {
    console.log(`  update ${change.relativePath} (${change.reason})`);
  }
  if (plan.manifestChanged) {
    console.log(`  update ${FRONTEND_MANIFEST} (record managed file state)`);
  }
  for (const conflict of plan.conflicts) {
    console.log(`  conflict: ${conflict}`);
  }
  if (!plan.changes.length && !plan.manifestChanged && !plan.conflicts.length) {
    console.log('  Frontend is already up to date.');
  }
}

function printFrontendCheckResult(plan) {
  if (plan.conflicts.length) {
    console.log(
      '\n✗ Upgrade check failed: blocking issues were found; the frontend upgrade will not be successful until they are resolved.'
    );
    return;
  }
  if (!plan.changes.length && !plan.manifestChanged) {
    console.log('\n✓ Upgrade check passed: the frontend is already up to date.');
    return;
  }
  console.log(
    '\n✓ Upgrade check passed: no blocking issues were found; the frontend upgrade should be successful.'
  );
}

function createBackup(outputDir, relativePaths) {
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backupDir = path.join(outputDir, '.onramp', 'backups', timestamp);
  const entries = [];

  for (const relativePath of relativePaths) {
    const source = path.join(outputDir, relativePath);
    const existed = fs.existsSync(source);
    entries.push({ relativePath, existed });
    if (existed) {
      const destination = path.join(backupDir, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }

  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(
    path.join(backupDir, 'upgrade.json'),
    `${JSON.stringify({ entries }, null, 2)}\n`,
    'utf8'
  );
  return { backupDir, entries };
}

function restoreBackup(outputDir, backup) {
  for (const entry of backup.entries) {
    const destination = path.join(outputDir, entry.relativePath);
    if (entry.existed) {
      const source = path.join(backup.backupDir, entry.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    } else {
      fs.rmSync(destination, { force: true });
    }
  }
}

function applyFrontendUpgrade(plan, runner = run) {
  if (plan.conflicts.length) {
    throw new Error('Resolve the reported frontend conflicts before upgrading.');
  }

  const shouldInstall = plan.changes.some(change => change.relativePath === 'package.json');
  const backupPaths = new Set(plan.changes.map(change => change.relativePath));
  backupPaths.add(FRONTEND_MANIFEST);
  if (shouldInstall) {
    backupPaths.add('package-lock.json');
  }
  const backup = createBackup(plan.outputDir, [...backupPaths]);

  try {
    for (const change of plan.changes) {
      atomicWrite(path.join(plan.outputDir, change.relativePath), change.content);
    }
    if (shouldInstall) {
      const pythonWrapper = isPythonWrapper();
      const args = ['install', '--legacy-peer-deps'];
      if (pythonWrapper) {
        args.push('--no-audit', '--no-fund', '--loglevel=error');
      }
      runner('npm', args, plan.outputDir, process.env, { quiet: pythonWrapper });
    }
    atomicWrite(path.join(plan.outputDir, FRONTEND_MANIFEST), plan.manifestContent);
  } catch (error) {
    restoreBackup(plan.outputDir, backup);
    throw error;
  }

  console.log(`✓ Frontend upgraded; backup saved at ${backup.backupDir}`);
  return backup.backupDir;
}

function upgradeFrontend(
  { output, check = false, quiet = false },
  runner = run
) {
  const plan = planFrontendUpgrade(output);
  if (!quiet) {
    printFrontendPlan(plan);
  }
  if (plan.conflicts.length) {
    if (check && !isPythonWrapper()) {
      printFrontendCheckResult(plan);
    }
    return false;
  }
  if (check) {
    if (!isPythonWrapper()) {
      printFrontendCheckResult(plan);
    }
    return true;
  }
  if (!plan.changes.length && !plan.manifestChanged) {
    return true;
  }
  applyFrontendUpgrade(plan, runner);
  return true;
}

module.exports = {
  applyFrontendUpgrade,
  BROKEN_NATIVE_STYLE_FILE_HASHES,
  FRONTEND_MIGRATIONS,
  frontendMigrationSteps,
  LEGACY_MANAGED_HASHES,
  MANAGED_PACKAGE_DEPENDENCIES,
  migrateManagedPackageDependencies,
  planFrontendUpgrade,
  printFrontendCheckResult,
  printFrontendPlan,
  updatedNativeStyleImports,
  updatedFrontendGitignore,
  upgradeFrontend,
};
