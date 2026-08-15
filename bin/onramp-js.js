#!/usr/bin/env node

const { createApp } = require('../src/create');
const packageJson = require('../package.json');

function printUsage() {
  console.log(`Usage:
  onramp-js create --name <app-name> --output <build-directory>

Commands:
  create    Create an OnRamp React Native frontend

Options:
  --help    Show this help
  --version Show the onramp-js version`);
}

function parseCreateArgs(args) {
  const options = {};

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

  if (!options.name) {
    throw new Error('Missing required option: --name');
  }
  if (!options.output) {
    throw new Error('Missing required option: --output');
  }

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

  if (command !== 'create') {
    throw new Error(`Unknown command: ${command}`);
  }

  const options = parseCreateArgs(args);
  await createApp(options);
}

main().catch(error => {
  console.error(`onramp-js: ${error.message}`);
  process.exitCode = 1;
});
