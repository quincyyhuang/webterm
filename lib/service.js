// `webterm install-service` / `webterm uninstall-service`: run webterm as a systemd user
// service, so it starts at boot and restarts if it crashes. A user service runs as you (like
// your shells) and needs no root. "Lingering" lets it run while you're not logged in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanPath } from './env.js';

function unitDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'systemd', 'user');
}

function validName(name) {
  return /^[A-Za-z0-9_.@-]+$/.test(name);
}

/** Quote one ExecStart argument per systemd's rules (spaces, quotes, $ and % specifiers). */
function quoteArg(arg) {
  const escaped = String(arg).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return /[\s"'\\;]/.test(arg) || escaped !== arg || arg === '' ? `"${escaped}"` : escaped;
}

/** Quote a value for an Environment= line. */
function quoteEnv(name, value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$');
  return `"${name}=${escaped}"`;
}

function systemctl(...args) {
  const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' });
  return { ok: res.status === 0, out: (res.stdout || '') + (res.stderr || '') };
}

function requireLinux() {
  if (process.platform !== 'linux') throw new Error('service commands are only available on Linux (systemd).');
}

function requireSystemd() {
  requireLinux();
  const res = spawnSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(
      'could not reach the systemd user manager (`systemctl --user`). ' +
        'This needs systemd and a user session; over SSH, log in normally rather than with `su`.',
    );
  }
}

export function buildUnit({ name, entry, workingDir, serverArgs, env }) {
  const execStart = [process.execPath, entry, ...serverArgs].map(quoteArg).join(' ');
  const remove = name === 'webterm' ? 'webterm uninstall-service' : `webterm uninstall-service --name ${name}`;
  return `# Created by \`webterm install-service\`. Remove with \`${remove}\`.
[Unit]
Description=webterm (browser terminal)
After=network-online.target
# Never give up restarting (see RestartSec below).
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${workingDir.replace(/%/g, '%%')}
ExecStart=${execStart}
${Object.entries(env)
  .map(([k, v]) => `Environment=${quoteEnv(k, v)}`)
  .join('\n')}
Restart=always
# The bind address may not exist yet at boot (e.g. DHCP); keep retrying.
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * @param {object} o
 * @param {string} o.name        unit name (without .service)
 * @param {string} o.entry       absolute path to bin/webterm.js
 * @param {string[]} o.serverArgs  arguments for `webterm` (host, port, ...)
 * @param {boolean} o.dryRun     only print the unit file
 */
export function installService({ name, entry, serverArgs, dryRun }) {
  requireLinux(); // also for --dry-run: a systemd unit is meaningless elsewhere
  if (!validName(name)) throw new Error(`invalid service name "${name}"`);

  // Keep the environment the shells will see close to the user's own.
  // (Without the entries npm adds when this runs via `npm run` or npx.)
  const env = { PATH: cleanPath(process.env.PATH) };
  for (const k of ['LANG', 'LC_ALL']) if (process.env[k]) env[k] = process.env[k];

  const unit = buildUnit({ name, entry, workingDir: process.cwd(), serverArgs, env });
  const unitPath = path.join(unitDir(), `${name}.service`);

  if (entry.includes(`${path.sep}_npx${path.sep}`)) {
    console.warn(
      'warning: webterm is running from the npx cache, which npm may clean up at any time.\n' +
        '         Install it globally first (npm install -g @quincyhuang/webterm), then run\n' +
        '         `webterm install-service` so the service points at a stable path.\n',
    );
  }

  if (dryRun) {
    console.log(`# would write ${unitPath}\n`);
    process.stdout.write(unit);
    return;
  }

  requireSystemd();

  const existed = fs.existsSync(unitPath);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit);
  console.log(`${existed ? 'Updated' : 'Wrote'} ${unitPath}`);

  for (const args of [['daemon-reload'], ['enable', `${name}.service`], ['restart', `${name}.service`]]) {
    const res = systemctl(...args);
    if (!res.ok) throw new Error(`systemctl --user ${args.join(' ')} failed:\n${res.out.trim()}`);
  }

  // Lingering keeps user services running after logout and starts them at boot.
  const user = os.userInfo().username;
  let linger = '';
  try {
    linger = execFileSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { encoding: 'utf8' }).trim();
  } catch {
    /* no logind session info */
  }
  if (linger !== 'yes') {
    const res = spawnSync('loginctl', ['enable-linger', user], { encoding: 'utf8' });
    if (res.status === 0) console.log(`Enabled lingering for ${user}, so webterm runs at boot and after you log out.`);
    else
      console.warn(
        `warning: could not enable lingering. Without it, webterm stops when you log out.\n` +
          `         Run:  sudo loginctl enable-linger ${user}`,
      );
  }

  // Give it a moment to fail fast (bad credentials, port in use) before reporting success.
  spawnSync('sleep', ['2']);
  const active = systemctl('is-active', `${name}.service`).out.trim();
  const logs = spawnSync('journalctl', ['--user', '-u', `${name}.service`, '-n', '5', '--no-pager', '-o', 'cat'], {
    encoding: 'utf8',
  }).stdout;
  console.log(`\nService ${name}: ${active}`);
  if (logs?.trim()) console.log(logs.trim().replace(/^/gm, '  '));
  console.log(`
Manage it with:
  systemctl --user status ${name}      # state
  journalctl --user -u ${name} -f      # logs
  systemctl --user restart ${name}     # after changing credentials or .env
  webterm uninstall-service${name === 'webterm' ? '' : ` --name ${name}`}`);
  if (active !== 'active') throw new Error('the service is not running; see the logs above.');
}

export function uninstallService({ name }) {
  if (!validName(name)) throw new Error(`invalid service name "${name}"`);
  requireSystemd();
  const unitPath = path.join(unitDir(), `${name}.service`);
  if (!fs.existsSync(unitPath)) throw new Error(`no service installed at ${unitPath}`);
  systemctl('disable', '--now', `${name}.service`);
  fs.unlinkSync(unitPath);
  systemctl('daemon-reload');
  systemctl('reset-failed', `${name}.service`);
  console.log(`Stopped and removed ${unitPath}`);
}
