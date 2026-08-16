#!/usr/bin/env node

const path = require('path');
const { createApp, npmPackageName } = require('../src/create');
const { addNativePlatforms } = require('../src/native');
const { doctor, doctorWeb, repairFrontend, runFrontend } = require('../src/run');
const packageJson = require('../package.json');

function printUsage() {
  console.log(`Usage:
  onramp-js create <app-name> [--mobile | --all]
  onramp-js create --name <app-name> --output <directory> [--mobile | --all]
  onramp-js add <ios | android | mobile> [--output <directory>]
  onramp-js doctor [web | ios | android | mobile | all]
  onramp-js run <web | ios | android> [--output <directory>]
  onramp-js repair ios [--output <directory>]

Commands:
  create    Create a web-ready universal OnRamp app
  add       Add native platform projects to an existing app
  doctor    Check the development tools for one or all platforms
  run       Prepare and run an app on the selected platform
  repair    Clean and restore platform dependencies

Options:
  --mobile  Include both iOS and Android projects
  --all     Include every supported platform
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
    throw new Error('Missing platform. Use web, ios, or android.');
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
    await repairFrontend(parseRunArgs(args));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`onramp-js: ${error.message}`);
  process.exitCode = 1;
});
