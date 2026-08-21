const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { startWatchDiagnostics } = require('./watch-diagnostics');

const DEFAULT_METRO_PORT = 8081;
const DEFAULT_BUNDLE_TIMEOUT_MS = 120000;

function metroSpawnStdio({ interactive = true, label } = {}) {
  if (label) {
    return [interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'];
  }
  if (interactive) {
    return 'inherit';
  }
  return ['ignore', 'inherit', 'inherit'];
}

function prefixStream(source, destination, label) {
  const prefix = `[${label}] `;
  let pending = '';

  source.setEncoding('utf8');
  source.on('data', chunk => {
    pending += chunk;
    const lines = pending.split(/\r\n|\r|\n/);
    pending = lines.pop();
    for (const line of lines) {
      destination.write(`${prefix}${line}\n`);
    }
  });
  source.once('end', () => {
    if (pending) {
      destination.write(`${prefix}${pending}\n`);
    }
  });
}

function normalizePort(value, label = 'Metro port') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function hasListener(port, host) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(250);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

function canBind(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', error => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(closeError => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(true);
      });
    });
  });
}

async function isPortAvailable(port, host = '127.0.0.1') {
  const listenerChecks = await Promise.all(
    ['localhost', '127.0.0.1', '::1'].map(candidate => (
      hasListener(port, candidate)
    ))
  );
  if (listenerChecks.some(Boolean)) {
    return false;
  }
  return canBind(port, host);
}

async function selectMetroPort(requestedPort, startingPort = DEFAULT_METRO_PORT) {
  if (requestedPort !== undefined && requestedPort !== null) {
    const explicitPort = normalizePort(requestedPort);
    if (!await isPortAvailable(explicitPort)) {
      throw new Error(
        `Metro port ${explicitPort} is already in use. `
        + 'Choose a free --metro-port or stop the process that owns it.'
      );
    }
    return explicitPort;
  }

  const firstPort = normalizePort(startingPort, 'Starting Metro port');
  for (let port = firstPort; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      if (port !== firstPort) {
        console.log(`Metro port ${firstPort} is in use; using ${port}.`);
      }
      return port;
    }
  }
  throw new Error(`No free Metro port was found at or above ${firstPort}.`);
}

async function waitForListener(port, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Metro exited before it opened port ${port}.`);
    }
    if (await hasListener(port, 'localhost')) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Metro did not open port ${port} within ${timeoutMs}ms.`);
}

function metroBundlePath(platform) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error('Metro bundle platform must be ios or android.');
  }
  const query = new URLSearchParams({
    platform,
    dev: 'true',
    lazy: 'true',
    minify: 'false',
    inlineSourceMap: 'false',
    modulesOnly: 'false',
    runModule: 'true',
    excludeSource: 'true',
    sourcePaths: 'url-server',
  });
  return `/index.bundle?${query.toString()}`;
}

function warmMetroBundle({
  port,
  platform,
  timeoutMs = DEFAULT_BUNDLE_TIMEOUT_MS,
}) {
  const metroPort = normalizePort(port);
  const requestPath = metroBundlePath(platform);
  console.log(`Preparing the first ${platform} bundle...`);

  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: '127.0.0.1',
        port: metroPort,
        path: requestPath,
      },
      response => {
        const errorChunks = [];
        let errorLength = 0;

        response.on('data', chunk => {
          if (
            response.statusCode >= 200
            && response.statusCode < 300
          ) {
            return;
          }
          if (errorLength < 8192) {
            const remaining = 8192 - errorLength;
            errorChunks.push(chunk.subarray(0, remaining));
            errorLength += Math.min(chunk.length, remaining);
          }
        });
        response.once('aborted', () => {
          reject(new Error(`Metro closed the ${platform} bundle response early.`));
        });
        response.once('error', reject);
        response.once('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            console.log(`✓ First ${platform} bundle is ready`);
            resolve();
            return;
          }
          const detail = Buffer.concat(errorChunks).toString('utf8').trim();
          reject(new Error(
            `Metro could not prepare the ${platform} bundle `
            + `(HTTP ${response.statusCode || 'unknown'})`
            + `${detail ? `: ${detail}` : ''}`
          ));
        });
      }
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(
        `Metro did not finish the ${platform} bundle within ${timeoutMs}ms.`
      ));
    });
    request.once('error', reject);
  });
}

async function startMetro({
  output,
  requestedPort,
  startingPort = DEFAULT_METRO_PORT,
  env = process.env,
  interactive = true,
  label,
}) {
  const outputDir = path.resolve(output || process.cwd());
  const port = await selectMetroPort(requestedPort, startingPort);
  const diagnosticsWatcher = startWatchDiagnostics(outputDir, env);
  console.log(`Starting project Metro on port ${port}...`);
  const child = spawn(
    'npx',
    ['react-native', 'start', '--port', String(port)],
    {
      cwd: outputDir,
      env,
      shell: false,
      stdio: metroSpawnStdio({ interactive, label }),
    }
  );

  if (label) {
    prefixStream(child.stdout, process.stdout, label);
    prefixStream(child.stderr, process.stderr, label);
  }

  let stopping = false;
  let diagnosticsClosed = false;
  const closeDiagnostics = () => {
    if (diagnosticsWatcher && !diagnosticsClosed) {
      diagnosticsClosed = true;
      diagnosticsWatcher.close();
    }
  };
  const stop = signal => {
    if (stopping || child.exitCode !== null) {
      return;
    }
    stopping = true;
    closeDiagnostics();
    child.kill(signal || 'SIGTERM');
  };

  const handleSignal = signal => {
    stop(signal);
    process.exitCode = 0;
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  child.once('exit', code => {
    closeDiagnostics();
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    if (!stopping && code !== 0) {
      console.error(`Metro exited unexpectedly with code ${code}.`);
      process.exitCode = code || 1;
    }
  });

  try {
    const startupError = new Promise((resolve, reject) => {
      child.once('error', reject);
    });
    await Promise.race([
      waitForListener(port, child),
      startupError,
    ]);
  } catch (error) {
    stop('SIGTERM');
    throw error;
  }

  console.log(`✓ Project Metro is ready on port ${port}`);
  return { child, port, stop };
}

module.exports = {
  DEFAULT_BUNDLE_TIMEOUT_MS,
  DEFAULT_METRO_PORT,
  hasListener,
  isPortAvailable,
  metroBundlePath,
  metroSpawnStdio,
  normalizePort,
  prefixStream,
  selectMetroPort,
  startMetro,
  warmMetroBundle,
  waitForListener,
};
