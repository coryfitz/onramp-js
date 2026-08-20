const fs = require('fs');
const path = require('path');

function copyDirectoryContents(sourceDirectory, outputDirectory) {
  if (!fs.existsSync(sourceDirectory)) return;

  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const outputPath = path.join(outputDirectory, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, outputPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, outputPath);
    }
  }
}

function copyStaticAssets(projectRoot, outputDirectory) {
  copyDirectoryContents(path.join(projectRoot, 'assets'), outputDirectory);
}

class OnRampStaticAssetsPlugin {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
  }

  apply(compiler) {
    compiler.hooks.afterEmit.tap('OnRampStaticAssetsPlugin', () => {
      copyStaticAssets(this.projectRoot, compiler.options.output.path);
    });
  }
}

module.exports = {
  OnRampStaticAssetsPlugin,
  copyDirectoryContents,
  copyStaticAssets,
};
