const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const {
  isPortAvailable,
  metroBundlePath,
  normalizePort,
  selectMetroPort,
  warmMetroBundle,
} = require('../src/metro');

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test('normalizes valid Metro ports and rejects invalid values', () => {
  assert.equal(normalizePort('8082'), 8082);
  assert.throws(() => normalizePort('0'), /between 1 and 65535/);
  assert.throws(() => normalizePort('not-a-port'), /between 1 and 65535/);
});

test('never reuses an occupied explicit Metro port', async () => {
  const server = net.createServer();
  const occupiedPort = await listen(server);
  try {
    assert.equal(await isPortAvailable(occupiedPort), false);
    await assert.rejects(
      selectMetroPort(occupiedPort),
      /already in use/
    );
  } finally {
    await close(server);
  }
});

test('detects a macOS-style IPv6 wildcard listener', async t => {
  const server = net.createServer();
  let occupiedPort;
  try {
    occupiedPort = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '::', port: 0, ipv6Only: false }, () => {
        resolve(server.address().port);
      });
    });
  } catch (error) {
    t.skip(`IPv6 wildcard listeners are unavailable: ${error.message}`);
    return;
  }

  try {
    assert.equal(await isPortAvailable(occupiedPort), false);
  } finally {
    await close(server);
  }
});

test('automatically advances past an occupied default port', async () => {
  const server = net.createServer();
  const occupiedPort = await listen(server);
  try {
    const selected = await selectMetroPort(undefined, occupiedPort);
    assert.ok(selected > occupiedPort);
    assert.equal(await isPortAvailable(selected), true);
  } finally {
    await close(server);
  }
});

test('builds the same lazy native bundle shape requested by React Native', () => {
  const url = new URL(metroBundlePath('ios'), 'http://localhost');

  assert.equal(url.pathname, '/index.bundle');
  assert.equal(url.searchParams.get('platform'), 'ios');
  assert.equal(url.searchParams.get('dev'), 'true');
  assert.equal(url.searchParams.get('lazy'), 'true');
  assert.equal(url.searchParams.get('runModule'), 'true');
  assert.throws(() => metroBundlePath('web'), /ios or android/);
});

test('waits for the complete Metro bundle before reporting readiness', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, '/index.bundle');
    assert.equal(url.searchParams.get('platform'), 'ios');
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.write('first');
    setTimeout(() => response.end('second'), 30);
  });
  const port = await listen(server);
  let completed = false;
  server.once('request', (request, response) => {
    response.once('finish', () => { completed = true; });
  });

  try {
    await warmMetroBundle({ port, platform: 'ios' });
    assert.equal(completed, true);
  } finally {
    await close(server);
  }
});

test('rejects a failed Metro bundle response with its status and detail', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(500, { 'Content-Type': 'text/plain' });
    response.end('bundle generation failed');
  });
  const port = await listen(server);

  try {
    await assert.rejects(
      warmMetroBundle({ port, platform: 'android' }),
      /HTTP 500.*bundle generation failed/
    );
  } finally {
    await close(server);
  }
});
