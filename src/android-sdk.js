const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { capture, prependPath, run } = require('./process');

const ANDROID_REPOSITORY_URL = (
  'https://dl.google.com/android/repository/repository2-1.xml'
);
const ANDROID_ARCHIVE_BASE_URL = (
  'https://dl.google.com/android/repository/'
);

function parseNumericVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)*/);
  return match ? match[0].split('.').map(Number) : [];
}

function compareVersions(left, right) {
  const leftParts = Array.isArray(left) ? left : parseNumericVersion(left);
  const rightParts = Array.isArray(right) ? right : parseNumericVersion(right);
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function androidRepositoryHost(platform = process.platform) {
  if (platform === 'darwin') {
    return 'macosx';
  }
  if (platform === 'win32') {
    return 'windows';
  }
  return 'linux';
}

function xmlValue(contents, tag) {
  const match = contents.match(new RegExp(
    '<' + tag + '>([^<]+)</' + tag + '>'
  ));
  return match ? match[1].trim() : null;
}

function parseAndroidCommandLineToolsPackage(
  xml,
  platform = process.platform
) {
  const packageMatch = xml.match(
    /<remotePackage path="cmdline-tools;latest">([\s\S]*?)<\/remotePackage>/
  );
  if (!packageMatch) {
    throw new Error(
      'Google Android repository did not list current command-line tools.'
    );
  }

  const packageContents = packageMatch[1];
  const revisionContents = (
    packageContents.match(/<revision>([\s\S]*?)<\/revision>/) || []
  )[1] || '';
  const revision = [
    xmlValue(revisionContents, 'major'),
    xmlValue(revisionContents, 'minor'),
    xmlValue(revisionContents, 'micro'),
  ].filter(value => value !== null).join('.');
  const host = androidRepositoryHost(platform);
  const archiveMatches = packageContents.matchAll(
    /<archive>([\s\S]*?)<\/archive>/g
  );
  let selected = null;
  for (const match of archiveMatches) {
    const archive = match[1];
    if (xmlValue(archive, 'host-os') !== host) {
      continue;
    }
    const complete = (
      archive.match(/<complete>([\s\S]*?)<\/complete>/) || []
    )[1] || '';
    selected = {
      checksum: xmlValue(complete, 'checksum'),
      revision: revision || 'latest',
      size: Number(xmlValue(complete, 'size') || 0),
      url: new URL(
        xmlValue(complete, 'url'),
        ANDROID_ARCHIVE_BASE_URL
      ).href,
    };
    break;
  }

  if (!selected || !selected.url || !selected.checksum) {
    throw new Error(
      'Google Android repository has no command-line tools archive for '
      + host + '.'
    );
  }
  return selected;
}

async function fetchText(url, fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') {
    throw new Error('This Node.js version cannot download Android components.');
  }
  const response = await fetchFn(url);
  if (!response.ok) {
    throw new Error(
      'Could not check Android packages: HTTP ' + response.status + '.'
    );
  }
  return response.text();
}

async function downloadFile(url, destination, fetchFn = globalThis.fetch) {
  if (typeof fetchFn !== 'function') {
    throw new Error('This Node.js version cannot download Android components.');
  }
  const response = await fetchFn(url);
  if (!response.ok || !response.body) {
    throw new Error(
      'Could not download Android command-line tools: HTTP '
      + response.status + '.'
    );
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination)
  );
}

async function sha1File(filePath) {
  const hash = crypto.createHash('sha1');
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

function extractZip(archive, destination, env = process.env) {
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === 'win32') {
    run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1]',
        archive,
        destination,
      ],
      undefined,
      env
    );
    return;
  }
  run('unzip', ['-q', archive, '-d', destination], undefined, env);
}

function androidCommandCandidates(sdk, command) {
  const executable = process.platform === 'win32'
    ? command + '.bat'
    : command;
  const commandLineTools = path.join(sdk, 'cmdline-tools');
  let versions = [];
  if (fs.existsSync(commandLineTools)) {
    versions = fs.readdirSync(commandLineTools, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((left, right) => {
        if (left === 'latest') {
          return -1;
        }
        if (right === 'latest') {
          return 1;
        }
        return compareVersions(right, left);
      });
  }
  return [
    ...versions.map(version => (
      path.join(commandLineTools, version, 'bin', executable)
    )),
    path.join(sdk, 'tools', 'bin', executable),
  ].filter(candidate => fs.existsSync(candidate));
}

function findUsableSdkManager(sdk, env, captureFn = capture) {
  for (const candidate of androidCommandCandidates(sdk, 'sdkmanager')) {
    try {
      const result = captureFn(candidate, ['--version'], {
        env,
        check: false,
      });
      if (result.status === 0) {
        return candidate;
      }
    } catch (_error) {
      // Try another installed command-line tools version.
    }
  }
  return null;
}

function findAvdManager(sdk, sdkManager) {
  if (sdkManager) {
    const sibling = path.join(
      path.dirname(sdkManager),
      process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager'
    );
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  }
  return androidCommandCandidates(sdk, 'avdmanager')[0] || null;
}

function moveDirectory(source, destination) {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') {
      throw error;
    }
    fs.cpSync(source, destination, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

async function bootstrapAndroidCommandLineTools({
  sdk,
  env,
  promptYesNo,
  fetchFn = globalThis.fetch,
  captureFn = capture,
  downloadFn = downloadFile,
  extractFn = extractZip,
  log = console.log,
}) {
  const repositoryXml = await fetchText(
    ANDROID_REPOSITORY_URL,
    fetchFn
  );
  const packageInfo = parseAndroidCommandLineToolsPackage(repositoryXml);
  const megabytes = Math.ceil(packageInfo.size / 1024 / 1024);
  const approved = await promptYesNo(
    'Android SDK command-line tools are missing or unusable. Download '
    + 'version ' + packageInfo.revision + ' (' + megabytes + ' MB) from '
    + 'Google and install it in ' + sdk + '? (y/N): '
  );
  if (!approved) {
    return null;
  }

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onramp-android-tools-')
  );
  try {
    const archive = path.join(temporary, 'command-line-tools.zip');
    const extracted = path.join(temporary, 'extracted');
    log(
      'Downloading Android SDK command-line tools '
      + packageInfo.revision + '...'
    );
    await downloadFn(packageInfo.url, archive, fetchFn);
    const checksum = await sha1File(archive);
    if (checksum !== packageInfo.checksum.toLowerCase()) {
      throw new Error(
        'Android command-line tools download failed checksum verification.'
      );
    }
    extractFn(archive, extracted, env);
    const source = path.join(extracted, 'cmdline-tools');
    if (!fs.existsSync(path.join(source, 'bin'))) {
      throw new Error(
        'Android command-line tools archive had an unexpected layout.'
      );
    }

    const baseName = 'onramp-' + packageInfo.revision;
    const toolsRoot = path.join(sdk, 'cmdline-tools');
    fs.mkdirSync(toolsRoot, { recursive: true });
    let destination = path.join(toolsRoot, baseName);
    let suffix = 2;
    while (fs.existsSync(destination)) {
      const existing = path.join(
        destination,
        'bin',
        process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'
      );
      if (fs.existsSync(existing)) {
        const result = captureFn(existing, ['--version'], {
          env,
          check: false,
        });
        if (result.status === 0) {
          prependPath(env, path.dirname(existing));
          return existing;
        }
      }
      destination = path.join(toolsRoot, baseName + '-' + suffix);
      suffix += 1;
    }
    moveDirectory(source, destination);
    const sdkManager = path.join(
      destination,
      'bin',
      process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager'
    );
    prependPath(env, path.dirname(sdkManager));
    const validation = captureFn(sdkManager, ['--version'], {
      env,
      check: false,
    });
    if (validation.status !== 0) {
      throw new Error(
        'Downloaded Android command-line tools could not be started.'
      );
    }
    log('✓ Android SDK command-line tools installed');
    return sdkManager;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function parseAndroidSdkPackages(output) {
  const packages = new Map();
  let section = null;
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^Installed packages:$/i.test(line)) {
      section = 'installed';
      continue;
    }
    if (/^Available packages:$/i.test(line)) {
      section = 'available';
      continue;
    }
    if (/^Available updates:$/i.test(line)) {
      section = 'updates';
      continue;
    }
    if (!section || /^[-\s|]+$/.test(line)) {
      continue;
    }

    let packagePath;
    let installedVersion;
    let availableVersion;
    let description;
    let installPath;
    if (line.includes('|')) {
      const fields = line.split('|').map(value => value.trim());
      packagePath = fields[0];
      if (section === 'installed') {
        installedVersion = fields[1] || null;
        description = fields[2] || null;
      } else if (section === 'available') {
        availableVersion = fields[1] || null;
        description = fields[2] || null;
      } else {
        installedVersion = fields[1] || null;
        availableVersion = fields[2] || null;
      }
    } else {
      const fields = rawLine.match(
        /^\s{2}(\S+)\s{2,}(\S+)(?:\s+->\s+(\S+))?\s{2,}(.+?)\s*$/
      );
      if (!fields) {
        continue;
      }
      installPath = fields[1];
      packagePath = installPath.startsWith('system-images/')
        ? installPath.replaceAll('/', ';')
        : installPath;
      description = fields[4] || null;
      if (section === 'installed') {
        installedVersion = fields[2] || null;
        availableVersion = fields[3] || null;
      } else {
        availableVersion = fields[2] || null;
      }
    }
    if (!packagePath || packagePath === 'Path' || packagePath === 'ID') {
      continue;
    }
    const current = packages.get(packagePath) || { path: packagePath };
    if (installedVersion) {
      current.installedVersion = installedVersion;
    }
    if (availableVersion) {
      current.availableVersion = availableVersion;
    }
    if (description) {
      current.description = description;
    }
    if (installPath && installPath !== packagePath) {
      current.installPath = installPath;
    }
    packages.set(packagePath, current);
  }
  return packages;
}

function listAndroidSdkPackages(
  sdkManager,
  sdk,
  env,
  captureFn = capture
) {
  const result = captureFn(
    sdkManager,
    ['--sdk_root=' + sdk, '--list', '--channel=0'],
    { env, check: false }
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      'Could not check current Android SDK packages'
      + (detail ? ': ' + detail : '.')
    );
  }
  return parseAndroidSdkPackages(result.stdout);
}

function androidPackageNeedsUpdate(packageInfo) {
  return Boolean(
    packageInfo
    && packageInfo.installedVersion
    && packageInfo.availableVersion
    && compareVersions(
      packageInfo.availableVersion,
      packageInfo.installedVersion
    ) > 0
  );
}

function installAndroidSdkPackages(
  sdkManager,
  sdk,
  env,
  packages,
  runFn = run
) {
  runFn(
    sdkManager,
    [
      '--sdk_root=' + sdk,
      '--channel=0',
      ...packages,
    ],
    undefined,
    env
  );
}

function androidSystemImageDetails(packageInfo) {
  const match = packageInfo.path.match(
    /^system-images;android-(\d+(?:\.\d+)?)(?:-ext(\d+))?;([^;]+);([^;]+)$/
  );
  if (!match) {
    return null;
  }
  return {
    api: parseNumericVersion(match[1]),
    architecture: match[4],
    extension: Number(match[2] || 0),
    packageInfo,
    tag: match[3],
  };
}

function androidSystemImageArchitecture(architecture = os.arch()) {
  return architecture === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

function systemImageTagRank(tag) {
  if (tag === 'google_apis') {
    return 5;
  }
  if (tag === 'google_apis_ps16k') {
    return 4;
  }
  if (tag === 'google_apis_playstore') {
    return 3;
  }
  if (tag === 'google_apis_playstore_ps16k') {
    return 2;
  }
  if (tag.startsWith('google_apis')) {
    return 1;
  }
  return 0;
}

function preferredAndroidSystemImage(
  packages,
  architecture = androidSystemImageArchitecture()
) {
  return [...packages.values()]
    .map(androidSystemImageDetails)
    .filter(details => (
      details
      && details.architecture === architecture
      && systemImageTagRank(details.tag) > 0
      && (
        details.packageInfo.installedVersion
        || details.packageInfo.availableVersion
      )
    ))
    .sort((left, right) => (
      compareVersions(right.api, left.api)
      || right.extension - left.extension
      || systemImageTagRank(right.tag) - systemImageTagRank(left.tag)
      || compareVersions(
        right.packageInfo.availableVersion
          || right.packageInfo.installedVersion,
        left.packageInfo.availableVersion
          || left.packageInfo.installedVersion
      )
    ))[0] || null;
}

module.exports = {
  ANDROID_REPOSITORY_URL,
  androidCommandCandidates,
  androidPackageNeedsUpdate,
  androidRepositoryHost,
  androidSystemImageArchitecture,
  androidSystemImageDetails,
  bootstrapAndroidCommandLineTools,
  compareVersions,
  downloadFile,
  findAvdManager,
  findUsableSdkManager,
  installAndroidSdkPackages,
  listAndroidSdkPackages,
  parseAndroidCommandLineToolsPackage,
  parseAndroidSdkPackages,
  parseNumericVersion,
  preferredAndroidSystemImage,
};
