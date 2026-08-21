const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  androidCliPlatform,
  androidDownloadUrls,
  androidPackageNeedsUpdate,
  installAndroidSdkPackages,
  parseAndroidCommandLineToolsPackage,
  parseAndroidSdkPackages,
  preferredAndroidSystemImage,
  removeAndroidSdkPackages,
  runAndroidSdkInstall,
} = require('../src/android-sdk');
const { prepareAndroidEnvironment } = require('../src/android');
const { capture } = require('../src/process');

test('finds Google command-line tools for the current host repository', () => {
  const xml = [
    '<repository>',
    '<remotePackage path="cmdline-tools;latest">',
    '<revision><major>23</major><minor>0</minor></revision>',
    '<archives>',
    '<archive><complete><size>100</size><checksum>linuxsum</checksum>',
    '<url>linux.zip</url></complete><host-os>linux</host-os></archive>',
    '<archive><complete><size>200</size><checksum>macsum</checksum>',
    '<url>mac.zip</url></complete><host-os>macosx</host-os></archive>',
    '</archives>',
    '</remotePackage>',
    '</repository>',
  ].join('');
  const selected = parseAndroidCommandLineToolsPackage(xml, 'darwin');

  assert.equal(selected.revision, '23.0');
  assert.equal(selected.size, 200);
  assert.equal(selected.checksum, 'macsum');
  assert.equal(
    selected.url,
    'https://dl.google.com/android/repository/mac.zip'
  );
});

test('maps Node hosts to explicit Android CLI platforms', () => {
  assert.equal(androidCliPlatform('darwin', 'arm64'), 'mac_arm64');
  assert.equal(androidCliPlatform('darwin', 'x64'), 'mac_x86_64');
  assert.equal(androidCliPlatform('linux', 'x64'), 'linux_x86_64');
  assert.equal(androidCliPlatform('win32', 'ia32'), 'windows_x86');
  assert.equal(androidCliPlatform('freebsd', 'x64'), null);
});

test('installs SDK packages with an explicit native Android CLI platform', async () => {
  const calls = [];
  await installAndroidSdkPackages(
    '/sdk/cmdline-tools/latest/bin/sdkmanager',
    '/sdk',
    { PATH: '/bin' },
    ['emulator', 'system-images;android-37;google_apis;arm64-v8a'],
    async (...args) => calls.push(args),
    {
      androidCli: '/sdk/cmdline-tools/latest/bin/android',
      architecture: 'arm64',
      force: true,
      platform: 'darwin',
    }
  );

  assert.deepEqual(calls[0].slice(0, 2), [
    '/sdk/cmdline-tools/latest/bin/android',
    [
      '--sdk=/sdk',
      'sdk',
      'install',
      '--platform=mac_arm64',
      '--force',
      'emulator',
      'system-images/android-37/google_apis/arm64-v8a',
    ],
  ]);
});

test('removes SDK packages through the current Android CLI', async () => {
  const calls = [];
  await removeAndroidSdkPackages(
    '/sdk/cmdline-tools/latest/bin/sdkmanager',
    '/sdk',
    { PATH: '/bin' },
    ['emulator'],
    async (...args) => calls.push(args),
    {
      androidCli: '/sdk/cmdline-tools/latest/bin/android',
      platform: 'darwin',
    }
  );

  assert.deepEqual(calls[0].slice(0, 2), [
    '/sdk/cmdline-tools/latest/bin/android',
    ['--sdk=/sdk', 'sdk', 'remove', 'emulator'],
  ]);
});

test('parses installed, available, and updatable Android SDK packages', () => {
  const packages = parseAndroidSdkPackages([
    'Installed packages:',
    '  Path | Version | Description | Location',
    '  ------- | ------- | ------- | -------',
    '  emulator | 36.2.1 | Android Emulator | emulator',
    '  platform-tools | 36.0.0 | Android SDK Platform-Tools | platform-tools',
    'Available Packages:',
    '  Path | Version | Description',
    '  ------- | ------- | -------',
    '  system-images;android-36;google_apis;arm64-v8a | 10 | Image',
    'Available Updates:',
    '  ID | Installed | Available',
    '  ------- | ------- | -------',
    '  emulator | 36.2.1 | 37.1.11',
  ].join('\n'));

  assert.deepEqual(packages.get('emulator'), {
    path: 'emulator',
    installedVersion: '36.2.1',
    availableVersion: '37.1.11',
    description: 'Android Emulator',
  });
  assert.equal(androidPackageNeedsUpdate(packages.get('emulator')), true);
});

test('parses current Android CLI package output and canonicalizes images', () => {
  const packages = parseAndroidSdkPackages([
    'Installed packages:',
    '  emulator                         32.1.11    ->   37.1.11  Android Emulator',
    'Available packages:',
    '  system-images/android-37.1/google_apis_ps16k/arm64-v8a  8.0.0  Google APIs Image',
  ].join('\n'));

  assert.deepEqual(packages.get('emulator'), {
    path: 'emulator',
    installedVersion: '32.1.11',
    availableVersion: '37.1.11',
    description: 'Android Emulator',
  });
  assert.deepEqual(
    packages.get(
      'system-images;android-37.1;google_apis_ps16k;arm64-v8a'
    ),
    {
      path: 'system-images;android-37.1;google_apis_ps16k;arm64-v8a',
      availableVersion: '8.0.0',
      description: 'Google APIs Image',
      installPath: (
        'system-images/android-37.1/google_apis_ps16k/arm64-v8a'
      ),
    }
  );
});

test('extracts Android repository URLs without the CLI activity suffix', () => {
  assert.deepEqual(
    androidDownloadUrls(
      'https://dl.google.com/android/repository/system-image.zip...\n'
    ),
    ['https://dl.google.com/android/repository/system-image.zip']
  );
});

test('reports download progress and extraction for Android CLI installs', async t => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onramp-android-progress-test-')
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = [];
  const stream = {
    isTTY: false,
    write: chunk => {
      output.push(String(chunk));
      return true;
    },
  };
  const installer = [
    "const fs = require('fs');",
    "const path = require('path');",
    'const sdk = process.argv[1];',
    "const archiveRoot = path.join(sdk, '.sdk', 'arch');",
    "const extractRoot = path.join(sdk, '.sdk', 'unzips', 'image');",
    'fs.mkdirSync(archiveRoot, { recursive: true });',
    "console.log('https://dl.google.com/android/repository/image.zip...');",
    'let size = 0;',
    'const timer = setInterval(() => {',
    '  size += 25;',
    "  fs.writeFileSync(path.join(archiveRoot, 'image'), Buffer.alloc(size));",
    '  if (size === 100) {',
    '    clearInterval(timer);',
    '    setTimeout(() => {',
    '      fs.mkdirSync(extractRoot, { recursive: true });',
    "      fs.writeFileSync(path.join(extractRoot, 'system.img'), Buffer.alloc(10));",
    '      setTimeout(() => process.exit(0), 80);',
    '    }, 20);',
    '  }',
    '}, 20);',
  ].join('\n');

  await runAndroidSdkInstall(
    process.execPath,
    ['-e', installer, temporary],
    undefined,
    process.env,
    {
      downloadSizeFn: async () => 100,
      intervalMs: 5,
      sdk: temporary,
      stderr: stream,
      stdout: stream,
    }
  );

  const rendered = output.join('');
  assert.match(rendered, /\[[=-]+\]\s+\d+%/);
  assert.match(rendered, /100% Downloaded; extracting Android SDK package/);
  assert.match(rendered, /Android SDK package installation complete/);
});

test('rejects Android CLI URL and checksum mismatches despite a zero exit', async () => {
  const output = [];
  const stream = {
    isTTY: false,
    write: chunk => {
      output.push(String(chunk));
      return true;
    },
  };
  const installer = [
    "console.error('URL mismatch for emulator: old.zip != native.zip');",
    "console.error('SHA mismatch for emulator: oldsha != nativesha');",
  ].join('\n');

  await assert.rejects(
    runAndroidSdkInstall(
      process.execPath,
      ['-e', installer],
      undefined,
      process.env,
      {
        intervalMs: 5,
        sdk: '/sdk',
        stderr: stream,
        stdout: stream,
      }
    ),
    /installation was rejected:[\s\S]*URL mismatch[\s\S]*SHA mismatch/
  );
  assert.doesNotMatch(
    output.join(''),
    /Android SDK package installation complete/
  );
});

test('selects the newest stable Google APIs image for the host architecture', () => {
  const packages = new Map([
    [
      'system-images;android-35;google_apis;arm64-v8a',
      {
        path: 'system-images;android-35;google_apis;arm64-v8a',
        installedVersion: '9',
      },
    ],
    [
      'system-images;android-36-ext12;google_apis;arm64-v8a',
      {
        path: 'system-images;android-36-ext12;google_apis;arm64-v8a',
        availableVersion: '3',
      },
    ],
    [
      'system-images;android-37;google_apis;x86_64',
      {
        path: 'system-images;android-37;google_apis;x86_64',
        availableVersion: '1',
      },
    ],
    [
      'system-images;android-VanillaIceCream;google_apis;arm64-v8a',
      {
        path: 'system-images;android-VanillaIceCream;google_apis;arm64-v8a',
        availableVersion: '1',
      },
    ],
  ]);

  const selected = preferredAndroidSystemImage(packages, 'arm64-v8a');
  assert.equal(
    selected.packageInfo.path,
    'system-images;android-36-ext12;google_apis;arm64-v8a'
  );
});

test('passes explicit input to native package tools', () => {
  const result = capture(
    process.execPath,
    ['-e', "process.stdin.once('data', value => process.stdout.write(value))"],
    { input: 'no\n' }
  );
  assert.equal(result.stdout, 'no\n');
});

test('offers and installs an available Android Emulator upgrade', async t => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onramp-android-sdk-test-')
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sdk = path.join(temporary, 'sdk');
  const javaHome = path.join(temporary, 'jdk');
  const avdHome = path.join(temporary, 'avd-home');
  const commandExtension = process.platform === 'win32' ? '.bat' : '';
  const emulatorExtension = process.platform === 'win32' ? '.exe' : '';
  const sdkManager = path.join(
    sdk,
    'cmdline-tools',
    'latest',
    'bin',
    'sdkmanager' + commandExtension
  );
  const emulator = path.join(
    sdk,
    'emulator',
    'emulator' + emulatorExtension
  );
  const adb = path.join(
    sdk,
    'platform-tools',
    'adb' + emulatorExtension
  );
  const avd = 'Pixel_API_35';
  const avdDirectory = path.join(avdHome, avd + '.avd');
  const architecture = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const imagePackage = [
    'system-images',
    'android-35',
    'google_apis',
    architecture,
  ].join(';');
  const imageRelative = imagePackage.replaceAll(';', path.sep) + path.sep;
  const imageDirectory = path.join(sdk, imageRelative);

  for (const filePath of [
    sdkManager,
    path.join(path.dirname(sdkManager), 'avdmanager' + commandExtension),
    emulator,
    adb,
    path.join(javaHome, 'bin', 'java' + emulatorExtension),
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
  }
  fs.mkdirSync(imageDirectory, { recursive: true });
  fs.mkdirSync(avdDirectory, { recursive: true });
  fs.mkdirSync(avdHome, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, avd + '.ini'),
    'path=' + avdDirectory + '\n'
  );
  fs.writeFileSync(
    path.join(avdDirectory, 'config.ini'),
    'image.sysdir.1=' + imageRelative + '\n'
  );

  const packageMap = new Map([
    [
      'emulator',
      {
        path: 'emulator',
        installedVersion: '36.2.1',
        availableVersion: '37.1.11',
      },
    ],
    [
      'platform-tools',
      {
        path: 'platform-tools',
        installedVersion: '36.0.0',
        availableVersion: '37.0.0',
      },
    ],
    [
      imagePackage,
      {
        path: imagePackage,
        installedVersion: '10',
      },
    ],
  ]);
  const prompts = [];
  const installs = [];
  const environment = await prepareAndroidEnvironment({
    sdk,
    javaHome,
    env: {
      ANDROID_AVD_HOME: avdHome,
      PATH: '',
    },
    captureFn: (command, args) => {
      if (command === sdkManager && args[0] === '--version') {
        return { status: 0, stdout: '23.0\n', stderr: '' };
      }
      if (command === emulator && args[0] === '-version') {
        return {
          status: 0,
          stdout: 'Android emulator version 36.2.1.0\n',
          stderr: '',
        };
      }
      if (command === emulator && args[0] === '-list-avds') {
        return { status: 0, stdout: avd + '\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    listPackages: () => packageMap,
    installPackages: (_manager, _sdk, _env, selected) => {
      installs.push(selected);
    },
    promptYesNo: async question => {
      prompts.push(question);
      return true;
    },
    log: () => {},
  });

  assert.match(prompts[0], /37\.1\.11.*36\.2\.1.*Upgrade now/);
  assert.deepEqual(installs, [['emulator']]);
  assert.equal(environment.avd, avd);
  assert.equal(
    prompts.some(question => question.includes('Platform-Tools')),
    false
  );
});

test('offers to repair an Android Emulator installed for the wrong Mac architecture', async t => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onramp-android-architecture-test-')
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sdk = path.join(temporary, 'sdk');
  const javaHome = path.join(temporary, 'jdk');
  const avdHome = path.join(temporary, 'avd-home');
  const commandExtension = process.platform === 'win32' ? '.bat' : '';
  const executableExtension = process.platform === 'win32' ? '.exe' : '';
  const sdkManager = path.join(
    sdk,
    'cmdline-tools',
    'latest',
    'bin',
    'sdkmanager' + commandExtension
  );
  const emulator = path.join(
    sdk,
    'emulator',
    'emulator' + executableExtension
  );
  const adb = path.join(
    sdk,
    'platform-tools',
    'adb' + executableExtension
  );
  const java = path.join(
    javaHome,
    'bin',
    'java' + executableExtension
  );
  const avd = 'OnRamp_API_37_1';
  const avdDirectory = path.join(avdHome, avd + '.avd');
  const imagePackage = (
    'system-images;android-37.1;google_apis_ps16k;arm64-v8a'
  );
  const imageRelative = imagePackage.replaceAll(';', path.sep) + path.sep;

  for (const filePath of [
    sdkManager,
    path.join(path.dirname(sdkManager), 'avdmanager' + commandExtension),
    emulator,
    adb,
    java,
  ]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
  }
  fs.mkdirSync(path.join(sdk, imageRelative), { recursive: true });
  fs.mkdirSync(avdDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, avd + '.ini'),
    'path=' + avdDirectory + '\n'
  );
  fs.writeFileSync(
    path.join(avdDirectory, 'config.ini'),
    'image.sysdir.1=' + imageRelative + '\n'
  );

  const packageMap = new Map([
    [
      'emulator',
      {
        path: 'emulator',
        installedVersion: '37.1.11',
        availableVersion: '37.1.11',
      },
    ],
    [
      'platform-tools',
      { path: 'platform-tools', installedVersion: '37.0.1' },
    ],
    [
      imagePackage,
      { path: imagePackage, installedVersion: '8.0.0' },
    ],
  ]);
  const prompts = [];
  const installs = [];
  const removals = [];
  const operations = [];
  let inspections = 0;

  const environment = await prepareAndroidEnvironment({
    architecture: 'arm64',
    sdk,
    javaHome,
    platform: 'darwin',
    env: { ANDROID_AVD_HOME: avdHome, PATH: '' },
    captureFn: (command, args) => {
      if (command === sdkManager && args[0] === '--version') {
        return { status: 0, stdout: '23.0\n', stderr: '' };
      }
      if (command === emulator && args[0] === '-version') {
        return {
          status: 0,
          stdout: 'Android emulator version 37.1.11.0\n',
          stderr: '',
        };
      }
      if (command === emulator && args[0] === '-list-avds') {
        return { status: 0, stdout: avd + '\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    emulatorArchitectureMismatch: () => {
      inspections += 1;
      return inspections === 1
        ? { expected: 'arm64', installed: ['x86_64'] }
        : null;
    },
    installPackages: async (...args) => {
      operations.push('install');
      installs.push(args);
    },
    listPackages: () => packageMap,
    log: () => {},
    promptYesNo: async question => {
      prompts.push(question);
      return true;
    },
    removePackages: async (...args) => {
      operations.push('remove');
      removals.push(args);
    },
  });

  assert.match(
    prompts[0],
    /installed for x86_64.*requires arm64.*Reinstall version 37\.1\.11/
  );
  assert.deepEqual(operations, ['remove', 'install']);
  assert.deepEqual(removals[0][3], ['emulator']);
  assert.deepEqual(removals[0][5], { platform: 'darwin' });
  assert.deepEqual(installs[0][3], ['emulator']);
  assert.deepEqual(installs[0][5], {
    architecture: 'arm64',
    platform: 'darwin',
  });
  assert.equal(inspections, 2);
  assert.equal(environment.avd, avd);
});

test('offers to install a missing Android emulator, image, and AVD', async t => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onramp-android-install-test-')
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const sdk = path.join(temporary, 'sdk');
  const javaHome = path.join(temporary, 'jdk');
  const avdHome = path.join(temporary, 'avd-home');
  const commandExtension = process.platform === 'win32' ? '.bat' : '';
  const executableExtension = process.platform === 'win32' ? '.exe' : '';
  const sdkManager = path.join(
    sdk,
    'cmdline-tools',
    'latest',
    'bin',
    'sdkmanager' + commandExtension
  );
  const avdManager = path.join(
    path.dirname(sdkManager),
    'avdmanager' + commandExtension
  );
  const emulator = path.join(
    sdk,
    'emulator',
    'emulator' + executableExtension
  );
  const adb = path.join(
    sdk,
    'platform-tools',
    'adb' + executableExtension
  );
  const java = path.join(
    javaHome,
    'bin',
    'java' + executableExtension
  );
  const architecture = os.arch() === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const imagePackage = [
    'system-images',
    'android-36',
    'google_apis',
    architecture,
  ].join(';');
  const imageRelative = imagePackage.replaceAll(';', path.sep) + path.sep;
  const avdName = 'OnRamp_API_36';
  let emulatorInstalled = false;
  let imageInstalled = false;
  let avdCreated = false;
  const installs = [];
  const prompts = [];

  for (const filePath of [sdkManager, avdManager, java]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '');
  }
  fs.mkdirSync(avdHome, { recursive: true });

  const currentPackages = () => new Map([
    [
      'emulator',
      {
        path: 'emulator',
        installedVersion: emulatorInstalled ? '37.1.11' : null,
        availableVersion: '37.1.11',
      },
    ],
    [
      'platform-tools',
      {
        path: 'platform-tools',
        installedVersion: emulatorInstalled ? '37.0.0' : null,
        availableVersion: '37.0.0',
      },
    ],
    [
      imagePackage,
      {
        path: imagePackage,
        installedVersion: imageInstalled ? '10' : null,
        availableVersion: '10',
      },
    ],
  ]);

  const environment = await prepareAndroidEnvironment({
    sdk,
    javaHome,
    env: {
      ANDROID_AVD_HOME: avdHome,
      PATH: '',
    },
    captureFn: (command, args, options = {}) => {
      if (command === sdkManager && args[0] === '--version') {
        return { status: 0, stdout: '23.0\n', stderr: '' };
      }
      if (command === emulator && args[0] === '-version') {
        return {
          status: 0,
          stdout: 'Android emulator version 37.1.11.0\n',
          stderr: '',
        };
      }
      if (command === emulator && args[0] === '-list-avds') {
        return {
          status: 0,
          stdout: avdCreated ? avdName + '\n' : '',
          stderr: '',
        };
      }
      if (command === avdManager && args[0] === 'create') {
        assert.equal(options.input, 'no\n');
        const avdDirectory = path.join(avdHome, avdName + '.avd');
        fs.mkdirSync(avdDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(avdHome, avdName + '.ini'),
          'path=' + avdDirectory + '\n'
        );
        fs.writeFileSync(
          path.join(avdDirectory, 'config.ini'),
          'image.sysdir.1=' + imageRelative + '\n'
        );
        avdCreated = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    listPackages: currentPackages,
    installPackages: async (_manager, _sdk, _env, selected) => {
      installs.push(selected);
      await new Promise(resolve => setImmediate(resolve));
      if (selected.includes('emulator')) {
        for (const filePath of [emulator, adb]) {
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, '');
        }
        emulatorInstalled = true;
      }
      if (selected.includes(imagePackage)) {
        fs.mkdirSync(path.join(sdk, imageRelative), { recursive: true });
        imageInstalled = true;
      }
    },
    promptYesNo: async question => {
      prompts.push(question);
      return true;
    },
    log: () => {},
  });

  assert.match(prompts[0], /Android Emulator is not installed.*37\.1\.11/);
  assert.match(prompts[1], /No usable Android virtual device.*API 36/);
  assert.deepEqual(installs, [
    ['emulator', 'platform-tools'],
    [imagePackage],
  ]);
  assert.equal(environment.avd, avdName);
});
