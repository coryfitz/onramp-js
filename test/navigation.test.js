const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { nextNativeNavigationStack } = require('../src/navigation-state');

test('native Home navigation resets the route stack', () => {
  assert.deepEqual(
    nextNativeNavigationStack(['/', '/about', '/profile/123'], '/', '/'),
    ['/']
  );
  assert.deepEqual(
    nextNativeNavigationStack(['/'], '/about', '/'),
    ['/', '/about']
  );
});

test('the generated not-found Home button uses shared navigation', () => {
  const registry = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'templates',
      'src',
      'navigation',
      'RouteRegistry.tsx'
    ),
    'utf8'
  );

  assert.match(registry, /const \{ navigate \} = useNavigation\(\)/);
  assert.match(registry, /onClick=\{\(\) => navigate\('\/'\)\}/);
  assert.doesNotMatch(registry, /window\.location\.href/);
});
