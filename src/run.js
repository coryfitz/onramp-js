const fs = require('fs');
const path = require('path');
const { doctorAndroid, runAndroid } = require('./android');
const { doctorIos, repairIos, runIos } = require('./ios');
const { findExecutable, run } = require('./process');

function nodeVersionTuple() {
  return process.versions.node
    .split('.')
    .slice(0, 3)
    .map(value => Number(value) || 0);
}

function doctorWeb() {
  const [major, minor, patch] = nodeVersionTuple();
  const minimumSatisfied = (
    major === 20
    && (minor > 19 || (minor === 19 && patch >= 4))
  );
  if (!minimumSatisfied) {
    throw new Error(
      `Node.js 20.19.4 or newer on the Node 20 line is required; found ${process.versions.node}.`
    );
  }
  if (!findExecutable('npm')) {
    throw new Error('npm was not found on PATH.');
  }
  console.log(`Using Node.js v${process.versions.node} environment`);
  console.log('✓ Web environment is ready');
}

function doctor(platform = 'all') {
  doctorWeb();
  if (platform === 'web') {
    return;
  }
  if (platform === 'ios') {
    doctorIos();
    return;
  }
  if (platform === 'android') {
    doctorAndroid();
    return;
  }
  if (platform === 'mobile' || platform === 'all') {
    doctorIos();
    doctorAndroid();
    return;
  }
  throw new Error('Doctor platform must be web, ios, android, mobile, or all.');
}

function requireFrontend(outputDir) {
  if (!fs.existsSync(path.join(outputDir, 'package.json'))) {
    throw new Error(`No OnRamp frontend found at ${outputDir}`);
  }
}

async function runFrontend({ platform, name, output }) {
  const outputDir = path.resolve(output || process.cwd());
  requireFrontend(outputDir);
  doctorWeb();

  if (platform === 'web') {
    run('npm', ['run', 'start:web'], outputDir);
    return;
  }
  if (platform === 'ios') {
    await runIos({ name, output: outputDir });
    return;
  }
  if (platform === 'android') {
    await runAndroid({ name, output: outputDir });
    return;
  }
  throw new Error('Run platform must be web, ios, or android.');
}

async function repairFrontend({ platform, name, output }) {
  doctorWeb();
  if (platform === 'ios') {
    await repairIos({ name, output });
    return;
  }
  throw new Error('Repair platform must be ios.');
}

module.exports = {
  doctor,
  doctorWeb,
  repairFrontend,
  runFrontend,
};
