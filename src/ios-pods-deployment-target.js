const fs = require('node:fs');
const path = require('node:path');

function compareVersions(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function reactNativeMinimumIosVersion(outputDir) {
  const helpers = path.join(
    outputDir,
    'node_modules',
    'react-native',
    'scripts',
    'cocoapods',
    'helpers.rb',
  );
  let source;
  try {
    source = fs.readFileSync(helpers, 'utf8');
  } catch (error) {
    throw new Error(
      `OnRamp could not read React Native's iOS compatibility metadata at ${helpers}: ${error.message}`,
    );
  }
  const method = source.match(
    /def self\.min_ios_version_supported\b([\s\S]*?)^[ \t]*end\b/m,
  );
  const version = method && method[1].match(
    /^[ \t]*return[ \t]+['"](\d+(?:\.\d+)*)['"][ \t]*$/m,
  );
  if (!version) {
    throw new Error(
      `OnRamp could not determine React Native's minimum iOS version from ${helpers}.`,
    );
  }
  return version[1];
}

function ensureIosPodsDeploymentTarget(
  iosDir,
  outputDir = path.dirname(iosDir),
) {
  const podsDir = path.join(iosDir, 'Pods');
  let entries;
  try {
    entries = fs.readdirSync(podsDir, {withFileTypes: true});
  } catch (error) {
    throw new Error(
      `OnRamp could not inspect generated CocoaPods projects at ${podsDir}: ${error.message}`,
    );
  }
  const projects = entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    .map(entry => path.join(podsDir, entry.name, 'project.pbxproj'))
    .sort();
  if (projects.length === 0) {
    throw new Error(`OnRamp found no generated CocoaPods Xcode projects at ${podsDir}.`);
  }
  const minimum = reactNativeMinimumIosVersion(outputDir);
  const planned = projects.map(project => {
    let source;
    try {
      const stat = fs.lstatSync(project);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('not a regular file');
      }
      source = fs.readFileSync(project, 'utf8');
    } catch (error) {
      throw new Error(
        `OnRamp could not read the generated CocoaPods project at ${project}: ${error.message}`,
      );
    }
    let raised = 0;
    const updated = source.replace(
      /^([ \t]*IPHONEOS_DEPLOYMENT_TARGET[ \t]*=[ \t]*)(")?(\d+(?:\.\d+)*)\2([ \t]*;)/gm,
      (setting, prefix, quote, current, suffix) => {
        if (compareVersions(current, minimum) >= 0) return setting;
        raised += 1;
        const wrapper = quote || '';
        return `${prefix}${wrapper}${minimum}${wrapper}${suffix}`;
      },
    );
    return {project, raised, updated};
  });
  const raised = planned.reduce((total, item) => total + item.raised, 0);
  for (const item of planned) {
    if (item.raised > 0) {
      fs.writeFileSync(item.project, item.updated, 'utf8');
    }
  }
  return {minimum, raised};
}

module.exports = {
  ensureIosPodsDeploymentTarget,
  reactNativeMinimumIosVersion,
};
