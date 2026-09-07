const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {loadRuntime} = require('./helpers/runtime-ts');

const clientExports = [
  'OnRampApiError', 'requestAccountCode', 'verifyAccountCode', 'loadAccount',
  'logoutAccount', 'requestAccountDeletion', 'deleteAccount',
  'requestNotificationSubscription', 'verifyNotificationSubscription',
  'revokeNotificationContact',
];

function clientHarness(response = {ok: true, status: 200, payload: {}}) {
  const calls = [];
  const client = loadRuntime('auth-client.ts', clientExports, {}, {
    fetch: async (url, options) => {
      calls.push({url, ...options});
      return {...response, json: async () => response.payload};
    },
  });
  return {client, calls};
}

test('notification auth client exposes proof-gated request management URLs', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'runtime', 'auth-client.ts'),
    'utf8',
  );

  assert.match(source, /interface NotificationSubscriptionResponse/);
  assert.match(source, /unsubscribe_url\?: string/);
  assert.match(source, /unsubscribe_path\?: string/);
  assert.match(source, /interface VerifiedNotificationSubscriptionResponse/);
  assert.match(source, /unsubscribe_url: string/);
  assert.match(source, /unsubscribe_path: string/);
  assert.match(source, /request<NotificationSubscriptionResponse>/);
  assert.match(source, /request<VerifiedNotificationSubscriptionResponse>/);
  assert.match(source, /requestTimeoutMs\?: number/);
  assert.match(source, /context\.requestTimeoutMs \?\? 25_000/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /'request_timeout'/);
});

test('notification capability is never sent on account endpoints', async () => {
  const {client, calls} = clientHarness();
  const context = {
    apiBaseUrl: 'https://api.example.test/',
    sessionToken: 'account-secret',
    notificationToken: 'notification-secret',
    rememberEmail: true,
  };
  await client.requestAccountCode(context, 'person@example.test', 'signin');
  await client.verifyAccountCode(context, 'person@example.test', '123456', 'signin');
  await client.loadAccount(context);
  await client.logoutAccount(context);
  await client.requestAccountDeletion(context);
  await client.deleteAccount(context, '123456');
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, 'Bearer account-secret');
    assert.equal(call.headers['X-OnRamp-Notification-Token'], undefined);
    assert.ok(!JSON.stringify(call).includes('notification-secret'));
    assert.ok(!JSON.stringify(call).includes('remember_email'));
  }
});

test('notification intake serializes resource fields and sends only the notification capability', async () => {
  const {client, calls} = clientHarness();
  await client.requestNotificationSubscription({
    apiBaseUrl: 'https://api.example.test/v1/',
    notificationToken: 'notification-secret',
  }, {
    resourceType: 'provider',
    resourceId: 'example',
    resourceTitle: 'Example provider',
    metadata: {platform: 'ios'},
    appVersion: '1.0',
  });
  assert.equal(calls[0].url, 'https://api.example.test/v1/api/notifications/subscriptions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['X-OnRamp-Notification-Token'], 'notification-secret');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].body), {
    resource_type: 'provider',
    resource_id: 'example',
    resource_title: 'Example provider',
    source: 'app',
    metadata: {platform: 'ios'},
    app_version: '1.0',
  });
  await client.requestNotificationSubscription({apiBaseUrl: 'https://api.example.test'}, {
    resourceType: 'provider', resourceId: 'other', resourceTitle: 'Other',
    email: 'person@example.test',
  });
  assert.equal(calls[1].headers['X-OnRamp-Notification-Token'], undefined);
  assert.equal(JSON.parse(calls[1].body).email, 'person@example.test');
});

test('verification opts in explicitly without sending an existing notification capability', async () => {
  const payload = {
    verified: true,
    notification_token: 'new-notification-secret',
    notification_token_expires_at: '2099-01-01T00:00:00Z',
  };
  const {client, calls} = clientHarness({ok: true, status: 200, payload});
  for (const rememberEmail of [undefined, false, true]) {
    const result = await client.verifyNotificationSubscription({
      apiBaseUrl: 'https://api.example.test',
      notificationToken: 'old-notification-secret',
      rememberEmail,
    }, 'subscription', 'person@example.test', '123456');
    assert.equal(result.notification_token, payload.notification_token);
    assert.equal(result.notification_token_expires_at, payload.notification_token_expires_at);
    const call = calls.at(-1);
    assert.equal(call.headers['X-OnRamp-Notification-Token'], undefined);
    assert.deepEqual(JSON.parse(call.body), {
      subscription_id: 'subscription', email: 'person@example.test', code: '123456',
      ...(rememberEmail === true ? {remember_email: true} : {}),
    });
  }
});

test('verification preserves explicit non-expiring proof without inventing missing expiry metadata', async () => {
  for (const expiration of [{notification_token_expires_at: null}, {}]) {
    const payload = {verified: true, notification_token: 'notification-secret', ...expiration};
    const {client} = clientHarness({ok: true, status: 200, payload});
    const result = await client.verifyNotificationSubscription({
      apiBaseUrl: 'https://api.example.test', rememberEmail: true,
    }, 'subscription', 'person@example.test', '123456');
    assert.equal(Object.hasOwn(result, 'notification_token_expires_at'), Object.hasOwn(expiration, 'notification_token_expires_at'));
    assert.equal(result.notification_token_expires_at, expiration.notification_token_expires_at);
  }
});

test('revocation passes its capability to the dedicated endpoint and supports repeated success', async () => {
  const {client, calls} = clientHarness({ok: true, status: 200, payload: {revoked: true}});
  const context = {apiBaseUrl: 'https://api.example.test', notificationToken: 'notification-secret'};
  assert.equal((await client.revokeNotificationContact(context)).revoked, true);
  assert.equal((await client.revokeNotificationContact(context)).revoked, true);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.example.test/api/notifications/contact/revoke');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['X-OnRamp-Notification-Token'], 'notification-secret');
    assert.equal(call.headers.Authorization, undefined);
    assert.equal(call.body, undefined);
  }
});

test('invalid remembered capability preserves the backend code and status for fresh-proof fallback', async () => {
  const {client} = clientHarness({
    ok: false, status: 401,
    payload: {error: 'Verify your email again.', code: 'notification_token_invalid'},
  });
  await assert.rejects(client.requestNotificationSubscription({
    apiBaseUrl: 'https://api.example.test', notificationToken: 'old-notification-secret',
  }, {resourceType: 'provider', resourceId: 'example', resourceTitle: 'Example'}), error => {
    assert.ok(error instanceof client.OnRampApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'notification_token_invalid');
    assert.equal(error.message, 'Verify your email again.');
    return true;
  });
});
