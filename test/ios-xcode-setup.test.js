const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  doctorIos,
  ensureXcodeSetup,
  resolveSelectedDeveloperDir,
} = require('../src/ios');

const LICENSE_MESSAGE = [
  'You have not agreed to the Xcode license agreements.',
  "Please run 'sudo xcodebuild -license' from within a Terminal window.",
].join(' ');

function commandResult(status = 0, stderr = '', stdout = '') {
  return { status, stderr, stdout };
}

function xcodeSetupFixture({
  developerDirOverride = false,
  licenseAccepted = true,
  firstLaunchComplete = true,
  sdkFailure = null,
} = {}) {
  const developerDir = '/Applications/Xcode Beta.app/Contents/Developer';
  const state = { firstLaunchComplete, licenseAccepted, sdkFailure };
  const captures = [];
  const prompts = [];
  const runs = [];
  const environment = {
    developerDir,
    developerDirOverride,
    env: developerDirOverride ? { DEVELOPER_DIR: developerDir } : {},
    pod: '/opt/homebrew/bin/pod',
    xcodebuild: '/usr/bin/xcodebuild',
    xcrun: '/usr/bin/xcrun',
  };
  const captureCommand = (command, args, options) => {
    captures.push({ args, command, options });
    assert.strictEqual(options.env, environment.env);
    if (args[0] === '-showsdks') {
      if (!state.licenseAccepted) {
        return commandResult(69, LICENSE_MESSAGE);
      }
      if (state.sdkFailure) {
        return commandResult(69, state.sdkFailure);
      }
      return commandResult(0, '', 'iOS SDKs');
    }
    if (args[0] === '-checkFirstLaunchStatus') {
      return commandResult(
        state.licenseAccepted && state.firstLaunchComplete ? 0 : 69
      );
    }
    if (args[0] === '--version') {
      return commandResult(0, '', '1.16.2');
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  const promptYesNo = async question => {
    prompts.push(question);
    return true;
  };
  const runCommand = (command, args, cwd, env, options) => {
    runs.push({ args, command, cwd, env, options });
    assert.notStrictEqual(env, environment.env);
    assert.deepEqual(env, {});
    assert.deepEqual(
      options,
      args.at(-1) === '-license'
        ? { inheritInput: true }
        : {
          activityLabel: 'Xcode is still completing first-launch setup',
          inheritInput: true,
        }
    );
    if (args.at(-1) === '-license') {
      state.licenseAccepted = true;
    }
    if (args.at(-1) === '-runFirstLaunch') {
      state.firstLaunchComplete = true;
    }
  };
  return {
    captureCommand,
    captures,
    environment,
    promptYesNo,
    prompts,
    runCommand,
    runs,
    state,
  };
}

test('ready Xcode setup does not prompt or run a privileged command', async () => {
  const fixture = xcodeSetupFixture();

  await ensureXcodeSetup(fixture.environment, {
    captureCommand: fixture.captureCommand,
    log: () => {},
    promptYesNo: async () => assert.fail('ready setup must not prompt'),
    runCommand: () => assert.fail('ready setup must not run sudo'),
  });

  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks']
  );
});

test('license review and first-launch setup are separate interactive steps', async () => {
  const fixture = xcodeSetupFixture({
    licenseAccepted: false,
    firstLaunchComplete: false,
  });

  await ensureXcodeSetup(fixture.environment, {
    captureCommand: fixture.captureCommand,
    log: () => {},
    promptYesNo: fixture.promptYesNo,
    runCommand: fixture.runCommand,
  });

  assert.equal(fixture.prompts.length, 2);
  assert.match(fixture.prompts[0], /interactive license review/);
  assert.match(fixture.prompts[1], /first-launch components/);
  assert.deepEqual(
    fixture.runs.map(call => [call.command, call.args]),
    [
      [
        '/usr/bin/sudo',
        [
          '/usr/bin/xcodebuild',
          '-license',
        ],
      ],
      [
        '/usr/bin/sudo',
        [
          '/usr/bin/xcodebuild',
          '-runFirstLaunch',
        ],
      ],
    ]
  );
  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    [
      '-checkFirstLaunchStatus',
      '-showsdks',
      '-showsdks',
      '-checkFirstLaunchStatus',
      '-checkFirstLaunchStatus',
      '-showsdks',
    ]
  );
});

test('declining license review gives the exact manual command even with force', async () => {
  const fixture = xcodeSetupFixture({ licenseAccepted: false });

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      forceEmulatorUpdates: true,
      log: () => {},
      promptYesNo: async () => false,
      runCommand: fixture.runCommand,
    }),
    error => {
      assert.match(error.message, /Xcode license review is required/);
      assert.match(
        error.message,
        /sudo \/usr\/bin\/xcodebuild -license/
      );
      return true;
    }
  );

  assert.equal(fixture.runs.length, 0);
  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks']
  );
});

test('noninteractive license review fails without trying sudo', async () => {
  const fixture = xcodeSetupFixture({ licenseAccepted: false });

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      input: { isTTY: false },
      log: () => {},
      runCommand: fixture.runCommand,
    }),
    /Run `sudo .*\/usr\/bin\/xcodebuild -license` in an interactive Terminal/
  );

  assert.equal(fixture.runs.length, 0);
});

test('a non-license Xcode status 69 never triggers license consent', async () => {
  const fixture = xcodeSetupFixture({
    firstLaunchComplete: false,
    sdkFailure: 'xcodebuild: error: unrelated SDK discovery failure',
  });

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      log: () => {},
      promptYesNo: async () => assert.fail('generic errors must not prompt'),
      runCommand: () => assert.fail('generic errors must not run sudo'),
    }),
    /-showsdks exited with status 69.*unrelated SDK discovery failure/
  );

  assert.equal(fixture.runs.length, 0);
  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks']
  );
});

test('an interrupted license review stops before first-launch setup', async () => {
  const fixture = xcodeSetupFixture({
    licenseAccepted: false,
    firstLaunchComplete: false,
  });
  fixture.runCommand = async (...args) => {
    fixture.runs.push(args);
    throw new Error('operator exited the review');
  };

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      log: () => {},
      promptYesNo: fixture.promptYesNo,
      runCommand: fixture.runCommand,
    }),
    /license review did not complete.*operator exited the review/
  );

  assert.equal(fixture.runs.length, 1);
  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks']
  );
});

test('first-launch setup must pass its status recheck', async () => {
  const fixture = xcodeSetupFixture({ firstLaunchComplete: false });
  fixture.runCommand = (command, args, cwd, env, options) => {
    fixture.runs.push({ args, command, cwd, env, options });
  };

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      log: () => {},
      promptYesNo: fixture.promptYesNo,
      runCommand: fixture.runCommand,
    }),
    /first-launch setup is still incomplete.*-runFirstLaunch/
  );

  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks', '-checkFirstLaunchStatus']
  );
});

test('doctor reports setup without prompting or running privileged commands', () => {
  const fixture = xcodeSetupFixture();

  assert.strictEqual(
    doctorIos({
      captureCommand: fixture.captureCommand,
      inspectEnvironment: () => fixture.environment,
      log: () => {},
    }),
    fixture.environment
  );
  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks', '--version']
  );
  assert.equal(fixture.runs.length, 0);
});

test('doctor never recommends first-launch setup while license state is ambiguous', () => {
  const fixture = xcodeSetupFixture({
    firstLaunchComplete: false,
    sdkFailure: 'xcodebuild: error: unrelated SDK discovery failure',
  });

  assert.throws(
    () => doctorIos({
      captureCommand: fixture.captureCommand,
      inspectEnvironment: () => fixture.environment,
      log: () => {},
    }),
    /-showsdks exited with status 69.*unrelated SDK discovery failure/
  );
  assert.equal(fixture.runs.length, 0);
});

test('selected DEVELOPER_DIR is validated from xcrun before privileged setup', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-xcode-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const developerDir = path.join(
    temporary,
    'Xcode Beta.app',
    'Contents',
    'Developer'
  );
  fs.mkdirSync(developerDir, { recursive: true });
  const env = { DEVELOPER_DIR: developerDir };
  const calls = [];

  const selected = resolveSelectedDeveloperDir(
    '/usr/bin/xcrun',
    env,
    (command, args, options) => {
      calls.push({ args, command, options });
      return commandResult(
        0,
        '',
        `${path.join(developerDir, 'usr', 'bin', 'xcodebuild')}\n`
      );
    }
  );

  assert.equal(selected, fs.realpathSync(developerDir));
  assert.deepEqual(calls, [{
    args: ['--find', 'xcodebuild'],
    command: '/usr/bin/xcrun',
    options: { check: false, env },
  }]);
});

test('selected DEVELOPER_DIR is canonicalized before it is reported', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'onramp-xcode-link-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const developerDir = path.join(
    temporary,
    'Xcode.app',
    'Contents',
    'Developer'
  );
  const linkedDeveloperDir = path.join(temporary, 'SelectedDeveloper');
  fs.mkdirSync(developerDir, { recursive: true });
  fs.symlinkSync(developerDir, linkedDeveloperDir);
  const env = { DEVELOPER_DIR: linkedDeveloperDir };

  const selected = resolveSelectedDeveloperDir(
    '/usr/bin/xcrun',
    env,
    () => commandResult(
      0,
      '',
      `${path.join(linkedDeveloperDir, 'usr', 'bin', 'xcodebuild')}\n`
    )
  );

  assert.equal(selected, fs.realpathSync(developerDir));
});

test('an explicit DEVELOPER_DIR is never passed through sudo automatically', async () => {
  const fixture = xcodeSetupFixture({
    developerDirOverride: true,
    licenseAccepted: false,
  });

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      log: () => {},
      promptYesNo: async () => assert.fail('unsafe setup must not prompt'),
      runCommand: () => assert.fail('unsafe setup must not run sudo'),
    }),
    error => {
      assert.match(error.message, /DEVELOPER_DIR is explicitly set/);
      assert.match(error.message, /will not pass a user-selected developer directory through sudo/);
      assert.match(
        error.message,
        /sudo \/usr\/bin\/env 'DEVELOPER_DIR=\/Applications\/Xcode Beta\.app\/Contents\/Developer' \/usr\/bin\/xcodebuild -license/
      );
      return true;
    }
  );

  assert.equal(fixture.runs.length, 0);
  assert.deepEqual(
    fixture.captures.map(call => call.args.join(' ')),
    ['-checkFirstLaunchStatus', '-showsdks']
  );
});

test('DEVELOPER_DIR is rechecked after approval and before sudo', async () => {
  const fixture = xcodeSetupFixture({ licenseAccepted: false });

  await assert.rejects(
    ensureXcodeSetup(fixture.environment, {
      captureCommand: fixture.captureCommand,
      log: () => {},
      promptYesNo: async () => {
        fixture.environment.env.DEVELOPER_DIR = fixture.environment.developerDir;
        return true;
      },
      runCommand: () => assert.fail('changed selection must not run sudo'),
    }),
    /will not pass a user-selected developer directory through sudo/
  );

  assert.equal(fixture.runs.length, 0);
});
