#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `webterm ${version}: a terminal in your browser

Usage:
  webterm [options]                         start the server
  webterm set-password <username> [--print] create credentials
  webterm install-service [options]         run webterm as a systemd user service
                                            (Linux only; starts at boot, restarts on failure)
  webterm uninstall-service [--name <n>]    stop and remove that service (Linux only)

Options:
  -H, --host <addr>     address to bind      (env WEBTERM_HOST, default 127.0.0.1)
  -p, --port <port>     port to listen on    (env WEBTERM_PORT, default 2828)
  -s, --shell <path>    shell to run         (env WEBTERM_SHELL or SHELL)
  -c, --config <path>   credentials file     (env WEBTERM_CONFIG,
                                              default ~/.config/webterm/config.json)
      --max-upload <MB> per-file upload limit (env WEBTERM_MAX_UPLOAD_MB,
                                              default 1024; 0 = unlimited)
      --shell-timeout <hours>
                        end the shared shell after this long with no tabs open
                                              (env WEBTERM_SHELL_TIMEOUT_HOURS,
                                              default 168 = 7 days; 0 = never)
      --print           set-password: print env vars instead of writing the file
      --name <name>     install/uninstall-service: unit name (default webterm)
      --dry-run         install-service: print the unit file instead of installing
  -h, --help            show this help
  -v, --version         show the version

Credentials come from WEBTERM_USER + WEBTERM_PASSWORD_HASH if both are set,
otherwise from the config file. A .env file in the current directory is
loaded automatically.

Push notifications (ntfy) are configured in the app's settings menu and saved in
settings.json next to the credentials file.

install-service passes the server options you give it on to the service, and
runs it in the current directory, so a .env file there is used too.
`;

function fail(message) {
  console.error(`webterm: ${message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      host: { type: 'string', short: 'H' },
      port: { type: 'string', short: 'p' },
      shell: { type: 'string', short: 's' },
      config: { type: 'string', short: 'c' },
      'max-upload': { type: 'string' },
      'shell-timeout': { type: 'string' },
      print: { type: 'boolean' },
      name: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (err) {
  fail(`${err.message}\nRun "webterm --help" for usage.`);
}
const { values: opts, positionals } = parsed;

if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.version) {
  console.log(version);
  process.exit(0);
}

// Variables already set in the environment take precedence over .env.
if (fs.existsSync('.env')) {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    fail(`could not read .env: ${err.message}`);
  }
}

function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'webterm', 'config.json');
}
const configPath = path.resolve(opts.config || process.env.WEBTERM_CONFIG || defaultConfigPath());
// App settings changed from the browser (e.g. push notifications) live next to the credentials.
const settingsPath = path.join(path.dirname(configPath), 'settings.json');

const [command, ...rest] = positionals;

if (command === 'set-password') {
  const username = rest[0];
  if (!username || rest.length > 1) fail('usage: webterm set-password <username> [--print]');
  const { setPassword } = await import('../lib/set-password.js');
  try {
    await setPassword({ username, configPath, printOnly: Boolean(opts.print) });
  } catch (err) {
    fail(err.message);
  }
  process.exit(0);
}

// The service commands manage systemd user units, so they only make sense on Linux. Check
// before anything else (credentials, options), including for --dry-run.
if ((command === 'install-service' || command === 'uninstall-service') && process.platform !== 'linux') {
  fail(
    `${command} is only available on Linux (it manages a systemd user service); ` +
      `this system is ${process.platform}. Run \`webterm\` directly, or use your platform's service manager.`,
  );
}

if (command === 'uninstall-service') {
  if (rest.length) fail('usage: webterm uninstall-service [--name <name>]');
  const { uninstallService } = await import('../lib/service.js');
  try {
    uninstallService({ name: opts.name || 'webterm' });
  } catch (err) {
    fail(err.message);
  }
  process.exit(0);
}

if (command && command !== 'install-service') {
  fail(`unknown command "${command}". Run "webterm --help" for usage.`);
}
if (rest.length) fail(`usage: webterm ${command} [options]`);
if (opts.print) fail('--print only applies to "webterm set-password"');
if (!command && (opts.name || opts['dry-run'])) fail('--name and --dry-run only apply to install-service (and --name to uninstall-service)');

const host = opts.host || process.env.WEBTERM_HOST || '127.0.0.1';
const port = Number(opts.port || process.env.WEBTERM_PORT || 2828);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port "${opts.port || process.env.WEBTERM_PORT}"`);
const maxUploadRaw = opts['max-upload'] ?? process.env.WEBTERM_MAX_UPLOAD_MB ?? '1024';
const maxUploadMb = Number(maxUploadRaw);
if (!Number.isFinite(maxUploadMb) || maxUploadMb < 0) fail(`invalid upload limit "${maxUploadRaw}"`);
const maxUploadBytes = Math.floor(maxUploadMb * 1024 * 1024);
const timeoutRaw = opts['shell-timeout'] ?? process.env.WEBTERM_SHELL_TIMEOUT_HOURS ?? '168';
const timeoutHours = Number(timeoutRaw);
// setTimeout overflows above ~24.8 days; cap there (longer is effectively "a long time").
if (!Number.isFinite(timeoutHours) || timeoutHours < 0) fail(`invalid shell timeout "${timeoutRaw}"`);
const detachedTimeoutMs = Math.min(Math.floor(timeoutHours * 3600 * 1000), 2 ** 31 - 1);
const shell =
  opts.shell || process.env.WEBTERM_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');

if (command === 'install-service') {
  // Check credentials now, so a broken setup fails here rather than in a restart loop.
  const auth = await import('../lib/auth.js');
  let source;
  try {
    source = auth.loadCredentials(configPath).source;
  } catch (err) {
    fail(err.message);
  }
  if (source === 'environment' && !fs.existsSync('.env')) {
    console.warn(
      'warning: credentials come from environment variables in your current shell, which the\n' +
        '         service will not see. Put them in a .env file in this directory, or use a config file.\n',
    );
  }
  // Forward the server options given on the command line. The shell is always pinned, since
  // the service manager's environment may not have SHELL.
  const serverArgs = ['--shell', shell];
  if (opts.host) serverArgs.push('--host', opts.host);
  if (opts.port) serverArgs.push('--port', String(port));
  if (opts.config) serverArgs.push('--config', configPath);
  if (opts['max-upload'] !== undefined) serverArgs.push('--max-upload', opts['max-upload']);
  if (opts['shell-timeout'] !== undefined) serverArgs.push('--shell-timeout', opts['shell-timeout']);

  const { installService } = await import('../lib/service.js');
  try {
    installService({
      name: opts.name || 'webterm',
      entry: fileURLToPath(import.meta.url),
      serverArgs,
      dryRun: Boolean(opts['dry-run']),
    });
  } catch (err) {
    fail(err.message);
  }
  process.exit(0);
}

// Load node-pty (and the rest of the server) only when actually serving, so that
// --help and set-password work even if the native module failed to install.
let auth, startServer;
try {
  auth = await import('../lib/auth.js');
  ({ startServer } = await import('../lib/server.js'));
} catch (err) {
  if (/node-pty|pty\.node/.test(String(err?.stack))) {
    fail(
      `node-pty failed to load: ${err.message}\n\n` +
        'Its native module was probably not built during install. Newer npm versions skip\n' +
        'install scripts until approved; on Linux, building also needs python3, make and a\n' +
        'C++ compiler. See the README ("Installing") for details.',
    );
  }
  throw err;
}

let credentials;
try {
  credentials = auth.loadCredentials(configPath);
} catch (err) {
  fail(err.message);
}

try {
  await startServer({ host, port, shell, credentials, maxUploadBytes, detachedTimeoutMs, settingsPath });
} catch (err) {
  fail(`could not listen on ${host}:${port}: ${err.message}`);
}

console.log(`webterm ${version} running at http://${host.includes(':') ? `[${host}]` : host}:${port}  (shell: ${shell})`);
console.log(`auth: user "${credentials.username}" from ${credentials.source}`);
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.warn('note: listening beyond localhost; traffic is plain HTTP. See the README security notes.');
}
