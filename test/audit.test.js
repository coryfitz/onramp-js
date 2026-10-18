const assert = require('node:assert/strict');
const test = require('node:test');

const { runNpmAudit } = require('../src/audit');

function auditResult({ status, vulnerabilities, total, stderr = '' }) {
  return {
    error: undefined,
    status,
    stderr,
    stdout: JSON.stringify({
      metadata: { vulnerabilities: { total } },
      vulnerabilities,
    }),
  };
}

const BRACES_ADVISORY = {
  name: 'braces',
  range: '<=3.0.3',
  source: 1240992,
  url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
};

const SPRINTF_JS_ADVISORY = {
  name: 'sprintf-js',
  range: '<=1.1.3',
  source: 1241202,
  url: 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c',
};

function runnerFor(result, latestVersions = {
  braces: '3.0.3',
  'sprintf-js': '1.1.3',
}) {
  return (_command, args) => {
    if (args[0] === 'audit') return result;
    assert.equal(args[0], 'view');
    assert.equal(args[2], 'version');
    assert.deepEqual(args.slice(3), ['--json', '--prefer-online']);
    assert.ok(Object.hasOwn(latestVersions, args[1]));
    return {
      error: undefined,
      status: 0,
      stderr: '',
      stdout: JSON.stringify(latestVersions[args[1]]),
    };
  };
}

test('passes a clean npm audit report', () => {
  const messages = [];
  const report = runNpmAudit({
    log: message => messages.push(message),
    runner: () => auditResult({ status: 0, total: 0, vulnerabilities: {} }),
  });

  assert.equal(report.metadata.vulnerabilities.total, 0);
  assert.deepEqual(messages, ['✓ npm audit found no vulnerabilities']);
});

test('accepts only dependency chains rooted in the reviewed unpatched advisory', () => {
  const messages = [];
  const report = runNpmAudit({
    log: message => messages.push(message),
    runner: runnerFor(auditResult({
      status: 1,
      total: 3,
      vulnerabilities: {
        braces: { via: [BRACES_ADVISORY] },
        micromatch: { via: ['braces', 'metro'] },
        metro: { via: ['micromatch'] },
      },
    })),
  });

  assert.equal(report.metadata.vulnerabilities.total, 3);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /no patched version exists/);
  assert.match(messages[0], /GHSA-vfj7-8cjw-p6xm/);
});

test('accepts the reviewed unpatched advisory in transitive Jest tooling', () => {
  const messages = [];
  const report = runNpmAudit({
    log: message => messages.push(message),
    runner: runnerFor(auditResult({
      status: 1,
      total: 3,
      vulnerabilities: {
        'sprintf-js': { via: [SPRINTF_JS_ADVISORY] },
        argparse: { via: ['sprintf-js'] },
        'js-yaml': { via: ['argparse'] },
      },
    })),
  });

  assert.equal(report.metadata.vulnerabilities.total, 3);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Jest development-tooling advisory/);
  assert.match(messages[0], /GHSA-hp3w-g68c-fv3c/);
});

test('fails for any additional or changed npm advisory', () => {
  for (const advisory of [
    { ...BRACES_ADVISORY, range: '<=3.0.4' },
    { ...SPRINTF_JS_ADVISORY, range: '<=1.1.4' },
    {
      name: 'other-package',
      range: '<1.0.0',
      source: 999999,
      url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
    },
  ]) {
    assert.throws(
      () => runNpmAudit({
        runner: () => auditResult({
          status: 1,
          total: 1,
          vulnerabilities: { [advisory.name]: { via: [advisory] } },
        }),
      }),
      /npm audit failed/
    );
  }
});

test('fails when a new upstream release makes the reviewed exception stale', () => {
  assert.throws(
    () => runNpmAudit({
      runner: runnerFor(auditResult({
        status: 1,
        total: 1,
        vulnerabilities: { braces: { via: [BRACES_ADVISORY] } },
      }), { braces: '3.0.4' }),
    }),
    /exception for braces is stale.*found 3\.0\.4/
  );
});

test('fails closed for audit command and report errors', () => {
  assert.throws(
    () => runNpmAudit({
      runner: () => ({
        error: undefined,
        status: 2,
        stderr: 'registry unavailable',
        stdout: '',
      }),
    }),
    /valid JSON: registry unavailable/
  );
  assert.throws(
    () => runNpmAudit({
      runner: () => auditResult({ status: 2, total: 1, vulnerabilities: {} }),
    }),
    /npm audit failed/
  );
});
