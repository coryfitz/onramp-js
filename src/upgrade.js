const fs = require('fs');
const path = require('path');

const packageJson = require('../package.json');
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

const LEGACY_MANAGED_HASHES = {
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
  'webpack.config.js': [
    '155bca7673ad0b4d02a92c948d99ed5bb82a634ed6d1a3d4007a0e52d948ed62',
    '9aa02f5f6458efeddc7a198ef910e41f54ce74e8d1d7e325c11b168a418ae411',
  ],
};

const FRONTEND_MIGRATIONS = new Map([
  [0, 'adopt package-owned tooling and versioned frontend metadata'],
]);

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

function planFrontendUpgrade(outputDir) {
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
    const isUnmodified = legacy
      ? (LEGACY_MANAGED_HASHES[relativePath] || []).includes(currentHash)
      : expectedHash === currentHash;

    if (isUnmodified) {
      changes.push({ relativePath, content: targetContent, reason: 'update managed file' });
    } else {
      conflicts.push(
        `${relativePath} was modified after generation; OnRamp will not overwrite it.`
      );
    }
  }

  const currentPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const targetPackage = JSON.parse(JSON.stringify(currentPackage));
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
  FRONTEND_MIGRATIONS,
  frontendMigrationSteps,
  LEGACY_MANAGED_HASHES,
  planFrontendUpgrade,
  printFrontendCheckResult,
  printFrontendPlan,
  upgradeFrontend,
};
