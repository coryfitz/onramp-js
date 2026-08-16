const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldWatchRoutes } = require('../src/metro-config');

test('Metro route watching only runs for the development server', () => {
  assert.equal(shouldWatchRoutes(['node', 'react-native', 'start']), true);
  assert.equal(shouldWatchRoutes(['node', 'react-native', 'bundle']), false);
  assert.equal(shouldWatchRoutes(['node', 'metro', 'start']), true);
});
