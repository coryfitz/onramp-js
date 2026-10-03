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

function runnerFor(result, latestVersion = '3.0.3') {
  return (_command, args) => {
    if (args[0] === 'audit') return result;
    assert.deepEqual(args, [
      'view',
      'braces',
      'version',
      '--json',
      '--prefer-online',
    ]);
    return {
      error: undefined,
      status: 0,
      stderr: '',
      stdout: JSON.stringify(latestVersion),
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

test('fails for any additional or changed npm advisory', () => {
  for (const advisory of [
    { ...BRACES_ADVISORY, range: '<=3.0.4' },
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
      }), '3.0.4'),
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
