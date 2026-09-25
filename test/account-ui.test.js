const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { loadRuntime } = require('./helpers/runtime-ts');

const state = loadRuntime('account-ui-state.ts', [
  'normalizeAccountEmail',
  'normalizeAccountCode',
  'accountUiErrorText',
]);

test('account UI normalizes email and verification codes before requests', () => {
  assert.equal(
    state.normalizeAccountEmail('  Person@Example.COM  '),
    'person@example.com',
  );
  assert.equal(state.normalizeAccountCode('12 a3-4567'), '123456');
});

test('account UI preserves useful request errors and provides a safe fallback', () => {
  assert.equal(
    state.accountUiErrorText(new Error('Incorrect code')),
    'Incorrect code',
  );
  assert.equal(
    state.accountUiErrorText({ message: 'not trusted' }),
    'The request could not be completed.',
  );
});

test('account UI ships an opinionated modal and app-specific deletion cleanup hook', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'runtime', 'AccountModal.tsx'),
    'utf8',
  );
  assert.match(source, /export function AccountModal/);
  assert.match(source, /export function AccountDialog/);
  assert.match(source, /onAccountDeleted\?\(accountId: string\)/);
  assert.match(
    source,
    /Development codes are written to \.onramp\/dev-mail-outbox\.jsonl/,
  );
});
