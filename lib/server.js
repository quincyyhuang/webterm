import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as auth from './auth.js';
import * as files from './files.js';
import { ShellManager } from './shells.js';
import { Notifier } from './notify.js';
import { loadSettings, saveSettings } from './settings.js';

const require = createRequire(import.meta.url);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// URL path -> [absolute file path, content type]. Only these files are served, and only to
// logged-in users. xterm files are located via module resolution, because when installed
// from npm they may be hoisted outside this package's own node_modules.
const STATIC = {
  '/': [path.join(PUBLIC_DIR, 'index.html'), 'text/html'],
  '/app.js': [path.join(PUBLIC_DIR, 'app.js'), 'text/javascript'],
  '/style.css': [path.join(PUBLIC_DIR, 'style.css'), 'text/css'],
  '/files.js': [path.join(PUBLIC_DIR, 'files.js'), 'text/javascript'],
  '/bell.js': [path.join(PUBLIC_DIR, 'bell.js'), 'text/javascript'],
  '/notify-settings.js': [path.join(PUBLIC_DIR, 'notify-settings.js'), 'text/javascript'],
  '/xterm.js': [require.resolve('@xterm/xterm/lib/xterm.mjs'), 'text/javascript'],
  '/xterm.css': [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css'],
  '/addon-fit.js': [require.resolve('@xterm/addon-fit/lib/addon-fit.mjs'), 'text/javascript'],
  '/addon-web-links.js': [require.resolve('@xterm/addon-web-links/lib/addon-web-links.mjs'), 'text/javascript'],
};
const LOGIN_PAGE = path.join(PUBLIC_DIR, 'login.html');

const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function sendFile(res, file, type, status = 200) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(500, SECURITY_HEADERS).end('Error reading file');
      return;
    }
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': `${type}; charset=utf-8` }).end(data);
  });
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, { ...SECURITY_HEADERS, Location: location, ...headers }).end();
}

// Requests that change state must come from a page served by this server.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return !origin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isSecure(req) {
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new files.HttpError(413, 'Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new files.HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

/**
 * Start the webterm server. Resolves with the http.Server once it is listening.
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {string} options.shell
 * @param {object} options.credentials
 * @param {number} [options.maxUploadBytes] per-file upload limit in bytes; 0 = unlimited
 * @param {number} [options.detachedTimeoutMs] end the shared shell after this long with no tabs; 0 = never
 * @param {string} options.settingsPath where settings changed in the app are saved (settings.json)
 */
export function startServer({
  host,
  port,
  shell,
  credentials,
  maxUploadBytes = 0,
  detachedTimeoutMs = 0,
  settingsPath,
}) {
  // Push notification settings are edited in the app and saved to settings.json.
  let settings = loadSettings(settingsPath);
  let clickUrl = ''; // webterm's own address, learned from browser connections
  function makeNotifier(n) {
    if (!n?.url) return null;
    const notifier = new Notifier({ url: n.url, token: n.token, bell: n.bell });
    notifier.clickUrl = clickUrl;
    return notifier;
  }
  let notifier = null;
  try {
    notifier = makeNotifier(settings.notify);
  } catch (err) {
    console.warn(`[notify] ignoring saved settings: ${err.message}`);
  }
  if (notifier) console.log(`notifications: ${notifier.describe()}`);
  const notifyView = () => ({
    url: settings.notify?.url || '',
    hasToken: Boolean(settings.notify?.token),
    bell: Boolean(settings.notify?.bell),
  });

  const shells = new ShellManager({
    notifier,
    shell,
    cwd: os.homedir(),
    // webterm's own settings (including the password hash) are not passed on to shells.
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WEBTERM_'))),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    detachedTimeoutMs,
  });

  // /api/* endpoints for the files panel. The caller has already checked authentication.
  async function handleApi(req, res, url) {
    const q = url.searchParams;
    try {
      if (url.pathname === '/api/cwd' && req.method === 'GET') {
        const term = shells.get(q.get('term'));
        const cwd = (term && (await files.terminalCwd(term.pid))) || os.homedir();
        return sendJson(res, 200, { path: cwd });
      }
      if (url.pathname === '/api/list' && req.method === 'GET') {
        return sendJson(res, 200, await files.listDir(files.absPath(q.get('path'))));
      }
      if (url.pathname === '/api/download' && req.method === 'GET') {
        return await files.sendDownload(res, files.absPath(q.get('path')), SECURITY_HEADERS);
      }
      if (url.pathname === '/api/upload' && req.method === 'POST') {
        if (!sameOrigin(req)) throw new files.HttpError(403, 'Forbidden');
        const result = await files.receiveUpload(req, {
          dir: files.absPath(q.get('dir')),
          name: q.get('name'),
          overwrite: q.get('overwrite') === '1',
          maxBytes: maxUploadBytes,
        });
        console.log(`[files] uploaded ${result.path} (${result.size} bytes) from ${clientIp(req)}`);
        return sendJson(res, 201, result);
      }
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        return sendJson(res, 200, { notify: notifyView() });
      }
      if (url.pathname === '/api/settings/notify' && req.method === 'POST') {
        if (!sameOrigin(req)) throw new files.HttpError(403, 'Forbidden');
        const body = await readJson(req);
        const next = {
          url: typeof body.url === 'string' ? body.url.trim() : '',
          // token: omitted = keep the saved one, '' = remove it
          token: typeof body.token === 'string' ? body.token.trim() : settings.notify?.token || '',
          bell: Boolean(body.bell),
        };
        let created;
        try {
          created = makeNotifier(next);
        } catch (err) {
          throw new files.HttpError(400, err.message);
        }
        settings = { ...settings, notify: next.url ? next : undefined };
        saveSettings(settingsPath, settings);
        notifier = created;
        shells.notifier = created;
        console.log(`[notify] ${created ? `settings saved: ${created.describe()}` : 'notifications turned off'}`);
        return sendJson(res, 200, { notify: notifyView() });
      }
      if (url.pathname === '/api/settings/notify/test' && req.method === 'POST') {
        if (!sameOrigin(req)) throw new files.HttpError(403, 'Forbidden');
        if (!notifier) throw new files.HttpError(400, 'Notifications are off: save a topic URL first');
        const ok = await notifier.sendNow({
          title: 'webterm',
          message: `Test notification from webterm on ${os.hostname()}`,
          tags: 'white_check_mark',
        });
        if (!ok) throw new files.HttpError(502, `Could not reach ntfy: ${notifier.lastError}`);
        return sendJson(res, 200, { ok: true });
      }
      throw new files.HttpError(404, 'Not found');
    } catch (err) {
      const { status, message } = files.toHttpError(err);
      if (res.headersSent) return res.destroy();
      // Stop reading a rejected upload body, and close the connection so the client stops sending.
      if (req.method === 'POST' && !req.complete) res.setHeader('Connection', 'close');
      sendJson(res, status, { error: message });
    }
  }

  async function handleLogin(req, res) {
    const ip = clientIp(req);
    if (!sameOrigin(req)) return res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
    if (auth.isLockedOut(ip)) return redirect(res, '/login?error=locked');

    let form;
    try {
      form = await readForm(req);
    } catch {
      return res.writeHead(413, SECURITY_HEADERS).end('Request too large');
    }

    const ok = await auth.verifyCredentials(credentials, form.get('username') ?? '', form.get('password') ?? '');
    if (!ok) {
      auth.recordFailure(ip);
      console.warn(`[auth] failed login from ${ip}`);
      return redirect(res, auth.isLockedOut(ip) ? '/login?error=locked' : '/login?error=invalid');
    }

    auth.clearFailures(ip);
    console.log(`[auth] login from ${ip}`);
    const token = auth.createSession();
    redirect(res, '/', { 'Set-Cookie': auth.sessionCookie(token, isSecure(req)) });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;

    if (pathname === '/login') {
      if (req.method === 'POST') return handleLogin(req, res);
      if (auth.isAuthenticated(req)) return redirect(res, '/');
      return sendFile(res, LOGIN_PAGE, 'text/html');
    }

    if (pathname === '/logout' && req.method === 'POST') {
      if (!sameOrigin(req)) return res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
      const token = auth.getSessionToken(req);
      if (token) auth.destroySession(token);
      return redirect(res, '/login', { 'Set-Cookie': auth.clearedCookie() });
    }

    // Everything below requires a session.
    if (!auth.isAuthenticated(req)) {
      if (pathname === '/') return redirect(res, '/login');
      return res.writeHead(401, SECURITY_HEADERS).end('Unauthorized');
    }

    if (pathname === '/session') return res.writeHead(204, SECURITY_HEADERS).end();
    if (pathname.startsWith('/api/')) return handleApi(req, res, url);

    const entry = STATIC[pathname];
    if (!entry) return res.writeHead(404, SECURITY_HEADERS).end('Not found');
    sendFile(res, entry[0], entry[1]);
  });

  const wss = new WebSocketServer({ noServer: true });

  // Authenticate the WebSocket handshake before any shell is touched.
  // Query: mode=shared|tab (see lib/shells.js), cols, rows.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    let status = null;
    if (url.pathname !== '/pty') status = '404 Not Found';
    else if (!sameOrigin(req)) status = '403 Forbidden';
    else if (!auth.isAuthenticated(req)) status = '401 Unauthorized';

    if (status) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url.searchParams));
  });

  wss.on('connection', (ws, req, params) => {
    const mode = params.get('mode') === 'tab' ? 'tab' : 'shared';
    // Notifications link back to webterm at the address the browser used.
    if (req.headers.host) {
      clickUrl = `${isSecure(req) ? 'https' : 'http'}://${req.headers.host}/`;
      if (notifier) notifier.clickUrl = clickUrl;
    }
    const entry = shells.connect(ws, { mode, cols: params.get('cols'), rows: params.get('rows') });
    console.log(`[pty ${entry.pid}] tab connected from ${clientIp(req)} (${entry.clients.size} open)`);

    // Client -> server: JSON {type:'input', data} | {type:'resize', cols, rows} | {type:'focus'} |
    //                  {type:'watching', value} (tab visible and focused: no push notifications).
    // Server -> client: binary frames = terminal output; text frames = JSON control messages.
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (entry.active !== ws) shells.activate(entry, ws);
        entry.proc.write(msg.data);
      } else if (msg.type === 'resize') {
        shells.setSize(entry, ws, msg.cols, msg.rows);
      } else if (msg.type === 'focus') {
        shells.activate(entry, ws);
      } else if (msg.type === 'watching') {
        shells.setWatching(entry, ws, msg.value);
      }
    });

    ws.on('close', () => shells.disconnect(entry, ws));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
