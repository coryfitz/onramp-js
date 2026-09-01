const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  androidCommandCandidates,
  androidPackageNeedsUpdate,
  androidSystemImageDetails,
  bootstrapAndroidCommandLineTools,
  compareVersions,
  findAvdManager,
  findUsableSdkManager,
  installAndroidSdkPackages,
  listAndroidSdkPackages,
  preferredAndroidSystemImage,
  removeAndroidSdkPackages,
} = require('./android-sdk');
const { addNativePlatforms } = require('./native');
const {
  cachedNativeBuild,
  nativeBuildFingerprint,
  recordNativeBuild,
} = require('./native-build-cache');
const { startMetro, warmMetroBundle } = require('./metro');
const {
  capture,
  findExecutable,
  prependPath,
  runAsync,
} = require('./process');
const { promptYesNo } = require('./prompt');

const MIN_CLIPBOARD_EMULATOR_VERSION = [33, 1, 23];
const EMULATOR_BOOT_TIMEOUT_MS = 180000;
const EMULATOR_BOOT_POLL_MS = 1000;
const MIN_SHARP_AVD_DENSITY = 280;
const MIN_SHARP_AVD_SHORT_SIDE = 720;
const MACOS_ANDROID_EMULATOR_ACTIVATION_SCRIPT = `
on run argv
  set emulatorPid to item 1 of argv as integer
  tell application "System Events"
    set emulatorProcesses to every process whose unix id is emulatorPid
    if (count of emulatorProcesses) is 0 then return "not-found"
    set emulatorProcess to item 1 of emulatorProcesses
    set visible of emulatorProcess to true
    set frontmost of emulatorProcess to true
    repeat with emulatorWindow in windows of emulatorProcess
      try
        set value of attribute "AXMinimized" of emulatorWindow to false
      end try
      try
        perform action "AXRaise" of emulatorWindow
      end try
    end repeat
    delay 0.1
    if frontmost of emulatorProcess then return "activated"
    return "refused"
  end tell
end run
`.trim();
const WINDOWS_ANDROID_EMULATOR_PID_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetPort = __TARGET_PORT__
try {
  $ownerProcessIds = @(
    Get-NetTCPConnection -State Listen -LocalPort $targetPort -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique |
      Where-Object { [long]$_ -gt 0 }
  )
  if ($ownerProcessIds.Count -eq 1) {
    Write-Output ('p{0}' -f $ownerProcessIds[0])
    exit 0
  }
} catch {
}
exit 1
`.trim();
const WINDOWS_ANDROID_EMULATOR_ACTIVATION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetProcessId = __TARGET_PROCESS_ID__
$targetPort = __TARGET_PORT__
try {
  $windowApiSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OnRampWindowActivation {
  private const uint GW_OWNER = 4;
  private const int SW_RESTORE = 9;
  private const uint FLASHW_TRAY = 2;
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

  [StructLayout(LayoutKind.Sequential)]
  private struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")]
  private static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(
    IntPtr window,
    StringBuilder title,
    int maximumLength
  );
  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")]
  private static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  private static extern bool FlashWindowEx(ref FLASHWINFO info);

  private static bool TitleMatchesPort(string title, uint targetPort) {
    string marker = ":" + targetPort.ToString();
    int markerIndex = title.IndexOf(marker, StringComparison.Ordinal);
    if (markerIndex >= 0) {
      int afterMarker = markerIndex + marker.Length;
      if (afterMarker == title.Length || !Char.IsDigit(title[afterMarker])) {
        return true;
      }
    }
    return title.Contains("(" + targetPort.ToString() + ")");
  }

  public static IntPtr FindMainWindow(uint targetProcessId, uint targetPort) {
    IntPtr exact = IntPtr.Zero;
    IntPtr soleSuitable = IntPtr.Zero;
    IntPtr soleTopLevel = IntPtr.Zero;
    int suitableCount = 0;
    int topLevelCount = 0;
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      uint ownerProcessId;
      GetWindowThreadProcessId(window, out ownerProcessId);
      if (ownerProcessId != targetProcessId || GetWindow(window, GW_OWNER) != IntPtr.Zero) {
        return true;
      }
      topLevelCount += 1;
      soleTopLevel = window;
      int titleLength = GetWindowTextLength(window);
      if (IsWindowVisible(window) && titleLength > 0) {
        suitableCount += 1;
        soleSuitable = window;
        StringBuilder title = new StringBuilder(titleLength + 1);
        GetWindowText(window, title, title.Capacity);
        if (TitleMatchesPort(title.ToString(), targetPort)) {
          exact = window;
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    if (exact != IntPtr.Zero) {
      return exact;
    }
    if (suitableCount == 1) {
      return soleSuitable;
    }
    return topLevelCount == 1 ? soleTopLevel : IntPtr.Zero;
  }

  public static int Activate(uint targetProcessId, uint targetPort) {
    IntPtr window = FindMainWindow(targetProcessId, targetPort);
    if (window == IntPtr.Zero) {
      return 0;
    }
    if (IsIconic(window)) {
      ShowWindowAsync(window, SW_RESTORE);
    }
    BringWindowToTop(window);
    SetForegroundWindow(window);
    System.Threading.Thread.Sleep(150);
    if (GetForegroundWindow() == window) {
      return 1;
    }
    FLASHWINFO info = new FLASHWINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    info.hwnd = window;
    info.dwFlags = FLASHW_TRAY;
    info.uCount = 3;
    info.dwTimeout = 0;
    FlashWindowEx(ref info);
    return 2;
  }
}
'@
  $null = Add-Type -TypeDefinition $windowApiSource -ErrorAction Stop
  $activationResult = [OnRampWindowActivation]::Activate(
    [uint32]$targetProcessId,
    [uint32]$targetPort
  )
  switch ($activationResult) {
    0 { Write-Output 'not-found' }
    1 { Write-Output 'activated' }
    2 { Write-Output 'refused-taskbar-requested' }
    default { Write-Output 'refused' }
  }
} catch {
  Write-Output 'error'
}
`.trim();

function parseEmulatorVersion(output) {
  const match = `${output}`.match(
    /Android emulator version\s+(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/i
  );
  return match ? match.slice(1).map(value => Number(value || 0)) : null;
}

function androidHostExecutableArchitecture(architecture = os.arch()) {
  if (architecture === 'arm64') {
    return 'arm64';
  }
  if (architecture === 'x64') {
    return 'x86_64';
  }
  if (architecture === 'ia32') {
    return 'i386';
  }
  return null;
}

function parseMachOArchitectures(output) {
  return [...new Set(
    String(output).match(/\b(?:arm64|x86_64|i386)\b/g) || []
  )];
}

function androidEmulatorArchitectureMismatch(
  emulator,
  env,
  options = {}
) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin') {
    return null;
  }
  const expected = androidHostExecutableArchitecture(
    options.architecture || os.arch()
  );
  if (!expected) {
    return null;
  }
  const lipo = options.lipo || '/usr/bin/lipo';
  const pathExists = options.pathExists || fs.existsSync;
  if (!pathExists(lipo)) {
    return null;
  }
  const captureFn = options.captureFn || capture;
  const result = captureFn(lipo, ['-archs', emulator], {
    env,
    check: false,
  });
  if (result.status !== 0) {
    return null;
  }
  const installed = parseMachOArchitectures(
    `${result.stdout}\n${result.stderr}`
  );
  if (installed.length === 0 || installed.includes(expected)) {
    return null;
  }
  return { expected, installed };
}

function requireClipboardCapableEmulator(emulator, env, captureFn = capture) {
  const result = captureFn(emulator, ['-version'], { env });
  const version = parseEmulatorVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) {
    throw new Error('Could not determine the installed Android Emulator version.');
  }

  if (compareVersions(version, MIN_CLIPBOARD_EMULATOR_VERSION) < 0) {
    throw new Error(
      'Android Emulator 33.1.23 or newer is required for reliable host '
      + `clipboard sharing; found ${version.join('.')}. Run the Android app `
      + 'with OnRamp and approve the offered Emulator upgrade.'
    );
  }
  return version;
}

function enableHostClipboardSharing(env, options = {}) {
  const platform = options.platform || process.platform;
  const captureFn = options.captureFn || capture;
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const pathExists = options.pathExists || fs.existsSync;
  if (platform !== 'darwin') {
    return false;
  }

  const defaults = findExecutableFn('defaults', env) || '/usr/bin/defaults';
  if (!pathExists(defaults)) {
    throw new Error('macOS defaults command not found; cannot enable emulator clipboard sharing.');
  }
  captureFn(
    defaults,
    ['write', 'com.android.Emulator', 'set.clipboardSharing', '-bool', 'true'],
    { env }
  );
  return true;
}

function parseIni(contents) {
  const values = new Map();
  for (const line of `${contents}`.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function androidAvdDisplay(config) {
  const numberValue = key => {
    const value = Number(config.get(key));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const width = numberValue('hw.lcd.width');
  const height = numberValue('hw.lcd.height');
  const density = numberValue('hw.lcd.density');
  const sharp = (
    width !== null
    && height !== null
    && density !== null
    && Math.min(width, height) >= MIN_SHARP_AVD_SHORT_SIDE
    && density >= MIN_SHARP_AVD_DENSITY
  );
  return { density, height, sharp, width };
}

function parseAndroidDeviceProfiles(output) {
  const profiles = [];
  for (const match of String(output).matchAll(
    /^\s*id:\s+\d+\s+or\s+"([^"]+)"/gm
  )) {
    profiles.push(match[1]);
  }
  return profiles;
}

function preferredAndroidPhoneProfile(profiles) {
  const available = new Set(profiles);
  const regularPixels = profiles
    .map(profile => {
      const match = profile.match(/^pixel_(\d+)$/);
      return match ? { profile, version: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.version - left.version);
  if (regularPixels.length > 0) {
    return regularPixels[0].profile;
  }
  for (const fallback of [
    'medium_phone',
    'pixel',
    'pixel_6',
    'pixel_5',
    'Nexus 6P',
    'Nexus 6',
  ]) {
    if (available.has(fallback)) {
      return fallback;
    }
  }
  return null;
}

function androidAvdHome(env) {
  if (env.ANDROID_AVD_HOME) {
    return path.resolve(env.ANDROID_AVD_HOME);
  }
  if (env.ANDROID_USER_HOME) {
    return path.join(path.resolve(env.ANDROID_USER_HOME), 'avd');
  }
  if (env.ANDROID_SDK_HOME) {
    return path.join(path.resolve(env.ANDROID_SDK_HOME), '.android', 'avd');
  }
  return path.join(os.homedir(), '.android', 'avd');
}

function androidAvdMetadata(avd, sdk, env) {
  const avdHome = androidAvdHome(env);
  const locatorPath = path.join(avdHome, `${avd}.ini`);
  if (!fs.existsSync(locatorPath)) {
    return { avd, valid: false };
  }

  const locator = parseIni(fs.readFileSync(locatorPath, 'utf8'));
  const configuredPath = locator.get('path');
  const relativePath = locator.get('path.rel');
  const directory = configuredPath
    ? path.resolve(configuredPath)
    : relativePath
      ? path.resolve(path.dirname(avdHome), relativePath)
      : path.join(avdHome, `${avd}.avd`);
  const configPath = path.join(directory, 'config.ini');
  if (!fs.existsSync(configPath)) {
    return { avd, directory, valid: false };
  }

  const config = parseIni(fs.readFileSync(configPath, 'utf8'));
  const display = androidAvdDisplay(config);
  const configuredImage = config.get('image.sysdir.1');
  if (!configuredImage) {
    return { avd, directory, valid: false };
  }
  const image = path.isAbsolute(configuredImage)
    ? configuredImage
    : path.resolve(sdk, configuredImage);
  const normalizedImage = image.split(path.sep).join('/');
  const stable = /\/system-images\/android-\d+(?:\.\d+)?(?:-ext\d+)?\//.test(
    normalizedImage
  );
  const imageMatch = normalizedImage.match(
    /\/system-images\/(android-[^/]+)\/([^/]+)\/([^/]+)\/?$/
  );
  return {
    avd,
    directory,
    display,
    image,
    packagePath: imageMatch
      ? ['system-images', ...imageMatch.slice(1)].join(';')
      : null,
    stable,
    valid: fs.existsSync(image),
  };
}

function selectAndroidAvd(avds, sdk, env, metadataFn = androidAvdMetadata) {
  const metadata = avds.map(avd => metadataFn(avd, sdk, env));
  const stable = metadata
    .filter(candidate => candidate.valid && candidate.stable)
    .sort((left, right) => {
      const leftDetails = left.packagePath
        ? androidSystemImageDetails({ path: left.packagePath })
        : null;
      const rightDetails = right.packagePath
        ? androidSystemImageDetails({ path: right.packagePath })
        : null;
      const apiComparison = compareVersions(
        rightDetails ? rightDetails.api : [],
        leftDetails ? leftDetails.api : []
      );
      if (apiComparison !== 0) {
        return apiComparison;
      }
      return Number(Boolean(right.display && right.display.sharp))
        - Number(Boolean(left.display && left.display.sharp));
    });
  if (stable.length > 0) {
    return stable[0].avd;
  }

  if (metadata.some(candidate => candidate.valid)) {
    throw new Error(
      'No stable Android virtual device is installed. OnRamp found only '
      + 'preview or codename system images, which do not provide reliable host '
      + 'clipboard behavior. Run the Android app with OnRamp and approve the '
      + 'offered stable system image and AVD installation.'
    );
  }
  throw new Error(
    'No usable Android virtual device is installed. Remove broken AVD entries '
    + 'or run the Android app with OnRamp and approve the offered AVD '
    + 'installation.'
  );
}

function connectedAndroidEmulators(adb, env, captureFn = capture) {
  const result = captureFn(adb, ['devices'], { env });
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => (
      fields.length >= 2
      && fields[0].startsWith('emulator-')
      && fields[1] === 'device'
    ))
    .map(fields => fields[0]);
}

function androidEmulatorAvdName(adb, serial, env, captureFn = capture) {
  const result = captureFn(
    adb,
    ['-s', serial, 'emu', 'avd', 'name'],
    { env, check: false }
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && line !== 'OK') || null;
}

function runningAndroidAvdSerial(environment, captureFn = capture) {
  for (const serial of connectedAndroidEmulators(
    environment.adb,
    environment.env,
    captureFn
  )) {
    if (
      androidEmulatorAvdName(
        environment.adb,
        serial,
        environment.env,
        captureFn
      ) === environment.avd
    ) {
      return serial;
    }
  }
  return null;
}

function androidEmulatorLaunchArgs(avd) {
  return [`@${avd}`, '-no-snapshot-load', '-no-boot-anim'];
}

function androidEmulatorConsolePort(serial) {
  const match = String(serial || '').match(/^emulator-(\d+)$/);
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function uniqueProcessId(processIds) {
  const unique = [...new Set(
    processIds.filter(processId => (
      Number.isInteger(processId) && processId > 0
    ))
  )];
  return unique.length === 1 ? unique[0] : null;
}

function lsofListeningProcessId(port, env, options = {}) {
  const platform = options.platform || process.platform;
  const captureFn = options.captureFn || capture;
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const pathExists = options.pathExists || fs.existsSync;
  const systemLsof = platform === 'darwin' ? '/usr/sbin/lsof' : null;
  const lsof = systemLsof && pathExists(systemLsof)
    ? systemLsof
    : findExecutableFn('lsof', env);
  if (!lsof) {
    return null;
  }
  const result = captureFn(
    lsof,
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
    { env, check: false }
  );
  if (result.status !== 0) {
    return null;
  }
  return uniqueProcessId(
    result.stdout
      .split(/\r?\n/)
      .map(line => line.match(/^p([1-9]\d*)$/))
      .filter(Boolean)
      .map(pidMatch => Number(pidMatch[1]))
  );
}

function windowsPowerShellExecutable(env, options = {}) {
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const pathExists = options.pathExists || fs.existsSync;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT;
  if (systemRoot) {
    const bundled = path.win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    if (pathExists(bundled)) {
      return bundled;
    }
  }
  for (const command of ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh']) {
    const executable = findExecutableFn(command, env);
    if (executable) {
      return executable;
    }
  }
  return null;
}

function windowsPowerShellArguments(script) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ];
}

function windowsListeningProcessId(port, env, options = {}) {
  const powershell = windowsPowerShellExecutable(env, options);
  if (!powershell) {
    return null;
  }
  const captureFn = options.captureFn || capture;
  const script = WINDOWS_ANDROID_EMULATOR_PID_SCRIPT.replace(
    '__TARGET_PORT__',
    String(port)
  );
  const result = captureFn(
    powershell,
    windowsPowerShellArguments(script),
    { env, check: false }
  );
  if (result.status !== 0) {
    return null;
  }
  return uniqueProcessId(
    result.stdout
      .split(/\r?\n/)
      .map(line => line.trim().match(/^p([1-9]\d*)$/))
      .filter(Boolean)
      .map(pidMatch => Number(pidMatch[1]))
  );
}

function linuxListeningSocketInodes(contents, port) {
  const inodes = [];
  for (const line of String(contents).split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== '0A') {
      continue;
    }
    const address = fields[1].match(/:([0-9A-Fa-f]{4})$/);
    if (
      address
      && Number.parseInt(address[1], 16) === port
      && /^\d+$/.test(fields[9])
    ) {
      inodes.push(fields[9]);
    }
  }
  return [...new Set(inodes)];
}

function linuxProcListeningProcessId(port, options = {}) {
  const procRoot = options.procRoot === undefined ? '/proc' : options.procRoot;
  if (!procRoot) {
    return null;
  }
  const readFileFn = options.readFileFn || fs.readFileSync;
  const readDirectoryFn = options.readDirectoryFn || fs.readdirSync;
  const readLinkFn = options.readLinkFn || fs.readlinkSync;
  const inodes = new Set();
  for (const networkFile of ['tcp', 'tcp6']) {
    try {
      for (const inode of linuxListeningSocketInodes(
        readFileFn(path.posix.join(procRoot, 'net', networkFile), 'utf8'),
        port
      )) {
        inodes.add(inode);
      }
    } catch (_error) {
      // A minimal or restricted /proc can omit one or both socket tables.
    }
  }
  if (inodes.size === 0) {
    return null;
  }

  const processIds = [];
  let entries;
  try {
    entries = readDirectoryFn(procRoot);
  } catch (_error) {
    return null;
  }
  for (const entry of entries) {
    if (!/^[1-9]\d*$/.test(entry)) {
      continue;
    }
    let descriptors;
    try {
      descriptors = readDirectoryFn(path.posix.join(procRoot, entry, 'fd'));
    } catch (_error) {
      continue;
    }
    for (const descriptor of descriptors) {
      try {
        const target = readLinkFn(
          path.posix.join(procRoot, entry, 'fd', descriptor)
        );
        const socket = String(target).match(/^socket:\[(\d+)\]$/);
        if (socket && inodes.has(socket[1])) {
          processIds.push(Number(entry));
          break;
        }
      } catch (_error) {
        // Processes can exit, close descriptors, or deny access during the scan.
      }
    }
  }
  return uniqueProcessId(processIds);
}

function linuxSsListeningProcessId(port, env, options = {}) {
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const ss = findExecutableFn('ss', env);
  if (!ss) {
    return null;
  }
  const captureFn = options.captureFn || capture;
  const result = captureFn(ss, ['-H', '-ltnp'], { env, check: false });
  if (result.status !== 0) {
    return null;
  }
  const processIds = [];
  const endpoint = new RegExp(`:${port}(?:\\s|$)`);
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!endpoint.test(line)) {
      continue;
    }
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      processIds.push(Number(match[1]));
    }
  }
  return uniqueProcessId(processIds);
}

function androidEmulatorHostProcessId(serial, env, options = {}) {
  const platform = options.platform || process.platform;
  const port = androidEmulatorConsolePort(serial);
  if (!port) {
    return null;
  }

  try {
    if (platform === 'darwin') {
      return lsofListeningProcessId(port, env, options);
    }
    if (platform === 'win32') {
      return windowsListeningProcessId(port, env, options);
    }
    if (platform === 'linux') {
      for (const resolveProcessId of [
        () => lsofListeningProcessId(port, env, options),
        () => linuxSsListeningProcessId(port, env, options),
        () => linuxProcListeningProcessId(port, options),
      ]) {
        try {
          const processId = resolveProcessId();
          if (processId) {
            return processId;
          }
        } catch (_error) {
          // Continue through independent Linux socket-discovery strategies.
        }
      }
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function androidActivationResult({
  method = null,
  platform,
  reason = null,
  serial = null,
  status,
}) {
  return { method, platform, reason, serial, status };
}

function activateMacAndroidEmulator(
  environment,
  processId,
  serial,
  options = {}
) {
  const captureFn = options.captureFn || capture;
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const pathExists = options.pathExists || fs.existsSync;
  const osascript = pathExists('/usr/bin/osascript')
    ? '/usr/bin/osascript'
    : findExecutableFn('osascript', environment.env);
  if (!osascript) {
    return androidActivationResult({
      platform: 'darwin', reason: 'activation-tool-missing', serial,
      status: 'unavailable',
    });
  }
  const result = captureFn(
    osascript,
    ['-e', MACOS_ANDROID_EMULATOR_ACTIVATION_SCRIPT, String(processId)],
    { env: environment.env, check: false }
  );
  const output = result.stdout.trim();
  if (result.status === 0 && output === 'activated') {
    return androidActivationResult({
      method: 'system-events', platform: 'darwin', serial, status: 'activated',
    });
  }
  if (result.status !== 0 || !['not-found', 'refused'].includes(output)) {
    return androidActivationResult({
      method: 'system-events',
      platform: 'darwin',
      reason: 'activation-error',
      serial,
      status: 'unavailable',
    });
  }
  return androidActivationResult({
    method: 'system-events',
    platform: 'darwin',
    reason: output === 'not-found' ? 'window-not-found' : 'activation-refused',
    serial,
    status: output === 'not-found' ? 'unavailable' : 'refused',
  });
}

function activateWindowsAndroidEmulator(
  environment,
  processId,
  serial,
  options = {}
) {
  const powershell = windowsPowerShellExecutable(environment.env, options);
  if (!powershell) {
    return androidActivationResult({
      platform: 'win32', reason: 'activation-tool-missing', serial,
      status: 'unavailable',
    });
  }
  const script = WINDOWS_ANDROID_EMULATOR_ACTIVATION_SCRIPT.replace(
    '__TARGET_PROCESS_ID__',
    String(processId)
  ).replace('__TARGET_PORT__', String(androidEmulatorConsolePort(serial)));
  const captureFn = options.captureFn || capture;
  const result = captureFn(
    powershell,
    windowsPowerShellArguments(script),
    { env: environment.env, check: false }
  );
  const output = result.stdout.trim();
  if (result.status === 0 && output === 'activated') {
    return androidActivationResult({
      method: 'win32', platform: 'win32', serial, status: 'activated',
    });
  }
  if (result.status !== 0 || output === 'error' || ![
    'not-found',
    'refused',
    'refused-taskbar-requested',
  ].includes(output)) {
    return androidActivationResult({
      method: 'win32',
      platform: 'win32',
      reason: 'activation-error',
      serial,
      status: 'unavailable',
    });
  }
  return androidActivationResult({
    method: 'win32',
    platform: 'win32',
    reason: output === 'not-found'
      ? 'window-not-found'
      : output === 'refused-taskbar-requested'
        ? 'activation-refused-taskbar-requested'
        : 'activation-refused',
    serial,
    status: output === 'not-found' ? 'unavailable' : 'refused',
  });
}

function linuxWmctrlWindows(output, processId) {
  const windows = [];
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(
      /^(0x[0-9A-Fa-f]+)\s+\S+\s+(\d+)\s+\S+(?:\s+(.*))?$/
    );
    if (match && Number(match[2]) === processId) {
      windows.push({ id: match[1], title: (match[3] || '').trim() });
    }
  }
  return windows;
}

function selectLinuxAndroidWindow(windows, avd, port) {
  if (windows.length === 1) {
    return { reason: null, window: windows[0] };
  }
  const expectedPort = `:${port}`;
  const exact = windows.filter(window => (
    window.title.includes(avd) && window.title.includes(expectedPort)
  ));
  if (exact.length === 1) {
    return { reason: null, window: exact[0] };
  }
  return {
    reason: windows.length === 0 ? 'window-not-found' : 'ambiguous-window',
    window: null,
  };
}

function normalizeLinuxWindowId(value) {
  const candidate = String(value || '').trim();
  if (!/^(?:0x[0-9A-Fa-f]+|\d+)$/.test(candidate)) {
    return null;
  }
  try {
    return BigInt(candidate).toString();
  } catch (_error) {
    return null;
  }
}

function linuxActiveWindowId(env, options = {}) {
  const captureFn = options.captureFn || capture;
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const xdotool = findExecutableFn('xdotool', env);
  if (xdotool) {
    try {
      const result = captureFn(
        xdotool,
        ['getactivewindow'],
        { env, check: false }
      );
      if (result.status === 0) {
        const active = normalizeLinuxWindowId(
          result.stdout.split(/\r?\n/)[0]
        );
        if (active) {
          return active;
        }
      }
    } catch (_error) {
      // Try another verifier if the executable disappeared or cannot run.
    }
  }

  const xprop = findExecutableFn('xprop', env);
  if (xprop) {
    try {
      const result = captureFn(
        xprop,
        ['-root', '_NET_ACTIVE_WINDOW'],
        { env, check: false }
      );
      if (result.status === 0) {
        const match = result.stdout.match(
          /window id #\s*(0x[0-9A-Fa-f]+)/i
        );
        const active = match ? normalizeLinuxWindowId(match[1]) : null;
        if (active) {
          return active;
        }
      }
    } catch (_error) {
      // The activation request remains valid even without verification.
    }
  }
  return null;
}

function linuxRequestedActivationResult(
  environment,
  selectedWindow,
  method,
  serial,
  options = {}
) {
  const activeWindow = linuxActiveWindowId(environment.env, options);
  const selectedId = normalizeLinuxWindowId(selectedWindow.id);
  if (activeWindow && selectedId && activeWindow === selectedId) {
    return androidActivationResult({
      method, platform: 'linux', serial, status: 'activated',
    });
  }
  return androidActivationResult({
    method,
    platform: 'linux',
    reason: 'window-manager-controls-focus',
    serial,
    status: 'requested',
  });
}

function swayContainerForProcess(tree, processId, avd, port) {
  const candidates = [];
  const visit = node => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (
      Number(node.pid) === processId
      && Number.isInteger(node.id)
      && node.id > 0
    ) {
      candidates.push({ id: node.id, title: String(node.name || '') });
    }
    for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
      visit(child);
    }
  };
  visit(tree);
  return selectLinuxAndroidWindow(candidates, avd, port);
}

function activateLinuxAndroidEmulator(
  environment,
  processId,
  serial,
  options = {}
) {
  const env = environment.env;
  const captureFn = options.captureFn || capture;
  const findExecutableFn = options.findExecutableFn || findExecutable;
  const port = androidEmulatorConsolePort(serial);
  const wayland = (
    String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
    || Boolean(env.WAYLAND_DISPLAY)
  );
  let lastReason = null;
  let x11ToolAvailable = false;

  if (env.SWAYSOCK) {
    const swaymsg = findExecutableFn('swaymsg', env);
    if (swaymsg) {
      const treeResult = captureFn(
        swaymsg,
        ['-r', '-t', 'get_tree'],
        { env, check: false }
      );
      if (treeResult.status === 0) {
        try {
          const selected = swayContainerForProcess(
            JSON.parse(treeResult.stdout),
            processId,
            environment.avd,
            port
          );
          if (selected.window) {
            const focus = captureFn(
              swaymsg,
              ['-r', `[con_id=${selected.window.id}] focus`],
              { env, check: false }
            );
            const response = JSON.parse(focus.stdout || '[]');
            if (
              focus.status === 0
              && Array.isArray(response)
              && response.some(item => item && item.success === true)
            ) {
              return androidActivationResult({
                method: 'sway', platform: 'linux', serial, status: 'activated',
              });
            }
            lastReason = 'activation-refused';
          } else {
            lastReason = selected.reason;
          }
        } catch (_error) {
          lastReason = 'activation-error';
          // Continue to X11/XWayland fallbacks when Sway IPC cannot activate it.
        }
      }
    }
  }

  if (!env.DISPLAY) {
    const reason = lastReason
      || (wayland ? 'wayland-focus-policy' : 'display-unavailable');
    return androidActivationResult({
      platform: 'linux',
      reason,
      serial,
      status: reason === 'activation-refused' ? 'refused' : 'unavailable',
    });
  }

  const wmctrl = findExecutableFn('wmctrl', env);
  if (wmctrl) {
    x11ToolAvailable = true;
    const list = captureFn(wmctrl, ['-lp'], { env, check: false });
    if (list.status === 0) {
      const selected = selectLinuxAndroidWindow(
        linuxWmctrlWindows(list.stdout, processId),
        environment.avd,
        port
      );
      if (selected.window) {
        const activated = captureFn(
          wmctrl,
          ['-i', '-a', selected.window.id],
          { env, check: false }
        );
        if (activated.status === 0) {
          return linuxRequestedActivationResult(
            environment,
            selected.window,
            wayland ? 'xwayland-wmctrl' : 'wmctrl',
            serial,
            { captureFn, findExecutableFn }
          );
        }
        lastReason = 'activation-refused';
      } else {
        lastReason = selected.reason;
      }
    } else {
      lastReason = 'activation-error';
    }
  }

  if (!wayland) {
    const xdotool = findExecutableFn('xdotool', env);
    if (xdotool) {
      x11ToolAvailable = true;
      const search = captureFn(
        xdotool,
        ['search', '--all', '--pid', String(processId)],
        { env, check: false }
      );
      if (search.status === 0) {
        const windows = [];
        for (const id of search.stdout.split(/\r?\n/).map(line => line.trim())) {
          if (!/^\d+$/.test(id)) {
            continue;
          }
          const name = captureFn(
            xdotool,
            ['getwindowname', id],
            { env, check: false }
          );
          windows.push({ id, title: name.status === 0 ? name.stdout.trim() : '' });
        }
        const selected = selectLinuxAndroidWindow(
          windows,
          environment.avd,
          port
        );
        if (selected.window) {
          captureFn(
            xdotool,
            ['windowmap', selected.window.id],
            { env, check: false }
          );
          const activated = captureFn(
            xdotool,
            ['windowactivate', selected.window.id],
            { env, check: false }
          );
          if (activated.status === 0) {
            return linuxRequestedActivationResult(
              environment,
              selected.window,
              'xdotool',
              serial,
              { captureFn, findExecutableFn }
            );
          }
          lastReason = 'activation-refused';
        } else {
          lastReason = selected.reason;
        }
      } else {
        lastReason = 'activation-error';
      }
    }
  }

  const reason = wayland
    ? 'wayland-focus-policy'
    : lastReason || (x11ToolAvailable
      ? 'activation-error'
      : 'x11-tool-missing');
  return androidActivationResult({
    platform: 'linux',
    reason,
    serial,
    status: reason === 'activation-refused' ? 'refused' : 'unavailable',
  });
}

function normalizeAndroidActivationResult(result, platform, serial) {
  if (result && typeof result === 'object' && typeof result.status === 'string') {
    return result;
  }
  return androidActivationResult({
    platform,
    reason: result === true ? null : 'activation-refused',
    serial,
    status: result === true ? 'activated' : 'refused',
  });
}

function activateAndroidEmulator(environment, options = {}) {
  const platform = options.platform || process.platform;
  const captureFn = options.captureFn || capture;
  let serial = options.serial || null;
  try {
    serial = serial || runningAndroidAvdSerial(environment, captureFn);
    if (!serial) {
      return androidActivationResult({
        platform, reason: 'serial-not-found', status: 'unavailable',
      });
    }
    if (!['darwin', 'win32', 'linux'].includes(platform)) {
      return androidActivationResult({
        platform, reason: 'unsupported-platform', serial, status: 'unavailable',
      });
    }
    const processIdFn = options.processIdFn || androidEmulatorHostProcessId;
    const processId = processIdFn(serial, environment.env, {
      captureFn,
      findExecutableFn: options.findExecutableFn,
      pathExists: options.pathExists,
      platform,
      procRoot: options.procRoot,
      readDirectoryFn: options.readDirectoryFn,
      readFileFn: options.readFileFn,
      readLinkFn: options.readLinkFn,
    });
    if (!processId) {
      return androidActivationResult({
        platform, reason: 'process-not-found', serial, status: 'unavailable',
      });
    }

    const activationOptions = {
      captureFn,
      findExecutableFn: options.findExecutableFn,
      pathExists: options.pathExists,
    };
    if (platform === 'darwin') {
      return activateMacAndroidEmulator(
        environment, processId, serial, activationOptions
      );
    }
    if (platform === 'win32') {
      return activateWindowsAndroidEmulator(
        environment, processId, serial, activationOptions
      );
    }
    return activateLinuxAndroidEmulator(
      environment, processId, serial, activationOptions
    );
  } catch (_error) {
    return androidActivationResult({
      platform, reason: 'activation-error', serial, status: 'unavailable',
    });
  }
}

function safelyActivateAndroidEmulator(
  activateFn,
  environment,
  options = {}
) {
  const platform = options.platform || process.platform;
  try {
    return normalizeAndroidActivationResult(
      activateFn(environment, options),
      platform,
      options.serial || null
    );
  } catch (_error) {
    return androidActivationResult({
      platform,
      reason: 'activation-error',
      serial: options.serial || null,
      status: 'unavailable',
    });
  }
}

function reportAndroidEmulatorActivation(
  activation,
  environment,
  options = {}
) {
  const platform = options.platform || activation.platform || process.platform;
  const log = options.log || console.log;
  const warn = options.warn || console.warn;
  const afterIos = options.afterIos === true;
  if (activation.status === 'activated') {
    log(
      afterIos
        ? '✓ Android emulator window returned to the front after iOS launch'
        : '✓ Android emulator window brought to the front'
    );
    return;
  }
  if (activation.status === 'requested') {
    warn(
      activation.method === 'xwayland-wmctrl'
        ? 'Android emulator activation requested through XWayland; the '
          + 'Wayland compositor controls final focus'
        : 'Android emulator activation requested; the desktop window manager '
          + 'controls final focus'
    );
    return;
  }
  if (platform === 'win32') {
    if (activation.reason === 'activation-refused-taskbar-requested') {
      warn(
        'Android app launched, but Windows did not grant foreground focus. '
        + 'OnRamp restored the window and asked Windows to flash its taskbar '
        + 'button; select Android Emulator from the taskbar or press Alt+Tab.'
      );
    } else {
      warn(
        'Android app launched, but OnRamp could not activate the selected '
        + 'emulator window. Select Android Emulator from the taskbar or press '
        + 'Alt+Tab.'
      );
    }
    return;
  }
  if (platform === 'linux') {
    const env = environment.env || {};
    const wayland = (
      String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland'
      || Boolean(env.WAYLAND_DISPLAY)
    );
    const serial = activation.serial || 'the selected Android emulator';
    if (activation.reason === 'display-unavailable') {
      warn(
        'Android app launched, but no graphical Linux display is available. '
        + 'Open the emulator from your desktop session.'
      );
    } else if (
      activation.reason === 'process-not-found'
      || activation.reason === 'window-not-found'
    ) {
      warn(
        `Android app launched, but OnRamp could not find ${serial}'s desktop `
        + 'window. It may be embedded in Android Studio; select it manually.'
      );
    } else if (activation.reason === 'ambiguous-window') {
      warn(
        `Android app launched, but ${serial} owns multiple possible windows. `
        + 'Select Android Emulator from the task switcher.'
      );
    } else if (activation.reason === 'x11-tool-missing') {
      warn(
        'Android app launched, but foreground control needs wmctrl or xdotool '
        + 'on this X11 desktop. Install either utility, or select Android '
        + 'Emulator from the task switcher.'
      );
    } else if (activation.reason === 'wayland-focus-policy' || wayland) {
      warn(
        'Android app launched, but this Wayland compositor did not grant '
        + 'foreground focus. Select Android Emulator from the task switcher.'
      );
    } else {
      warn(
        `Android app launched, but OnRamp could not activate ${serial} `
        + 'on this X11 desktop. Select Android Emulator from the task switcher.'
      );
    }
    return;
  }
  if (platform === 'darwin') {
    warn(
      'Android app launched, but OnRamp could not bring its emulator window '
      + 'to the front. Allow terminal window control if macOS asks, or select '
      + 'Android Emulator from the Dock or Mission Control.'
    );
  }
}

function androidRunArguments(port, device, applicationId) {
  return [
    'react-native',
    'run-android',
    '--device',
    device,
    '--port',
    String(port),
    '--no-packager',
    '--active-arch-only',
    '--appId',
    applicationId,
  ];
}

function gradleTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && next === '*') {
      const closing = source.indexOf('*/', index + 2);
      index = closing === -1 ? source.length : closing + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const triple = source.slice(index, index + 3) === quote.repeat(3);
      const delimiterLength = triple ? 3 : 1;
      const start = index;
      const contentStart = index + delimiterLength;
      index = contentStart;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (
          triple
            ? source.slice(index, index + 3) === quote.repeat(3)
            : source[index] === quote
        ) {
          const contentEnd = index;
          index += delimiterLength;
          tokens.push({
            end: index,
            quote,
            start,
            type: 'string',
            value: source.slice(contentStart, contentEnd),
          });
          break;
        }
        index += 1;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) {
        index += 1;
      }
      tokens.push({
        end: index,
        start,
        type: 'identifier',
        value: source.slice(start, index),
      });
      continue;
    }
    tokens.push({
      end: index + 1,
      start: index,
      type: 'symbol',
      value: character,
    });
    index += 1;
  }
  return tokens;
}

function gradleBlockOpening(tokens, index, name) {
  if (
    tokens[index]?.type === 'identifier'
    && tokens[index].value === name
    && tokens[index + 1]?.value === '{'
  ) {
    return index + 1;
  }
  if (
    tokens[index]?.type === 'identifier'
    && (tokens[index].value === 'getByName' || tokens[index].value === 'named')
    && tokens[index + 1]?.value === '('
    && tokens[index + 2]?.type === 'string'
    && tokens[index + 2].value === name
    && tokens[index + 3]?.value === ')'
    && tokens[index + 4]?.value === '{'
  ) {
    return index + 4;
  }
  return null;
}

function gradleBlockContent(source, name) {
  const tokens = gradleTokens(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const openingIndex = gradleBlockOpening(tokens, index, name);
    if (openingIndex === null) continue;
    let depth = 1;
    for (let cursor = openingIndex + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === '{') {
        depth += 1;
      } else if (tokens[cursor].value === '}') {
        depth -= 1;
        if (depth === 0) {
          return source.slice(tokens[openingIndex].end, tokens[cursor].start);
        }
      }
    }
    return null;
  }
  return null;
}

function gradleLiteralProperty(source, name) {
  const tokens = gradleTokens(source);
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '{') {
      depth += 1;
      continue;
    }
    if (token.value === '}') {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || token.type !== 'identifier' || token.value !== name) {
      continue;
    }
    let valueIndex = index + 1;
    if (tokens[valueIndex]?.value === '=') valueIndex += 1;
    const value = tokens[valueIndex];
    if (value?.type !== 'string') return { found: true, literal: false };
    const interpolated = value.quote === '"' && /(^|[^\\])\$/.test(value.value);
    const following = tokens[valueIndex + 1];
    const statementEnded = (
      !following
      || following.value === '}'
      || /[\r\n;]/.test(source.slice(value.end, following.start))
    );
    return interpolated || !statementEnded
      ? { found: true, literal: false }
      : { found: true, literal: true, value: value.value };
  }
  return { found: false, literal: false };
}

function androidApplicationId(outputDir, nativeConfig) {
  const buildGradle = fs.readFileSync(
    path.join(outputDir, 'android', 'app', 'build.gradle'),
    'utf8'
  );
  const android = gradleBlockContent(buildGradle, 'android');
  const defaultConfig = android && gradleBlockContent(android, 'defaultConfig');
  const applicationId = defaultConfig
    ? gradleLiteralProperty(defaultConfig, 'applicationId')
    : { found: false, literal: false };
  if (applicationId.found && !applicationId.literal) {
    throw new Error(
      'Could not determine the Android application ID because '
      + 'android.defaultConfig.applicationId is not a static string literal.'
    );
  }
  const baseApplicationId = applicationId.value || nativeConfig?.android?.package;
  if (!baseApplicationId) {
    throw new Error('Could not determine the Android application ID.');
  }
  const buildTypes = android && gradleBlockContent(android, 'buildTypes');
  const debug = buildTypes && gradleBlockContent(buildTypes, 'debug');
  const suffixProperty = debug
    ? gradleLiteralProperty(debug, 'applicationIdSuffix')
    : { found: false, literal: false };
  if (suffixProperty.found && !suffixProperty.literal) {
    throw new Error(
      'Could not determine the Android debug application ID because '
      + 'android.buildTypes.debug.applicationIdSuffix is not a static string literal.'
    );
  }
  const suffix = suffixProperty.value || '';
  return `${baseApplicationId}${suffix}`;
}

function androidAppIsInstalled(
  environment,
  device,
  applicationId,
  captureFn = capture
) {
  const result = captureFn(
    environment.adb,
    ['-s', device, 'shell', 'pm', 'path', applicationId],
    { env: environment.env, check: false }
  );
  return result.status === 0 && /\bpackage:/.test(result.stdout);
}

function launchInstalledAndroidApp(
  environment,
  device,
  applicationId,
  metroPort,
  captureFn = capture
) {
  captureFn(
    environment.adb,
    [
      '-s',
      device,
      'reverse',
      `tcp:${metroPort}`,
      `tcp:${metroPort}`,
    ],
    { env: environment.env }
  );
  const resolved = captureFn(
    environment.adb,
    [
      '-s',
      device,
      'shell',
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      applicationId,
    ],
    { env: environment.env, check: false }
  );
  const component = resolved.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.includes('/'));
  if (!component) {
    const detail = String(resolved.stderr || resolved.stdout || '').trim();
    throw new Error(
      `Could not resolve the Android launcher activity for ${applicationId}.`
      + (detail ? ` ${detail}` : '')
    );
  }
  captureFn(
    environment.adb,
    ['-s', device, 'shell', 'am', 'force-stop', applicationId],
    { env: environment.env }
  );
  captureFn(
    environment.adb,
    [
      '-s',
      device,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.MAIN',
      '-c',
      'android.intent.category.LAUNCHER',
      '-n',
      component,
    ],
    { env: environment.env }
  );
}

function androidEmulatorStartupMonitor(child) {
  let failure = null;
  let diagnostics = '';
  const stderr = child && child.stderr;
  const append = chunk => {
    diagnostics = (diagnostics + String(chunk)).slice(-8192);
  };
  if (stderr && typeof stderr.on === 'function') {
    stderr.on('data', append);
    if (typeof stderr.unref === 'function') {
      stderr.unref();
    }
  }
  if (child && typeof child.once === 'function') {
    child.once('error', error => {
      failure = error;
    });
    child.once('close', (status, signal) => {
      if (!failure) {
        const ending = status === null
          ? ' after signal ' + signal
          : ' with status ' + status;
        failure = new Error('Android Emulator exited' + ending + '.');
      }
    });
  }
  return {
    detail() {
      return diagnostics
        .replace(/\x1b\[[0-9;]*m/g, '')
        .trim();
    },
    failure() {
      return failure;
    },
    release() {
      if (stderr && typeof stderr.removeListener === 'function') {
        stderr.removeListener('data', append);
      }
      if (stderr && typeof stderr.resume === 'function') {
        // Keep draining the detached emulator without retaining its output.
        stderr.resume();
      }
    },
  };
}

function androidEmulatorFailure(environment, startup) {
  const failure = startup && startup.failure();
  if (!failure) {
    return null;
  }
  const detail = startup.detail();
  return new Error(
    `Android virtual device ${environment.avd} failed to start: `
    + failure.message
    + (detail ? `\n${detail}` : '')
  );
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForAndroidEmulator(environment, options = {}) {
  const captureFn = options.captureFn || capture;
  const delay = options.delay || wait;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs || EMULATOR_BOOT_TIMEOUT_MS;
  const pollMs = options.pollMs || EMULATOR_BOOT_POLL_MS;
  const startup = options.startup;
  const startedAt = now();

  while (now() - startedAt < timeoutMs) {
    const startupFailure = androidEmulatorFailure(environment, startup);
    if (startupFailure) {
      throw startupFailure;
    }
    const serial = runningAndroidAvdSerial(environment, captureFn);
    if (serial) {
      const boot = captureFn(
        environment.adb,
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        { env: environment.env, check: false }
      );
      if (boot.status === 0 && boot.stdout.trim() === '1') {
        return serial;
      }
    }
    await delay(pollMs);
  }

  const startupFailure = androidEmulatorFailure(environment, startup);
  if (startupFailure) {
    throw startupFailure;
  }
  const detail = startup && startup.detail();
  throw new Error(
    `Android virtual device ${environment.avd} did not finish booting `
    + `within ${Math.round(timeoutMs / 1000)} seconds.`
    + (detail ? `\nAndroid Emulator diagnostics:\n${detail}` : '')
  );
}

async function ensureAndroidEmulator(environment, options = {}) {
  const captureFn = options.captureFn || capture;
  const spawnFn = options.spawnFn || spawn;
  const log = options.log || console.log;
  const activateFn = options.activateFn || activateAndroidEmulator;
  const activate = serial => safelyActivateAndroidEmulator(
    activateFn,
    environment,
    {
      captureFn,
      findExecutableFn: options.findExecutableFn,
      pathExists: options.pathExists,
      platform: options.platform,
      procRoot: options.procRoot,
      readDirectoryFn: options.readDirectoryFn,
      readFileFn: options.readFileFn,
      readLinkFn: options.readLinkFn,
      serial,
    }
  );
  const running = runningAndroidAvdSerial(environment, captureFn);
  if (running) {
    log(`Using running Android emulator ${running}`);
    activate(running);
    return running;
  }

  const args = androidEmulatorLaunchArgs(environment.avd);
  const child = spawnFn(environment.emulator, args, {
    detached: true,
    env: environment.env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (typeof child.unref === 'function') {
    child.unref();
  }
  const startup = androidEmulatorStartupMonitor(child);
  log(`Cold-starting Android virtual device ${environment.avd}`);

  try {
    const serial = await waitForAndroidEmulator(environment, {
      captureFn,
      delay: options.delay,
      now: options.now,
      pollMs: options.pollMs,
      startup,
      timeoutMs: options.timeoutMs,
    });
    activate(serial);
    return serial;
  } finally {
    startup.release();
  }
}

function androidSdkCandidates(env) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  const home = os.homedir();

  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Android', 'sdk'));
  } else if (process.platform === 'win32') {
    candidates.push(path.join(env.LOCALAPPDATA || '', 'Android', 'Sdk'));
  } else {
    candidates.push(
      path.join(home, 'Android', 'Sdk'),
      '/opt/android-sdk',
      '/usr/local/android-sdk'
    );
  }
  return [...new Set(candidates.filter(Boolean).map(candidate => (
    path.resolve(candidate)
  )))];
}

function findAndroidSdk(env) {
  for (const sdk of androidSdkCandidates(env)) {
    if (
      fs.existsSync(path.join(sdk, 'platform-tools'))
      || fs.existsSync(path.join(sdk, 'emulator'))
      || fs.existsSync(path.join(sdk, 'cmdline-tools'))
      || fs.existsSync(path.join(sdk, 'tools'))
    ) {
      return sdk;
    }
  }
  return null;
}

function defaultAndroidSdk(env) {
  return androidSdkCandidates(env)[0] || null;
}

function javaMajor(javaHome) {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const java = path.join(javaHome, 'bin', executable);
  if (!fs.existsSync(java)) {
    return null;
  }

  try {
    const result = capture(java, ['-version']);
    const match = `${result.stderr}${result.stdout}`.match(/version "(?:1\.)?(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

function findJdk17(env) {
  const candidates = [env.JAVA_HOME];

  if (process.platform === 'darwin') {
    try {
      const result = capture('/usr/libexec/java_home', ['-v', '17']);
      candidates.push(result.stdout.trim());
    } catch (_error) {
      // Continue through the known installation locations.
    }
    candidates.push(
      '/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home',
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      path.join(
        env.ProgramFiles || 'C:\\Program Files',
        'Android',
        'Android Studio',
        'jbr'
      )
    );
  } else {
    candidates.push(
      '/usr/lib/jvm/java-17-openjdk',
      '/usr/lib/jvm/java-17-openjdk-amd64',
      '/usr/lib/jvm/java-17-openjdk-arm64',
      '/opt/android-studio/jbr'
    );
  }

  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const javaHome = path.resolve(candidate);
    if (javaMajor(javaHome) === 17) {
      return javaHome;
    }
  }
  return null;
}

function baseAndroidEnvironment(options = {}) {
  const env = { ...(options.env || process.env) };
  const sdk = options.sdk || findAndroidSdk(env) || defaultAndroidSdk(env);
  if (!sdk) {
    throw new Error(
      'Could not determine where to install or find the Android SDK.'
    );
  }

  env.ANDROID_HOME = sdk;
  env.ANDROID_SDK_ROOT = sdk;
  const javaHome = options.javaHome || findJdk17(env);
  if (!javaHome) {
    throw new Error(
      'JDK 17 was not found. Install Android Studio or JDK 17, then try again.'
    );
  }
  env.JAVA_HOME = javaHome;
  prependPath(
    env,
    path.join(sdk, 'platform-tools'),
    path.join(sdk, 'emulator'),
    ...androidCommandCandidates(sdk, 'sdkmanager').map(candidate => (
      path.dirname(candidate)
    )),
    path.join(javaHome, 'bin')
  );
  return { env, javaHome, sdk };
}

function androidExecutables(environment) {
  const { env } = environment;
  const adb = findExecutable('adb', env);
  const emulator = findExecutable('emulator', env);
  return { adb, emulator };
}

function installedAndroidAvds(emulator, env, captureFn = capture) {
  if (!emulator) {
    return [];
  }
  const result = captureFn(emulator, ['-list-avds'], {
    env,
    check: false,
  });
  if (result.status !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function stableAndroidAvdMetadata(avds, sdk, env) {
  return avds
    .map(avd => androidAvdMetadata(avd, sdk, env))
    .filter(metadata => metadata.valid && metadata.stable);
}

function androidAvdApi(metadata) {
  if (!metadata || !metadata.packagePath) {
    return [];
  }
  const details = androidSystemImageDetails({ path: metadata.packagePath });
  return details ? details.api : [];
}

function nextAndroidAvdName(api, avds) {
  const version = api.join('_') || 'Current';
  const base = 'OnRamp_API_' + version;
  if (!avds.includes(base)) {
    return base;
  }
  let suffix = 2;
  while (avds.includes(base + '_' + suffix)) {
    suffix += 1;
  }
  return base + '_' + suffix;
}

function createAndroidAvd(
  avdManager,
  systemImage,
  avds,
  environment,
  captureFn = capture,
  log = console.log
) {
  if (!avdManager) {
    throw new Error(
      'Android avdmanager was not found after installing command-line tools.'
    );
  }
  const name = nextAndroidAvdName(systemImage.api, avds);
  const deviceResult = captureFn(
    avdManager,
    ['list', 'device'],
    { env: environment.env, check: false }
  );
  const device = deviceResult.status === 0
    ? preferredAndroidPhoneProfile(
      parseAndroidDeviceProfiles(deviceResult.stdout)
    )
    : null;
  if (!device) {
    throw new Error(
      'Android avdmanager did not provide a modern phone device profile. '
      + 'Update the Android SDK command-line tools and try again.'
    );
  }
  log(
    'Creating Android virtual device ' + name
    + ' with device profile ' + device + '...'
  );
  captureFn(
    avdManager,
    [
      'create',
      'avd',
      '--name',
      name,
      '--package',
      systemImage.packageInfo.path,
      '--device',
      device,
      '--force',
    ],
    {
      env: environment.env,
      input: 'no\n',
    }
  );
  log('✓ Android virtual device ' + name + ' created');
  return name;
}

function existingAndroidEnvironmentOrNull(environment, options = {}) {
  try {
    return resolveAndroidEnvironment({
      ...environment,
      captureFn: options.captureFn,
      log: options.log,
    });
  } catch (_error) {
    return null;
  }
}

async function prepareAndroidEnvironment(options = {}) {
  const ask = options.promptYesNo || promptYesNo;
  const captureFn = options.captureFn || capture;
  const runFn = options.runFn;
  const log = options.log || console.log;
  const environment = baseAndroidEnvironment(options);
  let sdkManager = findUsableSdkManager(
    environment.sdk,
    environment.env,
    captureFn
  );

  if (!sdkManager) {
    try {
      sdkManager = await (options.bootstrapCommandLineTools
        || bootstrapAndroidCommandLineTools)({
        sdk: environment.sdk,
        env: environment.env,
        promptYesNo: ask,
        fetchFn: options.fetchFn,
        captureFn,
        downloadFn: options.downloadFn,
        extractFn: options.extractFn,
        log,
      });
    } catch (error) {
      const existing = existingAndroidEnvironmentOrNull(environment, {
        captureFn,
        log,
      });
      if (existing) {
        log(
          'Warning: OnRamp could not check Android package updates: '
          + error.message
        );
        return existing;
      }
      throw error;
    }
    if (!sdkManager) {
      const existing = existingAndroidEnvironmentOrNull(environment, {
        captureFn,
        log,
      });
      if (existing) {
        log('Skipping the Android package update check.');
        return existing;
      }
      throw new Error(
        'Android launch cancelled; command-line tools are required to '
        + 'install the missing emulator components.'
      );
    }
  }

  prependPath(environment.env, path.dirname(sdkManager));
  let packages;
  try {
    packages = (options.listPackages || listAndroidSdkPackages)(
      sdkManager,
      environment.sdk,
      environment.env,
      captureFn
    );
  } catch (error) {
    const existing = existingAndroidEnvironmentOrNull(environment, {
      captureFn,
      log,
    });
    if (existing) {
      log(
        'Warning: OnRamp could not check Android package updates: '
        + error.message
      );
      return existing;
    }
    throw error;
  }

  let { adb, emulator } = androidExecutables(environment);
  const emulatorPackage = packages.get('emulator');
  const platformToolsPackage = packages.get('platform-tools');
  const packagesToInstall = new Set();
  let emulatorInstallApproved = false;
  let replaceEmulatorPackage = false;
  const inspectEmulatorArchitecture = (
    options.emulatorArchitectureMismatch
    || androidEmulatorArchitectureMismatch
  );
  const emulatorMismatch = emulator
    ? inspectEmulatorArchitecture(emulator, environment.env, {
      architecture: options.architecture,
      captureFn,
      pathExists: options.pathExists,
      platform: options.platform,
    })
    : null;

  if (emulatorMismatch) {
    const installedVersion = emulatorPackage
      && emulatorPackage.installedVersion;
    const targetVersion = emulatorPackage
      && (
        emulatorPackage.availableVersion
        || emulatorPackage.installedVersion
      );
    emulatorInstallApproved = await ask(
      'Android Emulator'
      + (installedVersion ? ' ' + installedVersion : '')
      + ' was installed for ' + emulatorMismatch.installed.join(', ')
      + ', but this Mac requires ' + emulatorMismatch.expected + '. '
      + 'Reinstall'
      + (targetVersion ? ' version ' + targetVersion : ' it')
      + ' for this Mac now? (y/N): '
    );
    if (!emulatorInstallApproved) {
      throw new Error(
        'Android launch cancelled; the installed Android Emulator cannot '
        + 'run this Mac\'s native system images.'
      );
    }
    packagesToInstall.add('emulator');
    replaceEmulatorPackage = true;
  } else if (
    !emulator
    || !emulatorPackage
    || !emulatorPackage.installedVersion
  ) {
    const latest = emulatorPackage
      && (
        emulatorPackage.availableVersion
        || emulatorPackage.installedVersion
      );
    emulatorInstallApproved = await ask(
      'Android Emulator is not installed. Install'
      + (latest ? ' version ' + latest : ' the latest stable version')
      + ' in ' + environment.sdk
      + '? This may download more than 1 GB. (y/N): '
    );
    if (!emulatorInstallApproved) {
      throw new Error(
        'Android launch cancelled; Android Emulator is not installed.'
      );
    }
    packagesToInstall.add('emulator');
  } else if (androidPackageNeedsUpdate(emulatorPackage)) {
    const approved = await ask(
      'Android Emulator ' + emulatorPackage.availableVersion
      + ' is available; ' + emulatorPackage.installedVersion
      + ' is installed. Upgrade now? (y/N): '
    );
    if (approved) {
      packagesToInstall.add('emulator');
    } else {
      log(
        'Continuing with Android Emulator '
        + emulatorPackage.installedVersion + '.'
      );
    }
  }

  if (!adb || !platformToolsPackage || !platformToolsPackage.installedVersion) {
    let approved = emulatorInstallApproved;
    if (!approved) {
      approved = await ask(
        'Android SDK Platform-Tools are missing. Install the latest version '
        + 'now? (y/N): '
      );
    }
    if (!approved) {
      throw new Error(
        'Android launch cancelled; SDK Platform-Tools are required.'
      );
    }
    packagesToInstall.add('platform-tools');
  }

  if (packagesToInstall.size > 0) {
    if (replaceEmulatorPackage) {
      log('Removing incompatible Android Emulator package...');
      await (options.removePackages || removeAndroidSdkPackages)(
        sdkManager,
        environment.sdk,
        environment.env,
        ['emulator'],
        runFn,
        { platform: options.platform }
      );
      log('✓ Incompatible Android Emulator package removed');
    }
    log(
      'Installing Android SDK package'
      + (packagesToInstall.size === 1 ? '' : 's') + '...'
    );
    await (options.installPackages || installAndroidSdkPackages)(
      sdkManager,
      environment.sdk,
      environment.env,
      [...packagesToInstall],
      runFn,
      {
        architecture: options.architecture,
        platform: options.platform,
      }
    );
    prependPath(
      environment.env,
      path.join(environment.sdk, 'platform-tools'),
      path.join(environment.sdk, 'emulator')
    );
    packages = (options.listPackages || listAndroidSdkPackages)(
      sdkManager,
      environment.sdk,
      environment.env,
      captureFn
    );
    ({ adb, emulator } = androidExecutables(environment));
    if (replaceEmulatorPackage && emulator) {
      const remainingMismatch = inspectEmulatorArchitecture(
        emulator,
        environment.env,
        {
          architecture: options.architecture,
          captureFn,
          pathExists: options.pathExists,
          platform: options.platform,
        }
      );
      if (remainingMismatch) {
        throw new Error(
          'Android Emulator reinstall completed, but its executable is still '
          + 'for ' + remainingMismatch.installed.join(', ') + ' instead of '
          + remainingMismatch.expected + '.'
        );
      }
    }
  }

  if (!adb || !emulator) {
    throw new Error(
      'Android package installation completed, but adb or Emulator is '
      + 'still unavailable.'
    );
  }

  const emulatorVersion = requireClipboardCapableEmulator(
    emulator,
    environment.env,
    captureFn
  );
  const avds = installedAndroidAvds(
    emulator,
    environment.env,
    captureFn
  );
  const stableAvds = stableAndroidAvdMetadata(
    avds,
    environment.sdk,
    environment.env
  );
  const preferredImage = preferredAndroidSystemImage(packages);

  if (!preferredImage) {
    if (stableAvds.length === 0) {
      throw new Error(
        'No stable Android system image is available for this computer.'
      );
    }
  } else {
    const matchingImageAvds = stableAvds.filter(metadata => (
      metadata.packagePath === preferredImage.packageInfo.path
    ));
    const matchingAvd = matchingImageAvds.find(metadata => (
      metadata.display && metadata.display.sharp
    ));
    const lowResolutionAvd = matchingImageAvds.find(metadata => (
      !metadata.display || !metadata.display.sharp
    ));
    const imageNeedsUpdate = androidPackageNeedsUpdate(
      preferredImage.packageInfo
    );
    const imageNeedsInstall = (
      !preferredImage.packageInfo.installedVersion
      || imageNeedsUpdate
    );
    const avdNeedsCreate = !matchingAvd;

    if (imageNeedsInstall || avdNeedsCreate) {
      const latestApi = preferredImage.api.join('.');
      const current = stableAvds
        .slice()
        .sort((left, right) => compareVersions(
          androidAvdApi(right),
          androidAvdApi(left)
        ))[0];
      let question;
      if (lowResolutionAvd && !imageNeedsInstall) {
        const display = lowResolutionAvd.display || {};
        const dimensions = display.width && display.height
          ? display.width + 'x' + display.height
          : 'an unknown resolution';
        const density = display.density
          ? ' at ' + display.density + ' dpi'
          : '';
        question = (
          'Android virtual device ' + lowResolutionAvd.avd + ' uses '
          + dimensions + density + ', which can look fuzzy when scaled. '
          + 'Create a sharper Pixel-class device now? The installed system '
          + 'image will be reused and the old device and its app data will '
          + 'remain available. (y/N): '
        );
      } else if (!current) {
        question = (
          'No usable Android virtual device is installed. Install the latest '
          + 'stable Android API ' + latestApi
          + ' system image and create one now? This can be several GB. (y/N): '
        );
      } else if (
        current.packagePath === preferredImage.packageInfo.path
        && imageNeedsUpdate
      ) {
        question = (
          'A newer revision of the Android API ' + latestApi
          + ' system image is available. Upgrade it now? (y/N): '
        );
      } else {
        question = (
          'Android API ' + latestApi
          + ' is the newest stable emulator image; the selected device uses '
          + 'API ' + androidAvdApi(current).join('.')
          + '. Install the latest image and create a reusable OnRamp device? '
          + 'This can be several GB. (y/N): '
        );
      }

      const approved = await ask(question);
      if (approved) {
        if (imageNeedsInstall) {
          await (options.installPackages || installAndroidSdkPackages)(
            sdkManager,
            environment.sdk,
            environment.env,
            [
              preferredImage.packageInfo.installPath
              || preferredImage.packageInfo.path,
            ],
            runFn
          );
        }
        if (avdNeedsCreate) {
          const avdManager = findAvdManager(
            environment.sdk,
            sdkManager
          );
          createAndroidAvd(
            avdManager,
            preferredImage,
            avds,
            environment,
            captureFn,
            log
          );
        }
      } else if (stableAvds.length > 0) {
        log(
          'Continuing with Android API '
          + androidAvdApi(current).join('.') + '.'
        );
      } else {
        throw new Error(
          'Android launch cancelled; no usable virtual device is installed.'
        );
      }
    }
  }

  return resolveAndroidEnvironment({
    ...environment,
    captureFn,
    log,
    emulatorVersion,
  });
}

function resolveAndroidEnvironment(options = {}) {
  const captureFn = options.captureFn || capture;
  const log = options.log || console.log;
  const environment = baseAndroidEnvironment(options);
  const { env, javaHome, sdk } = environment;
  if (!findAndroidSdk(env)) {
    throw new Error(
      'Android SDK not found. Run an Android app with OnRamp to install '
      + 'the missing emulator components.'
    );
  }
  const { adb, emulator } = androidExecutables(environment);
  if (!adb || !emulator) {
    throw new Error(
      'The Android SDK is missing its platform-tools or emulator package.'
    );
  }
  const emulatorVersion = options.emulatorVersion
    || requireClipboardCapableEmulator(emulator, env, captureFn);

  const avds = installedAndroidAvds(emulator, env, captureFn);
  if (avds.length === 0) {
    throw new Error('No Android virtual device is installed.');
  }
  const avd = selectAndroidAvd(avds, sdk, env);

  log('Using Android SDK at ' + sdk);
  log('Using Android Emulator ' + emulatorVersion.join('.'));
  log('Using JDK 17 at ' + javaHome);
  log('Using Android virtual device ' + avd);
  return { adb, avd, emulator, emulatorVersion, env, javaHome, sdk };
}

function wakeAndroidEmulators(adb, env) {
  let result;
  try {
    result = capture(adb, ['devices'], { env });
  } catch (_error) {
    return;
  }

  const emulators = result.stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => (
      fields.length >= 2
      && fields[0].startsWith('emulator-')
      && fields[1] === 'device'
    ))
    .map(fields => fields[0]);

  for (const serial of emulators) {
    for (const command of [
      ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'],
      ['shell', 'wm', 'dismiss-keyguard'],
      ['shell', 'svc', 'power', 'stayon', 'true'],
    ]) {
      capture(adb, ['-s', serial, ...command], { env, check: false });
    }
    console.log(`✓ Android emulator ${serial} is awake and unlocked`);
  }
}

function doctorAndroid() {
  const environment = resolveAndroidEnvironment();
  console.log('✓ Android environment is ready');
  return environment;
}

async function prepareAndroidDevelopment({
  name,
  output,
  watchDiagnostics = false,
  environment: appEnvironment,
}) {
  const outputDir = path.resolve(output || process.cwd());
  console.log('Preparing Android development...');
  const environment = await prepareAndroidEnvironment();
  environment.env.ONRAMP_PLATFORM = 'android';
  if (watchDiagnostics) {
    environment.env.ONRAMP_WATCH_DIAGNOSTICS = '1';
  }
  if (enableHostClipboardSharing(environment.env)) {
    console.log('✓ Android emulator host clipboard sharing is enabled');
  }
  const native = await addNativePlatforms({
    platform: 'android',
    name,
    output: outputDir,
    environment: appEnvironment,
  });
  const applicationId = androidApplicationId(outputDir, native.nativeConfig);
  return { applicationId, environment, outputDir };
}

async function launchPreparedAndroid(
  prepared,
  {
    activateEmulator = activateAndroidEmulator,
    metroPort,
    metroStartingPort,
    metroInteractive = true,
    metroLabel,
    platform = process.platform,
    rebuild = false,
  } = {}
) {
  const { applicationId, environment, outputDir } = prepared;
  const device = await ensureAndroidEmulator(environment, {
    activateFn: activateEmulator,
    platform,
  });
  const metro = await startMetro({
    output: outputDir,
    requestedPort: metroPort,
    startingPort: metroStartingPort,
    env: environment.env,
    interactive: metroInteractive,
    label: metroLabel,
  });
  console.log(`Using Node.js v${process.versions.node} environment`);
  console.log(`Using Metro port ${metro.port}`);
  try {
    await warmMetroBundle({ port: metro.port, platform: 'android' });
    const fingerprint = nativeBuildFingerprint(outputDir, 'android');
    const cached = cachedNativeBuild(outputDir, 'android');
    const reuseInstalled = (
      !rebuild
      && cached
      && cached.fingerprint === fingerprint
      && cached.applicationId === applicationId
      && cached.avd === environment.avd
      && cached.metroPort === metro.port
      && androidAppIsInstalled(
        environment,
        device,
        applicationId
      )
    );
    if (reuseInstalled) {
      console.log(
        '✓ Android native inputs are unchanged; opening the installed app without rebuilding'
      );
      launchInstalledAndroidApp(
        environment,
        device,
        applicationId,
        metro.port
      );
    } else {
      console.log(
        'Building and installing the Android app for the active emulator architecture...'
      );
      await runAsync(
        'npx',
        androidRunArguments(metro.port, device, applicationId),
        outputDir,
        environment.env,
        {
          activityLabel: 'Android is still building and installing',
          inheritInput: metroInteractive,
        }
      );
      recordNativeBuild(outputDir, 'android', {
        applicationId,
        avd: environment.avd,
        metroPort: metro.port,
      });
    }
    wakeAndroidEmulators(environment.adb, environment.env);
    const activation = safelyActivateAndroidEmulator(
      activateEmulator,
      environment,
      { platform, serial: device }
    );
    reportAndroidEmulatorActivation(activation, environment, { platform });
    console.log('Android app launched. Metro remains active; press Ctrl+C to stop.');
    metro.androidDevice = device;
    return metro;
  } catch (error) {
    metro.stop('SIGTERM');
    throw error;
  }
}

async function runAndroid(options) {
  const prepared = await prepareAndroidDevelopment(options);
  return launchPreparedAndroid(prepared, {
    metroPort: options.metroPort,
    metroStartingPort: options.metroStartingPort,
    rebuild: options.rebuild,
  });
}

module.exports = {
  activateAndroidEmulator,
  androidAvdApi,
  androidAvdDisplay,
  androidAvdMetadata,
  androidAppIsInstalled,
  androidApplicationId,
  androidEmulatorArchitectureMismatch,
  androidEmulatorConsolePort,
  androidEmulatorLaunchArgs,
  androidEmulatorHostProcessId,
  androidEmulatorAvdName,
  androidHostExecutableArchitecture,
  androidRunArguments,
  compareVersions,
  connectedAndroidEmulators,
  doctorAndroid,
  enableHostClipboardSharing,
  ensureAndroidEmulator,
  launchPreparedAndroid,
  launchInstalledAndroidApp,
  parseMachOArchitectures,
  parseEmulatorVersion,
  parseAndroidDeviceProfiles,
  preferredAndroidPhoneProfile,
  prepareAndroidDevelopment,
  prepareAndroidEnvironment,
  requireClipboardCapableEmulator,
  reportAndroidEmulatorActivation,
  resolveAndroidEnvironment,
  runningAndroidAvdSerial,
  runAndroid,
  safelyActivateAndroidEmulator,
  selectAndroidAvd,
  waitForAndroidEmulator,
  wakeAndroidEmulators,
};
