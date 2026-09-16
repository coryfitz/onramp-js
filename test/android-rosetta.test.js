const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  androidRepositoryHost,
  bootstrapAndroidCommandLineTools,
  inspectAndroidSdkManager,
} = require('../src/android-sdk');
const {
  installAndroidRosetta,
  prepareAndroidEnvironment,
} = require('../src/android');

function commandResult(status = 0, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function managerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-rosetta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk');
  const bin = path.join(sdk, 'cmdline-tools', 'onramp-23.0', 'bin');
  const sdkManager = path.join(bin, 'sdkmanager');
  const androidCli = path.join(bin, 'android');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(sdkManager, 'fixture');
  fs.writeFileSync(androidCli, 'fixture');
  return { androidCli, root, sdk, sdkManager };
}

test('detects an Intel Android CLI that cannot execute without Rosetta', t => {
  const fixture = managerFixture(t);
  const inspection = inspectAndroidSdkManager(
    fixture.sdkManager,
    fixture.sdk,
    {},
    (command, args) => {
      if (command === fixture.androidCli && args[0] === '--version') {
        throw new Error('spawnSync android Unknown system error -86');
      }
      if (command === '/usr/bin/file') {
        return commandResult(
          0,
          fixture.androidCli + ': Mach-O 64-bit executable x86_64\n'
        );
      }
      if (command === '/usr/bin/arch') {
        return commandResult(1, '', 'Bad CPU type in executable');
      }
      assert.fail(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    {
      architecture: 'arm64',
      pathExists: () => true,
      platform: 'darwin',
    }
  );

  assert.equal(inspection.usable, false);
  assert.equal(inspection.requiresRosetta, true);
});

test('does not misdiagnose an unrelated Android CLI failure as Rosetta', t => {
  const fixture = managerFixture(t);
  const inspection = inspectAndroidSdkManager(
    fixture.sdkManager,
    fixture.sdk,
    {},
    command => {
      if (command === fixture.androidCli) {
        return commandResult(1, '', 'permission denied');
      }
      if (command === '/usr/bin/file') {
        return commandResult(
          0,
          fixture.androidCli + ': Mach-O 64-bit executable x86_64\n'
        );
      }
      assert.fail(`Unexpected command: ${command}`);
    },
    {
      architecture: 'arm64',
      pathExists: () => true,
      platform: 'darwin',
    }
  );

  assert.equal(inspection.usable, false);
  assert.equal(inspection.requiresRosetta, false);
});

test('installs Rosetta through fixed Apple binaries with inherited input', async () => {
  const calls = [];
  await installAndroidRosetta(
    { PATH: '/untrusted' },
    async (...args) => calls.push(args)
  );

  assert.deepEqual(calls, [[
    '/usr/bin/sudo',
    [
      '/usr/sbin/softwareupdate',
      '--install-rosetta',
      '--agree-to-license',
    ],
    undefined,
    { PATH: '/untrusted' },
    {
      activityLabel: 'Rosetta 2 is still installing',
      inheritInput: true,
    },
  ]]);
});

test('newly downloaded tools validate the sibling Android CLI itself', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-rosetta-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk');
  const archiveContents = Buffer.from('fixture archive');
  const checksum = crypto.createHash('sha1')
    .update(archiveContents)
    .digest('hex');
  const repository = '<remotePackage path="cmdline-tools;latest">'
    + '<revision><major>23</major><minor>0</minor></revision>'
    + '<archives><archive><complete><size>15</size><checksum>' + checksum
    + '</checksum><url>tools.zip</url></complete><host-os>'
    + androidRepositoryHost() + '</host-os></archive></archives></remotePackage>';

  await assert.rejects(
    bootstrapAndroidCommandLineTools({
      sdk,
      env: { PATH: '' },
      architecture: 'arm64',
      platform: 'darwin',
      pathExists: () => true,
      promptYesNo: async () => true,
      fetchFn: async () => ({ ok: true, text: async () => repository }),
      downloadFn: async (_url, destination) => {
        fs.writeFileSync(destination, archiveContents);
      },
      extractFn: (_archive, extracted) => {
        const bin = path.join(extracted, 'cmdline-tools', 'bin');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'sdkmanager'), 'fixture');
        fs.writeFileSync(path.join(bin, 'android'), 'fixture');
      },
      captureFn: (command, args) => {
        if (path.basename(command) === 'android' && args[0] === '--version') {
          throw new Error('spawnSync android Unknown system error -86');
        }
        if (command === '/usr/bin/file') {
          return commandResult(0, 'Mach-O 64-bit executable x86_64\n');
        }
        if (command === '/usr/bin/arch') {
          return commandResult(1, '', 'Bad CPU type in executable');
        }
        assert.fail(`Unexpected command: ${command} ${args.join(' ')}`);
      },
      log: () => {},
    }),
    /Downloaded Google Android command-line tools require Rosetta 2/
  );
});

function developmentFixture(t) {
  const fixture = managerFixture(t);
  const javaHome = path.join(fixture.root, 'jdk');
  const avdHome = path.join(fixture.root, 'avds');
  const emulator = path.join(fixture.sdk, 'emulator', 'emulator');
  const adb = path.join(fixture.sdk, 'platform-tools', 'adb');
  const avdManager = path.join(path.dirname(fixture.sdkManager), 'avdmanager');
  const java = path.join(javaHome, 'bin', 'java');
  const avd = 'OnRamp_API_37';
  const imagePackage = 'system-images;android-37;google_apis;arm64-v8a';
  const imageRelative = imagePackage.replaceAll(';', path.sep) + path.sep;
  const avdDirectory = path.join(avdHome, avd + '.avd');
  for (const file of [emulator, adb, avdManager, java]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  fs.mkdirSync(path.join(fixture.sdk, imageRelative), { recursive: true });
  fs.mkdirSync(avdDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, avd + '.ini'),
    'path=' + avdDirectory + '\n'
  );
  fs.writeFileSync(
    path.join(avdDirectory, 'config.ini'),
    'image.sysdir.1=' + imageRelative + '\n'
      + 'hw.lcd.width=1080\n'
      + 'hw.lcd.height=2400\n'
      + 'hw.lcd.density=420\n'
  );

  let rosettaInstalled = false;
  let cliChecks = 0;
  const prompts = [];
  const logs = [];
  const options = {
    architecture: 'arm64',
    platform: 'darwin',
    sdk: fixture.sdk,
    javaHome,
    env: { ANDROID_AVD_HOME: avdHome, PATH: '' },
    pathExists: () => true,
    rosettaAvailableFn: () => rosettaInstalled,
    emulatorArchitectureMismatch: () => null,
    cleanupSystemImages: async () => {},
    listPackages: () => new Map([
      ['emulator', {
        path: 'emulator',
        installedVersion: '37.1.11',
      }],
      ['platform-tools', {
        path: 'platform-tools',
        installedVersion: '37.0.0',
      }],
      [imagePackage, {
        path: imagePackage,
        installedVersion: '1',
      }],
    ]),
    captureFn: (command, args) => {
      if (command === fixture.androidCli && args[0] === '--version') {
        cliChecks += 1;
        if (!rosettaInstalled) {
          throw new Error('spawnSync android Unknown system error -86');
        }
        return commandResult(0, '1.0\n');
      }
      if (command === '/usr/bin/file') {
        return commandResult(
          0,
          fixture.androidCli + ': Mach-O 64-bit executable x86_64\n'
        );
      }
      if (command === fixture.sdkManager && args[0] === '--version') {
        assert.equal(rosettaInstalled, true);
        return commandResult(0, '23.0 (Android CLI)\n');
      }
      if (command === emulator && args[0] === '-version') {
        return commandResult(0, 'Android emulator version 37.1.11.0\n');
      }
      if (command === emulator && args[0] === '-list-avds') {
        return commandResult(0, avd + '\n');
      }
      if (command === adb && args[0] === 'devices') {
        return commandResult(0, 'List of devices attached\n');
      }
      assert.fail(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    promptYesNo: async question => {
      prompts.push(question);
      return true;
    },
    installRosetta: async () => {
      rosettaInstalled = true;
    },
    log: message => logs.push(message),
  };
  return {
    ...fixture,
    avd,
    get cliChecks() { return cliChecks; },
    get rosettaInstalled() { return rosettaInstalled; },
    set rosettaInstalled(value) { rosettaInstalled = value; },
    logs,
    options,
    prompts,
  };
}

test('prompts for Rosetta, installs it, and rechecks the exact Android CLI', async t => {
  const fixture = developmentFixture(t);
  const environment = await prepareAndroidEnvironment(fixture.options);

  assert.equal(fixture.rosettaInstalled, true);
  assert.equal(environment.avd, fixture.avd);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0], /accepts Apple.*license/i);
  assert.ok(fixture.cliChecks >= 3, 'the Android CLI should be checked again');
  assert.ok(fixture.logs.some(line => /Rosetta 2 is installed.*tools are ready/.test(line)));
});

test('--force never accepts Rosetta and a complete SDK remains usable after decline', async t => {
  const fixture = developmentFixture(t);
  let installCalls = 0;
  fixture.options.forceEmulatorUpdates = true;
  fixture.options.promptYesNo = async question => {
    fixture.prompts.push(question);
    return false;
  };
  fixture.options.installRosetta = async () => {
    installCalls += 1;
  };

  const environment = await prepareAndroidEnvironment(fixture.options);

  assert.equal(environment.avd, fixture.avd);
  assert.equal(installCalls, 0);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0], /Rosetta 2/);
  assert.ok(fixture.logs.some(line => /package update checks are unavailable/.test(line)));
});

test('declining Rosetta fails actionably when Android components are missing', async t => {
  const fixture = developmentFixture(t);
  fs.unlinkSync(path.join(fixture.sdk, 'emulator', 'emulator'));
  fixture.options.promptYesNo = async question => {
    fixture.prompts.push(question);
    return false;
  };

  await assert.rejects(
    prepareAndroidEnvironment(fixture.options),
    /package management is required.*install it manually.*softwareupdate/s
  );
});
