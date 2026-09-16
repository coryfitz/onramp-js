const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  ensureAndroidEmulator,
  ensureOnRampAndroidAvdHostKeyboard,
} = require('../src/android');

function managedAvdFixture(t, options = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'onramp-android-keyboard-test-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'sdk');
  const avdHome = path.join(root, 'avd');
  const avd = options.avd || 'OnRamp_API_37_1';
  const directory = path.join(avdHome, `${avd}.avd`);
  const configPath = path.join(directory, 'config.ini');
  const imageRelative = [
    'system-images',
    'android-37.1',
    'google_apis',
    'arm64-v8a',
    '',
  ].join(path.sep);
  const imageDirectory = path.join(sdk, imageRelative);
  fs.mkdirSync(imageDirectory, { recursive: true });
  fs.writeFileSync(path.join(imageDirectory, 'system.img'), 'fixture image');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(avdHome, `${avd}.ini`),
    [
      'avd.ini.encoding=UTF-8',
      `path=${directory}`,
      `path.rel=${path.relative(path.dirname(avdHome), directory)}`,
      'target=android-37.1',
      '',
    ].join('\n')
  );
  const keyboard = options.keyboard === undefined
    ? 'hw.keyboard=no\n'
    : options.keyboard === null
      ? ''
      : `hw.keyboard=${options.keyboard}\n`;
  fs.writeFileSync(
    configPath,
    `image.sysdir.1=${imageRelative}\n`
    + 'hw.lcd.width=1080\n'
    + 'hw.lcd.height=2424\n'
    + 'hw.lcd.density=420\n'
    + keyboard
    + (options.extraConfig || '')
  );
  fs.writeFileSync(path.join(directory, 'user-data-marker'), 'preserve me');
  return {
    configPath,
    directory,
    environment: {
      adb: path.join(sdk, 'platform-tools', 'adb'),
      avd,
      emulator: path.join(sdk, 'emulator', 'emulator'),
      env: { ANDROID_AVD_HOME: avdHome, ANDROID_HOME: sdk },
      sdk,
    },
  };
}

function stoppedInventory() {
  return {
    status: 0,
    stderr: '',
    stdout: 'List of devices attached\n',
  };
}

function emulatorChild() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};
  return child;
}

test('enables host keyboard input for a stopped canonical OnRamp AVD', t => {
  const fixture = managedAvdFixture(t);
  if (process.platform !== 'win32') {
    fs.chmodSync(fixture.configPath, 0o640);
  }
  const result = ensureOnRampAndroidAvdHostKeyboard(fixture.environment, {
    captureFn: stoppedInventory,
  });

  assert.equal(result.changed, true);
  assert.match(fs.readFileSync(fixture.configPath, 'utf8'), /^hw\.keyboard=yes$/m);
  assert.equal(
    fs.readFileSync(path.join(fixture.directory, 'user-data-marker'), 'utf8'),
    'preserve me'
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(fixture.configPath).mode & 0o777, 0o640);
  }
  assert.deepEqual(
    fs.readdirSync(fixture.directory).filter(name => name.includes('.onramp-')),
    []
  );
  const second = ensureOnRampAndroidAvdHostKeyboard(fixture.environment);
  assert.equal(second.needsChange, false);
  assert.equal(Boolean(second.changed), false);
});

test('adds a missing host keyboard setting to a canonical OnRamp AVD', t => {
  const fixture = managedAvdFixture(t, { keyboard: null });

  ensureOnRampAndroidAvdHostKeyboard(fixture.environment, {
    captureFn: stoppedInventory,
  });

  const contents = fs.readFileSync(fixture.configPath, 'utf8');
  assert.equal(contents.match(/^hw\.keyboard=yes$/gm).length, 1);
  assert.ok(contents.endsWith('\n'));
});

test('never changes an arbitrarily named user AVD', t => {
  const fixture = managedAvdFixture(t, {
    avd: 'Personal_Pixel_API_37',
  });
  const before = fs.readFileSync(fixture.configPath, 'utf8');

  const result = ensureOnRampAndroidAvdHostKeyboard(fixture.environment);

  assert.equal(result.managed, false);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('gives manual keyboard guidance for a selected noncanonical AVD', async t => {
  const fixture = managedAvdFixture(t, {
    avd: 'Personal_Pixel_API_37',
  });
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const logs = [];

  const serial = await ensureAndroidEmulator(fixture.environment, {
    activateFn: () => true,
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        return {
          status: 0,
          stderr: '',
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        };
      }
      return {
        status: 0,
        stderr: '',
        stdout: `${fixture.environment.avd}\nOK\n`,
      };
    },
    log: message => logs.push(message),
  });

  assert.equal(serial, 'emulator-5554');
  assert.match(logs.join('\n'), /outside OnRamp's reserved OnRamp_API_\*/);
  assert.match(logs.join('\n'), /Enable hardware keyboard input/);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('fails closed for ambiguous or malformed managed AVD configuration', async t => {
  await t.test('duplicate keyboard keys', subtest => {
    const fixture = managedAvdFixture(subtest, {
      extraConfig: 'hw.keyboard=yes\n',
    });
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    assert.throws(
      () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment),
      /metadata is ambiguous/
    );
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  });

  await t.test('malformed keyboard value', subtest => {
    const fixture = managedAvdFixture(subtest, { keyboard: 'maybe' });
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    assert.throws(
      () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment),
      /malformed hw\.keyboard setting/
    );
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  });

  await t.test('linked configuration file', subtest => {
    if (process.platform === 'win32') {
      subtest.skip('File symlink creation is not reliably available on Windows CI.');
      return;
    }
    const fixture = managedAvdFixture(subtest);
    const external = path.join(path.dirname(fixture.directory), 'external.ini');
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    fs.renameSync(fixture.configPath, external);
    fs.symlinkSync(external, fixture.configPath);
    assert.throws(
      () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment),
      /could not be safely verified as OnRamp-owned/
    );
    assert.equal(fs.readFileSync(external, 'utf8'), before);
  });
});

test('restarts a running managed AVD before changing its keyboard hardware', async t => {
  const fixture = managedAvdFixture(t);
  fs.writeFileSync(
    path.join(fixture.directory, 'hardware-qemu.ini.lock'),
    '43210\0'
  );
  fs.writeFileSync(path.join(fixture.directory, 'multiinstance.lock'), '');
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.unref = () => {};
  const operations = [];
  let running = true;
  let restarted = false;

  const serial = await ensureAndroidEmulator(fixture.environment, {
    activateFn: () => true,
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        return {
          status: 0,
          stderr: '',
          stdout: running || restarted
            ? 'List of devices attached\nemulator-5554\tdevice\n'
            : 'List of devices attached\n',
        };
      }
      if (args.at(-1) === 'kill') {
        operations.push('kill');
        assert.match(
          fs.readFileSync(fixture.configPath, 'utf8'),
          /^hw\.keyboard=no$/m
        );
        running = false;
        fs.unlinkSync(
          path.join(fixture.directory, 'hardware-qemu.ini.lock')
        );
        return { status: 0, stderr: '', stdout: 'OK\n' };
      }
      if (args.includes('emu')) {
        return {
          status: 0,
          stderr: '',
          stdout: `${fixture.environment.avd}\nOK\n`,
        };
      }
      if (args.includes('sys.boot_completed')) {
        return { status: 0, stderr: '', stdout: '1\n' };
      }
      throw new Error(`Unexpected adb command: ${args.join(' ')}`);
    },
    delay: async () => {},
    log: () => {},
    processIdFn: () => 43210,
    processStateFn: () => running ? 'alive' : 'dead',
    spawnFn: (_command, args) => {
      operations.push('spawn');
      assert.match(
        fs.readFileSync(fixture.configPath, 'utf8'),
        /^hw\.keyboard=yes$/m
      );
      assert.equal(args.includes('-wipe-data'), false);
      restarted = true;
      return child;
    },
  });

  assert.equal(serial, 'emulator-5554');
  assert.deepEqual(operations, ['kill', 'spawn']);
  assert.equal(
    fs.readFileSync(path.join(fixture.directory, 'user-data-marker'), 'utf8'),
    'preserve me'
  );
  assert.equal(
    fs.existsSync(path.join(fixture.directory, 'multiinstance.lock')),
    true
  );
});

test('does not infer a dead owner from a stopped AVD companion lock', t => {
  const fixture = managedAvdFixture(t);
  const companionLock = path.join(fixture.directory, 'multiinstance.lock');
  fs.writeFileSync(companionLock, '');
  const before = fs.readFileSync(fixture.configPath, 'utf8');

  assert.throws(
    () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment, {
      captureFn: stoppedInventory,
    }),
    /uncertain leftover emulator lock.*Close that exact device/s
  );

  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.equal(fs.existsSync(companionLock), true);
  assert.equal(fs.statSync(companionLock).size, 0);
});

test('aborts a keyboard update when the selected AVD appears before rename', t => {
  const fixture = managedAvdFixture(t);
  let inventories = 0;
  const before = fs.readFileSync(fixture.configPath, 'utf8');

  assert.throws(
    () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment, {
      captureFn: (_command, args) => {
        if (args[0] === 'devices') {
          inventories += 1;
          return inventories === 1
            ? {
              status: 0,
              stderr: '',
              stdout: 'List of devices attached\n',
            }
            : {
              status: 0,
              stderr: '',
              stdout: 'List of devices attached\nemulator-5554\tdevice\n',
            };
        }
        assert.deepEqual(args, [
          '-s',
          'emulator-5554',
          'emu',
          'avd',
          'name',
        ]);
        return {
          status: 0,
          stderr: '',
          stdout: `${fixture.environment.avd}\nOK\n`,
        };
      },
    }),
    /became active before it could be updated/
  );
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.deepEqual(
    fs.readdirSync(fixture.directory).filter(name => name.includes('.onramp-')),
    []
  );
});

test('recovers a persistent companion lock through one exact verified shutdown', async t => {
  const fixture = managedAvdFixture(t);
  const companionLock = path.join(fixture.directory, 'multiinstance.lock');
  const hardwareLock = path.join(fixture.directory, 'hardware-qemu.ini.lock');
  fs.writeFileSync(companionLock, '');
  const operations = [];
  let running = false;

  const serial = await ensureAndroidEmulator(fixture.environment, {
    activateFn: () => true,
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        return running
          ? {
            status: 0,
            stderr: '',
            stdout: 'List of devices attached\nemulator-5554\tdevice\n',
          }
          : stoppedInventory();
      }
      if (args.at(-1) === 'kill') {
        operations.push('kill');
        running = false;
        fs.unlinkSync(hardwareLock);
        return { status: 0, stderr: '', stdout: 'OK\n' };
      }
      if (args.includes('emu')) {
        return {
          status: 0,
          stderr: '',
          stdout: `${fixture.environment.avd}\nOK\n`,
        };
      }
      if (args.includes('sys.boot_completed')) {
        return { status: 0, stderr: '', stdout: '1\n' };
      }
      throw new Error(`Unexpected adb command: ${args.join(' ')}`);
    },
    delay: async () => {},
    log: () => {},
    processIdFn: () => 43210,
    processStateFn: () => running ? 'alive' : 'dead',
    spawnFn: (_command, args) => {
      operations.push('spawn');
      assert.equal(args.includes('-wipe-data'), false);
      if (operations.length === 1) {
        assert.match(
          fs.readFileSync(fixture.configPath, 'utf8'),
          /^hw\.keyboard=no$/m
        );
      } else {
        assert.match(
          fs.readFileSync(fixture.configPath, 'utf8'),
          /^hw\.keyboard=yes$/m
        );
      }
      running = true;
      fs.writeFileSync(hardwareLock, '43210\0');
      return emulatorChild();
    },
  });

  assert.equal(serial, 'emulator-5554');
  assert.deepEqual(operations, ['spawn', 'kill', 'spawn']);
  assert.equal(fs.existsSync(companionLock), true);
  assert.equal(
    fs.readFileSync(path.join(fixture.directory, 'user-data-marker'), 'utf8'),
    'preserve me'
  );
});

test('keeps configuration unchanged when exact emulator shutdown fails', async t => {
  const fixture = managedAvdFixture(t);
  fs.writeFileSync(
    path.join(fixture.directory, 'hardware-qemu.ini.lock'),
    '43210\0'
  );
  fs.writeFileSync(path.join(fixture.directory, 'multiinstance.lock'), '');
  const before = fs.readFileSync(fixture.configPath, 'utf8');

  await assert.rejects(
    ensureAndroidEmulator(fixture.environment, {
      captureFn: (_command, args) => {
        if (args[0] === 'devices') {
          return {
            status: 0,
            stderr: '',
            stdout: 'List of devices attached\nemulator-5554\tdevice\n',
          };
        }
        if (args.at(-1) === 'kill') {
          return { status: 1, stderr: 'refused', stdout: '' };
        }
        if (args.includes('emu')) {
          return {
            status: 0,
            stderr: '',
            stdout: `${fixture.environment.avd}\nOK\n`,
          };
        }
        throw new Error(`Unexpected adb command: ${args.join(' ')}`);
      },
      log: () => {},
      processIdFn: () => 43210,
      processStateFn: () => 'alive',
    }),
    /could not be stopped safely.*refused/s
  );
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('keeps configuration unchanged when exact shutdown cannot be confirmed', async t => {
  const fixture = managedAvdFixture(t);
  fs.writeFileSync(
    path.join(fixture.directory, 'hardware-qemu.ini.lock'),
    '43210\0'
  );
  fs.writeFileSync(path.join(fixture.directory, 'multiinstance.lock'), '');
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  let killed = false;
  let clock = 0;

  await assert.rejects(
    ensureAndroidEmulator(fixture.environment, {
      captureFn: (_command, args) => {
        if (args[0] === 'devices') {
          return killed
            ? stoppedInventory()
            : {
              status: 0,
              stderr: '',
              stdout: 'List of devices attached\nemulator-5554\tdevice\n',
            };
        }
        if (args.at(-1) === 'kill') {
          killed = true;
          return { status: 0, stderr: '', stdout: 'OK\n' };
        }
        if (args.includes('emu')) {
          return {
            status: 0,
            stderr: '',
            stdout: `${fixture.environment.avd}\nOK\n`,
          };
        }
        throw new Error(`Unexpected adb command: ${args.join(' ')}`);
      },
      delay: async () => {},
      log: () => {},
      now: () => {
        clock += 10;
        return clock;
      },
      processIdFn: () => 43210,
      processStateFn: () => 'alive',
      shutdownTimeoutMs: 25,
    }),
    /did not shut down safely/
  );
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('fails closed when Android reports an offline emulator inventory', async t => {
  const fixture = managedAvdFixture(t);
  const before = fs.readFileSync(fixture.configPath, 'utf8');

  await assert.rejects(
    ensureAndroidEmulator(fixture.environment, {
      captureFn: () => ({
        status: 0,
        stderr: '',
        stdout: 'List of devices attached\nemulator-5554\toffline\n',
      }),
      log: () => {},
    }),
    /emulator-5554 is offline.*inventory is uncertain/s
  );
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('fails closed for uncertain AVD lock files', async t => {
  await t.test('unknown lock name', subtest => {
    const fixture = managedAvdFixture(subtest);
    fs.writeFileSync(path.join(fixture.directory, 'unknown.lock'), '');
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    assert.throws(
      () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment, {
        captureFn: stoppedInventory,
      }),
      /uncertain emulator locks/
    );
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  });

  await t.test('nonempty companion lock', subtest => {
    const fixture = managedAvdFixture(subtest);
    fs.writeFileSync(
      path.join(fixture.directory, 'multiinstance.lock'),
      'uncertain'
    );
    const before = fs.readFileSync(fixture.configPath, 'utf8');
    assert.throws(
      () => ensureOnRampAndroidAvdHostKeyboard(fixture.environment, {
        captureFn: stoppedInventory,
      }),
      /uncertain emulator locks/
    );
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  });
});

test('reuses an enabled running AVD without stopping or rebuilding it', async t => {
  const fixture = managedAvdFixture(t, { keyboard: 'yes' });
  fs.writeFileSync(
    path.join(fixture.directory, 'hardware-qemu.ini.lock'),
    '43210\0'
  );
  const operations = [];

  const serial = await ensureAndroidEmulator(fixture.environment, {
    activateFn: () => true,
    captureFn: (_command, args) => {
      if (args[0] === 'devices') {
        return {
          status: 0,
          stderr: '',
          stdout: 'List of devices attached\nemulator-5554\tdevice\n',
        };
      }
      if (args.includes('emu')) {
        if (args.at(-1) === 'kill') {
          operations.push('kill');
          throw new Error('enabled AVD must not be killed');
        }
        return {
          status: 0,
          stderr: '',
          stdout: `${fixture.environment.avd}\nOK\n`,
        };
      }
      throw new Error(`Unexpected adb command: ${args.join(' ')}`);
    },
    log: () => {},
    processStateFn: () => 'alive',
    spawnFn: () => {
      operations.push('spawn');
      throw new Error('enabled running AVD must not be spawned');
    },
  });

  assert.equal(serial, 'emulator-5554');
  assert.deepEqual(operations, []);
});
