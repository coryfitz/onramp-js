const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
  capture,
  isPythonWrapper,
  prependPath,
  run,
} = require('./process');

const ANDROID_REPOSITORY_URL = (
  'https://dl.google.com/android/repository/repository2-1.xml'
);
const ANDROID_ARCHIVE_BASE_URL = (
  'https://dl.google.com/android/repository/'
);
const ANDROID_INSTALL_PROGRESS_INTERVAL_MS = 250;
const ANDROID_INSTALL_PROGRESS_WIDTH = 24;

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

function androidCliPlatform(
  platform = process.platform,
  architecture = os.arch()
) {
  const platforms = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'windows',
  };
  const architectures = {
    arm64: 'arm64',
    ia32: 'x86',
    x64: 'x86_64',
  };
  const hostPlatform = platforms[platform];
  const hostArchitecture = architectures[architecture];
  return hostPlatform && hostArchitecture
    ? hostPlatform + '_' + hostArchitecture
    : null;
}

function siblingAndroidCli(sdkManager, platform = process.platform) {
  const executable = platform === 'win32' ? 'android.exe' : 'android';
  const candidate = path.join(path.dirname(sdkManager), executable);
  return fs.existsSync(candidate) ? candidate : null;
}

function androidSdkInstallInvocation(
  sdkManager,
  sdk,
  packages,
  options = {}
) {
  const platform = options.nativePlatform || androidCliPlatform(
    options.platform,
    options.architecture
  );
  const androidCli = options.androidCli === undefined
    ? siblingAndroidCli(sdkManager, options.platform)
    : options.androidCli;
  if (androidCli && platform) {
    return {
      args: [
        '--sdk=' + sdk,
        'sdk',
        'install',
        '--platform=' + platform,
        ...(options.force ? ['--force'] : []),
        ...packages.map(packagePath => packagePath.replaceAll(';', '/')),
      ],
      command: androidCli,
    };
  }
  if (options.force) {
    throw new Error(
      'The installed Android command-line tools cannot force a native '
      + 'Android Emulator reinstall. Approve installing current command-line '
      + 'tools, then retry.'
    );
  }
  return {
    args: [
      '--sdk_root=' + sdk,
      '--channel=0',
      ...packages,
    ],
    command: sdkManager,
  };
}

function androidSdkRemoveInvocation(
  sdkManager,
  sdk,
  packages,
  options = {}
) {
  const androidCli = options.androidCli === undefined
    ? siblingAndroidCli(sdkManager, options.platform)
    : options.androidCli;
  if (androidCli) {
    return {
      args: [
        '--sdk=' + sdk,
        'sdk',
        'remove',
        ...packages.map(packagePath => packagePath.replaceAll(';', '/')),
      ],
      command: androidCli,
    };
  }
  return {
    args: [
      '--sdk_root=' + sdk,
      '--uninstall',
      ...packages,
    ],
    command: sdkManager,
  };
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

function pruneOldAndroidCommandLineTools(sdk, sdkManager, options = {}) {
  const log = options.log || console.log;
  const removeDirectory = options.removeDirectory || (directory => (
    fs.rmSync(directory, { recursive: true, force: true })
  ));
  try {
    const toolsRoot = path.join(path.resolve(sdk), 'cmdline-tools');
    const retained = path.dirname(path.dirname(path.resolve(sdkManager)));
    const retainedVersion = path.basename(retained).match(
      /^onramp-(\d+(?:\.\d+)*)(?:-(?:[2-9]|[1-9]\d+))?$/
    );
    // A redirected tools root or executable may still depend on an older
    // directory. Only prune ordinary sibling installs inside this SDK.
    if (
      !retainedVersion
      || path.dirname(retained) !== toolsRoot
      || fs.realpathSync(toolsRoot) !== path.join(
        fs.realpathSync(sdk), 'cmdline-tools'
      )
      || fs.realpathSync(retained) !== path.join(
        fs.realpathSync(toolsRoot), path.basename(retained)
      )
      || fs.realpathSync(sdkManager) !== path.join(
        fs.realpathSync(retained), 'bin', path.basename(sdkManager)
      )
    ) {
      return;
    }
    for (const entry of fs.readdirSync(toolsRoot, { withFileTypes: true })) {
      const version = entry.name.match(
        /^onramp-(\d+(?:\.\d+)*)(?:-(?:[2-9]|[1-9]\d+))?$/
      );
      if (
        !entry.isDirectory()
        || !version
        || compareVersions(version[1], retainedVersion[1]) >= 0
      ) {
        continue;
      }
      const directory = path.join(toolsRoot, entry.name);
      try {
        if (fs.lstatSync(directory).isSymbolicLink()) {
          continue;
        }
        removeDirectory(directory);
        log('Removed superseded OnRamp Android command-line tools ' + entry.name + '.');
      } catch (error) {
        log('Could not remove old Android command-line tools ' + entry.name
          + ': ' + error.message + '. The current tools remain available.');
      }
    }
  } catch (error) {
    log('Could not inspect old Android command-line tools for cleanup: '
      + error.message + '. The current tools remain available.');
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
          pruneOldAndroidCommandLineTools(sdk, existing, { log });
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
    pruneOldAndroidCommandLineTools(sdk, sdkManager, { log });
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

function androidDownloadUrls(output) {
  return [...String(output).matchAll(
    /https:\/\/dl\.google\.com\/android\/repository\/[^\s]+/g
  )].map(match => (
    match[0]
      .replace(/\.{3}$/, '')
      .replace(/[),;\]]+$/, '')
  ));
}

async function androidDownloadSize(
  url,
  fetchFn = globalThis.fetch,
  signal
) {
  if (typeof fetchFn !== 'function') {
    return null;
  }
  try {
    const response = await fetchFn(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal,
    });
    if (!response.ok) {
      return null;
    }
    const size = Number(response.headers.get('content-length'));
    return Number.isFinite(size) && size > 0 ? size : null;
  } catch (_error) {
    return null;
  }
}

function androidSdkTransientSnapshot(sdk) {
  const files = new Map();
  if (!sdk) {
    return files;
  }
  const roots = [
    [path.join(sdk, '.sdk', 'arch'), 'download'],
    [path.join(sdk, '.sdk', 'unzips'), 'extract'],
  ];

  function visit(directory, stage) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(candidate, stage);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const details = fs.statSync(candidate);
        files.set(candidate, {
          modified: details.mtimeMs,
          size: details.size,
          stage,
        });
      } catch (_error) {
        // Android may move a transient file while OnRamp is inspecting it.
      }
    }
  }

  for (const [directory, stage] of roots) {
    visit(directory, stage);
  }
  return files;
}

function androidSdkInstallActivity(sdk, baseline) {
  const current = androidSdkTransientSnapshot(sdk);
  let downloadedBytes = 0;
  let extracting = false;
  for (const [filePath, details] of current) {
    const previous = baseline.get(filePath);
    const changed = (
      !previous
      || previous.size !== details.size
      || previous.modified !== details.modified
    );
    if (!changed) {
      continue;
    }
    if (details.stage === 'download') {
      downloadedBytes += details.size;
    } else if (details.stage === 'extract') {
      extracting = true;
    }
  }
  return { downloadedBytes, extracting };
}

function formatAndroidBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) {
    return (value / 1024 ** 3).toFixed(1) + ' GB';
  }
  if (value >= 1024 ** 2) {
    return (value / 1024 ** 2).toFixed(0) + ' MB';
  }
  if (value >= 1024) {
    return (value / 1024).toFixed(0) + ' KB';
  }
  return value + ' B';
}

function formatAndroidDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0
    ? minutes + 'm ' + String(remainder).padStart(2, '0') + 's'
    : seconds + 's';
}

function determinateAndroidProgressLine(downloadedBytes, totalBytes, elapsed) {
  const percentage = Math.min(
    100,
    Math.max(0, Math.floor(downloadedBytes / totalBytes * 100))
  );
  const completed = Math.round(
    percentage / 100 * ANDROID_INSTALL_PROGRESS_WIDTH
  );
  const bar = '='.repeat(completed)
    + '-'.repeat(ANDROID_INSTALL_PROGRESS_WIDTH - completed);
  return '[' + bar + '] ' + String(percentage).padStart(3, ' ') + '% '
    + formatAndroidBytes(downloadedBytes) + ' / '
    + formatAndroidBytes(totalBytes) + ' ('
    + formatAndroidDuration(elapsed) + ')';
}

function indeterminateAndroidProgressLine(tick, elapsed) {
  const markerWidth = 5;
  const travel = ANDROID_INSTALL_PROGRESS_WIDTH - markerWidth;
  const cycle = travel * 2;
  const position = tick % cycle <= travel
    ? tick % cycle
    : cycle - tick % cycle;
  const bar = '.'.repeat(position)
    + '='.repeat(markerWidth)
    + '.'.repeat(ANDROID_INSTALL_PROGRESS_WIDTH - markerWidth - position);
  return '[' + bar + '] Downloading Android SDK package ('
    + formatAndroidDuration(elapsed) + ')';
}

class AndroidSdkInstallProgress {
  constructor(sdk, options = {}) {
    this.sdk = sdk;
    this.output = options.output || process.stdout;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.downloadSizeFn = options.downloadSizeFn || androidDownloadSize;
    this.now = options.now || Date.now;
    this.baseline = androidSdkTransientSnapshot(sdk);
    this.startedAt = this.now();
    this.downloadStartedAt = this.startedAt;
    this.downloadedBytes = 0;
    this.totalBytes = null;
    this.tick = 0;
    this.pendingOutput = '';
    this.seenUrls = new Set();
    this.activeUrl = null;
    this.activeLine = false;
    this.lastNonTtyKey = null;
    this.abortController = null;
  }

  observe(output) {
    this.pendingOutput = (this.pendingOutput + String(output)).slice(-8192);
    for (const url of androidDownloadUrls(this.pendingOutput)) {
      if (this.seenUrls.has(url)) {
        continue;
      }
      this.seenUrls.add(url);
      this.beginDownload(url);
    }
  }

  beginDownload(url) {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortController = new AbortController();
    this.activeUrl = url;
    this.baseline = androidSdkTransientSnapshot(this.sdk);
    this.downloadStartedAt = this.now();
    this.downloadedBytes = 0;
    this.totalBytes = null;
    this.tick = 0;
    this.lastNonTtyKey = null;
    Promise.resolve(this.downloadSizeFn(
      url,
      this.fetchFn,
      this.abortController.signal
    )).then(size => {
      if (this.activeUrl === url && Number(size) > 0) {
        this.totalBytes = Number(size);
        this.sample();
      }
    }).catch(() => {
      // Content length is optional; retain an indeterminate progress bar.
    });
  }

  clearLine() {
    if (this.activeLine && this.output.isTTY) {
      this.output.write('\r\x1b[2K');
      this.activeLine = false;
    }
  }

  sample() {
    if (!this.activeUrl) {
      return;
    }
    const activity = androidSdkInstallActivity(this.sdk, this.baseline);
    this.downloadedBytes = Math.max(
      this.downloadedBytes,
      activity.downloadedBytes
    );
    const elapsed = this.now() - this.downloadStartedAt;
    let line;
    let key;
    if (activity.extracting) {
      const bar = '='.repeat(ANDROID_INSTALL_PROGRESS_WIDTH);
      line = '[' + bar + '] 100% Downloaded; extracting Android SDK package ('
        + formatAndroidDuration(elapsed) + ')';
      key = 'extract';
    } else if (this.totalBytes) {
      line = determinateAndroidProgressLine(
        Math.min(this.downloadedBytes, this.totalBytes),
        this.totalBytes,
        elapsed
      );
      key = 'download-' + Math.floor(
        Math.min(this.downloadedBytes, this.totalBytes)
        / this.totalBytes * 10
      );
    } else {
      line = indeterminateAndroidProgressLine(this.tick, elapsed);
      key = 'download-indeterminate-' + Math.floor(elapsed / 10000);
    }
    this.tick += 1;

    if (this.output.isTTY) {
      this.output.write('\r\x1b[2K' + line);
      this.activeLine = true;
      return;
    }
    if (key !== this.lastNonTtyKey) {
      this.output.write(line + '\n');
      this.lastNonTtyKey = key;
    }
  }

  finish(success) {
    const hadDownload = Boolean(this.activeUrl);
    this.activeUrl = null;
    if (this.abortController) {
      this.abortController.abort();
    }
    this.clearLine();
    if (success && hadDownload) {
      this.output.write('✓ Android SDK package installation complete\n');
    }
  }
}

function runAndroidSdkInstall(
  command,
  args,
  cwd,
  env = process.env,
  options = {}
) {
  const spawnFn = options.spawnFn || spawn;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let diagnosticOutput = '';
  const progress = new AndroidSdkInstallProgress(options.sdk, {
    downloadSizeFn: options.downloadSizeFn,
    fetchFn: options.fetchFn,
    now: options.now,
    output: stdout,
  });
  const child = spawnFn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const interval = setInterval(
    () => progress.sample(),
    options.intervalMs || ANDROID_INSTALL_PROGRESS_INTERVAL_MS
  );

  function forward(chunk, destination) {
    diagnosticOutput = (diagnosticOutput + String(chunk)).slice(-32768);
    progress.observe(chunk);
    progress.clearLine();
    destination.write(chunk);
    progress.sample();
  }

  if (child.stdout) {
    child.stdout.on('data', chunk => forward(chunk, stdout));
  }
  if (child.stderr) {
    child.stderr.on('data', chunk => forward(chunk, stderr));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(error, status) {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(interval);
      progress.finish(!error);
      if (error) {
        reject(error);
      } else {
        resolve({ status });
      }
    }

    child.once('error', error => finish(error));
    child.once('close', status => {
      if (status === 0) {
        const rejected = [...new Set(
          [...diagnosticOutput.matchAll(
            /(?:^|\n)((?:URL|SHA) mismatch for [^\r\n]+)/g
          )].map(match => match[1].trim())
        )];
        if (rejected.length > 0) {
          finish(new Error(
            'Android SDK package installation was rejected:\n'
            + rejected.join('\n')
          ));
          return;
        }
        finish(null, status);
        return;
      }
      const label = isPythonWrapper(env) ? 'Frontend command' : command;
      finish(new Error(label + ' exited with status ' + status));
    });
  });
}

async function installAndroidSdkPackages(
  sdkManager,
  sdk,
  env,
  packages,
  runFn = runAndroidSdkInstall,
  options = {}
) {
  const invocation = androidSdkInstallInvocation(
    sdkManager,
    sdk,
    packages,
    options
  );
  return runFn(
    invocation.command,
    invocation.args,
    undefined,
    env,
    { sdk }
  );
}

async function removeAndroidSdkPackages(
  sdkManager,
  sdk,
  env,
  packages,
  runFn = runAndroidSdkInstall,
  options = {}
) {
  const invocation = androidSdkRemoveInvocation(
    sdkManager,
    sdk,
    packages,
    options
  );
  return runFn(
    invocation.command,
    invocation.args,
    undefined,
    env,
    { sdk }
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
  androidCliPlatform,
  androidCommandCandidates,
  androidPackageNeedsUpdate,
  androidRepositoryHost,
  androidSdkInstallInvocation,
  androidSdkRemoveInvocation,
  androidSystemImageArchitecture,
  androidSystemImageDetails,
  androidDownloadUrls,
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
  pruneOldAndroidCommandLineTools,
  removeAndroidSdkPackages,
  runAndroidSdkInstall,
};
