import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import * as auth from './auth.js';

const require = createRequire(import.meta.url);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// URL path -> [absolute file path, content type]. Only these files are served, and only to
// logged-in users. xterm files are located via module resolution, because when installed
// from npm they may be hoisted outside this package's own node_modules.
const STATIC = {
  '/': [path.join(PUBLIC_DIR, 'index.html'), 'text/html'],
  '/app.js': [path.join(PUBLIC_DIR, 'app.js'), 'text/javascript'],
  '/style.css': [path.join(PUBLIC_DIR, 'style.css'), 'text/css'],
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
 * @param {{host: string, port: number, shell: string, credentials: object}} options
 */
export function startServer({ host, port, shell, credentials }) {
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
    const { pathname } = new URL(req.url, 'http://x');

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

    const entry = STATIC[pathname];
    if (!entry) return res.writeHead(404, SECURITY_HEADERS).end('Not found');
    sendFile(res, entry[0], entry[1]);
  });

  const wss = new WebSocketServer({ noServer: true });

  // Authenticate the WebSocket handshake before any shell is spawned.
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    let status = null;
    if (pathname !== '/pty') status = '404 Not Found';
    else if (!sameOrigin(req)) status = '403 Forbidden';
    else if (!auth.isAuthenticated(req)) status = '401 Unauthorized';

    if (status) {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    console.log(`[pty ${term.pid}] started ${shell} for ${clientIp(req)}`);

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    term.onExit(({ exitCode }) => {
      console.log(`[pty ${term.pid}] exited (${exitCode})`);
      if (ws.readyState === ws.OPEN) ws.close(1000, 'Shell exited');
    });

    // Client protocol: JSON messages {type: 'input', data} or {type: 'resize', cols, rows}.
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
        term.resize(Math.floor(msg.cols), Math.floor(msg.rows));
      }
    });

    ws.on('close', () => {
      try {
        term.kill();
      } catch {
        /* already exited */
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
