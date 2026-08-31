const assert = require('node:assert/strict');
const test = require('node:test');

const { capture, run, runAsync } = require('../src/process');

test('does not leak npm exec package selection into child commands', async () => {
  const contaminatedEnv = {
    ...process.env,
    npm_config_package: 'onramp-js@0.5.23',
  };
  const script = [
    'if (process.env.npm_config_package) process.exit(9);',
    'process.stdout.write("clean");',
  ].join(' ');

  const synchronous = run(
    process.execPath,
    ['-e', script],
    process.cwd(),
    contaminatedEnv,
    { quiet: true }
  );
  assert.equal(synchronous.stdout, 'clean');

  const captured = capture(
    process.execPath,
    ['-e', script],
    { env: contaminatedEnv }
  );
  assert.equal(captured.stdout, 'clean');

  const asynchronous = await runAsync(
    process.execPath,
    ['-e', script],
    process.cwd(),
    contaminatedEnv,
    { quiet: true }
  );
  assert.equal(asynchronous.stdout, 'clean');

  assert.equal(contaminatedEnv.npm_config_package, 'onramp-js@0.5.23');
});

test('reports periodic activity while a quiet native command is still running', async () => {
  const messages = [];
  const result = await runAsync(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("done"), 80)'],
    process.cwd(),
    process.env,
    {
      activityDelayMs: 10,
      activityIntervalMs: 15,
      activityLabel: 'Native build is still running',
      log: message => messages.push(message),
      quiet: true,
    }
  );

  assert.equal(result.stdout, 'done');
  assert.ok(messages.length >= 1);
  assert.match(messages[0], /^Native build is still running \(\d+s elapsed\)\.\.\.$/);
});

test('reports quiet asynchronous command failures with their output', async () => {
  await assert.rejects(
    runAsync(
      process.execPath,
      ['-e', 'process.stderr.write("native failure"); process.exit(7)'],
      process.cwd(),
      process.env,
      { quiet: true }
    ),
    /exited with status 7: native failure/
  );
});
