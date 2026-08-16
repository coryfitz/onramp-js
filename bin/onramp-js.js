#!/usr/bin/env node

const path = require('path');
const { createApp, npmPackageName } = require('../src/create');
const { normalizePort } = require('../src/metro');
const { addNativePlatforms } = require('../src/native');
const { doctor, doctorWeb, repairFrontend, runFrontend } = require('../src/run');
const { upgradeFrontend } = require('../src/upgrade');
const packageJson = require('../package.json');

function printUsage() {
  console.log(`Usage:
  onramp-js create <app-name> [--mobile | --all]
  onramp-js create --name <app-name> --output <directory> [--mobile | --all]
  onramp-js add <ios | android | mobile> [--output <directory>]
  onramp-js doctor [web | ios | android | mobile | all]
  onramp-js run <web | ios | android | mobile> [--output <directory>] [--metro-port <port>]
  onramp-js repair ios [--output <directory>] [--fresh]
  onramp-js upgrade [--output <directory>] [--check | --dry-run]

Commands:
  create    Create a web-ready universal OnRamp app
  add       Add native platform projects to an existing app
  doctor    Check the development tools for one or all platforms
  run       Prepare and run an app on the selected platform
  repair    Clean and restore platform dependencies
  upgrade   Safely upgrade framework-owned frontend tooling

Options:
  --mobile  Include both iOS and Android projects
  --all     Include every supported platform
  --metro-port  Select a free port to use for the native Metro bundler
  --fresh   Recreate Podfile.lock during an iOS repair
  --check   Show whether a frontend upgrade can be applied safely
  --dry-run Show the frontend upgrade plan without changing files
  --help    Show this help
  --version Show the onramp-js version`);
}

function parseCreateArgs(args) {
  const options = {};
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--name' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }

    if (argument === '--mobile' || argument === '-m') {
      options.mobile = true;
      continue;
    }

    if (argument === '--all' || argument === '-a') {
      options.all = true;
      continue;
    }

    if (!argument.startsWith('-')) {
      positional.push(argument);
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  if (positional.length > 1) {
    throw new Error('Create accepts only one app name.');
  }
  if (options.name && positional.length === 1) {
    throw new Error('Provide the app name either positionally or with --name, not both.');
  }
  if (options.mobile && options.all) {
    throw new Error('Use either --mobile or --all, not both.');
  }

  options.name = options.name || positional[0];
  if (!options.name) {
    throw new Error('Missing app name.');
  }
  options.output = options.output
    ? path.resolve(options.output)
    : path.resolve(process.cwd(), npmPackageName(options.name));
  options.platform = options.all ? 'all' : options.mobile ? 'mobile' : 'web';

  return options;
}

function parseAddArgs(args) {
  const platform = args.shift();
  const options = { platform, output: process.cwd() };

  if (!platform) {
    throw new Error('Missing platform. Use ios, android, or mobile.');
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--name' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  options.output = path.resolve(options.output);
  return options;
}

function parseRunArgs(args) {
  const platform = args.shift();
  const options = { platform, output: process.cwd() };

  if (!platform) {
    throw new Error('Missing platform. Use web, ios, android, or mobile.');
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--name' || argument === '--output' || argument === '--metro-port') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      if (argument === '--metro-port') {
        options.metroPort = normalizePort(value);
      } else {
        options[argument.slice(2)] = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  options.output = path.resolve(options.output);
  return options;
}

function parseRepairArgs(args) {
  const platform = args.shift();
  const options = { platform, output: process.cwd(), fresh: false };

  if (!platform) {
    throw new Error('Missing platform. Repair currently supports ios.');
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--name' || argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument === '--fresh') {
      options.fresh = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  options.output = path.resolve(options.output);
  return options;
}

function parseUpgradeArgs(args) {
  const options = {
    output: process.cwd(),
    check: false,
    dryRun: false,
    quiet: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --output');
      }
      options.output = value;
      index += 1;
      continue;
    }
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--quiet') {
      options.quiet = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.check && options.dryRun) {
    throw new Error('Use either --check or --dry-run, not both.');
  }
  options.output = path.resolve(options.output);
  return options;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (command === '--help' || command === '-h' || command === undefined) {
    printUsage();
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(packageJson.version);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  if (command === 'create') {
    doctorWeb();
    await createApp(parseCreateArgs(args));
    return;
  }

  if (command === 'add') {
    doctorWeb();
    await addNativePlatforms(parseAddArgs(args));
    return;
  }

  if (command === 'doctor') {
    if (args.length > 1) {
      throw new Error('Doctor accepts only one platform.');
    }
    doctor(args[0] || 'all');
    return;
  }

  if (command === 'run') {
    await runFrontend(parseRunArgs(args));
    return;
  }

  if (command === 'repair') {
    await repairFrontend(parseRepairArgs(args));
    return;
  }

  if (command === 'upgrade') {
    const options = parseUpgradeArgs(args);
    if (!options.quiet) {
      doctorWeb();
    }
    if (!upgradeFrontend(options)) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`onramp-js: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseAddArgs,
  parseCreateArgs,
  parseRepairArgs,
  parseRunArgs,
  parseUpgradeArgs,
};
