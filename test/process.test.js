const assert = require('node:assert/strict');
const test = require('node:test');

const { runAsync } = require('../src/process');

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
