const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(command, args, cwd, env = process.env) {
  console.log(`Running: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: false,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }
  if (options.check !== false && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(
      `${command} exited with status ${result.status}${detail ? `: ${detail}` : ''}`
    );
  }

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function executableNames(command) {
  if (process.platform !== 'win32' || path.extname(command)) {
    return [command];
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);
  return [command, ...extensions.map(extension => `${command}${extension}`)];
}

function findExecutable(command, env = process.env) {
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? command : null;
  }

  const directories = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of executableNames(command)) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function prependPath(env, ...directories) {
  const current = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const additions = directories.filter(
    directory => directory && fs.existsSync(directory) && !current.includes(directory)
  );
  env.PATH = [...additions, ...current].join(path.delimiter);
}

module.exports = {
  capture,
  findExecutable,
  prependPath,
  run,
};
