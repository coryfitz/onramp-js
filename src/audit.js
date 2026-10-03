const { spawnSync } = require('child_process');

const REVIEWED_NPM_AUDIT_EXCEPTIONS = new Map([
  [1240992, {
    latestReviewedVersion: '3.0.3',
    name: 'braces',
    range: '<=3.0.3',
    url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  }],
]);

function auditAdvisories(report) {
  const vulnerabilities = report?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object') {
    throw new Error('npm audit returned an unrecognized vulnerability report.');
  }

  const names = Object.keys(vulnerabilities);
  const edges = new Map(names.map(name => [name, new Set()]));
  const directAdvisories = new Map(names.map(name => [name, []]));
  for (const name of names) {
    const vulnerability = vulnerabilities[name];
    if (!vulnerability || !Array.isArray(vulnerability.via)) {
      throw new Error(`npm audit returned an unrecognized vulnerability entry for ${name}.`);
    }
    for (const via of vulnerability.via) {
      if (typeof via === 'string') {
        if (!edges.has(via)) {
          throw new Error(`npm audit references a missing vulnerability entry for ${via}.`);
        }
        edges.get(name).add(via);
        edges.get(via).add(name);
      } else if (via && typeof via === 'object') {
        directAdvisories.get(name).push(via);
      } else {
        throw new Error(`npm audit returned an unrecognized advisory chain for ${name}.`);
      }
    }
  }

  const advisories = [];
  const visited = new Set();
  for (const name of names) {
    if (visited.has(name)) continue;
    const stack = [name];
    const componentAdvisories = [];
    while (stack.length) {
      const current = stack.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      componentAdvisories.push(...directAdvisories.get(current));
      stack.push(...edges.get(current));
    }
    if (!componentAdvisories.length) {
      throw new Error(
        `npm audit returned a vulnerability chain without an advisory at ${name}.`
      );
    }
    advisories.push(...componentAdvisories);
  }
  return advisories;
}

function isReviewedException(advisory) {
  const exception = REVIEWED_NPM_AUDIT_EXCEPTIONS.get(advisory.source);
  return Boolean(
    exception
    && advisory.name === exception.name
    && advisory.range === exception.range
    && advisory.url === exception.url
  );
}

function runNpmAudit({
  cwd = process.cwd(),
  log = console.log,
  runner = spawnSync,
} = {}) {
  const result = runner('npm', ['audit', '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;

  let report;
  try {
    report = JSON.parse(result.stdout || '');
  } catch {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `npm audit did not return valid JSON${detail ? `: ${detail}` : '.'}`
    );
  }

  const total = report.metadata?.vulnerabilities?.total;
  if (result.status === 0 && total === 0) {
    log('✓ npm audit found no vulnerabilities');
    return report;
  }

  const advisories = auditAdvisories(report);
  const unexpected = advisories.filter(advisory => !isReviewedException(advisory));
  if (
    result.status !== 1
    || !Number.isInteger(total)
    || total < 1
    || advisories.length < 1
    || unexpected.length > 0
  ) {
    const detail = (result.stderr || '').trim();
    throw new Error(
      `npm audit failed with ${total ?? 'an unknown number of'} vulnerabilities`
      + `${detail ? `: ${detail}` : '.'}`
    );
  }

  const reviewedSources = new Set(advisories.map(advisory => advisory.source));
  for (const source of reviewedSources) {
    const reviewed = REVIEWED_NPM_AUDIT_EXCEPTIONS.get(source);
    const registry = runner(
      'npm',
      ['view', reviewed.name, 'version', '--json', '--prefer-online'],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (registry.error) throw registry.error;
    let latestVersion;
    try {
      latestVersion = JSON.parse(registry.stdout || '');
    } catch {
      latestVersion = null;
    }
    if (registry.status !== 0 || latestVersion !== reviewed.latestReviewedVersion) {
      throw new Error(
        `The reviewed npm audit exception for ${reviewed.name} is stale; `
        + `expected latest version ${reviewed.latestReviewedVersion}, found `
        + `${latestVersion || 'an unknown version'}. Reassess the advisory before releasing.`
      );
    }
  }

  const reviewed = REVIEWED_NPM_AUDIT_EXCEPTIONS.values().next().value;
  log(
    `⚠ npm audit found only ${reviewed.url}. `
    + 'All released braces versions are affected and no patched version exists; '
    + 'OnRamp accepts this transitive build-tooling advisory until upstream publishes a fix.'
  );
  return report;
}

module.exports = {
  auditAdvisories,
  REVIEWED_NPM_AUDIT_EXCEPTIONS,
  runNpmAudit,
};
