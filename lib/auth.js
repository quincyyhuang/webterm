// Username/password auth with in-memory session cookies.
//
// Credentials come from (first match wins):
//   1. env:          WEBTERM_USER + WEBTERM_PASSWORD_HASH
//   2. config.json:  { "username": "...", "passwordHash": "..." }
//                    (default ~/.config/webterm/config.json; override with --config or WEBTERM_CONFIG)
//
// Password hashes use scrypt: "scrypt$<salt base64>$<hash base64>".
// Generate one with:  webterm set-password <username>

import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

export const SESSION_COOKIE = 'webterm_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function parseHash(stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  const salt = Buffer.from(parts[1], 'base64');
  const hash = Buffer.from(parts[2], 'base64');
  if (!salt.length || hash.length !== KEYLEN) return null;
  return { salt, hash };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export function loadCredentials(configPath) {
  let username = process.env.WEBTERM_USER;
  let passwordHash = process.env.WEBTERM_PASSWORD_HASH;
  let source = 'environment';

  if (!username || !passwordHash) {
    if (!fs.existsSync(configPath)) {
      throw new Error(
        `No credentials configured. Set WEBTERM_USER and WEBTERM_PASSWORD_HASH, ` +
          `or create ${configPath} with:  webterm set-password <username>`,
      );
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    username = config.username;
    passwordHash = config.passwordHash;
    source = configPath;
  }

  if (!username) throw new Error(`Missing username (from ${source})`);
  const parsed = parseHash(passwordHash);
  if (!parsed) {
    throw new Error(`Invalid password hash (from ${source}); expected "scrypt$<salt>$<hash>"`);
  }
  return { username, ...parsed, source };
}

export async function verifyCredentials(creds, username, password) {
  // Always run scrypt so a wrong username takes as long as a wrong password.
  const candidate = await scrypt(String(password), creds.salt, KEYLEN);
  const passOk = crypto.timingSafeEqual(candidate, creds.hash);
  const a = crypto.createHash('sha256').update(String(username)).digest();
  const b = crypto.createHash('sha256').update(creds.username).digest();
  const userOk = crypto.timingSafeEqual(a, b);
  return passOk && userOk;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> expiry timestamp

export function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
}

export function getSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export function isAuthenticated(req) {
  const token = getSessionToken(req);
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function sessionCookie(token, secure) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// ---------------------------------------------------------------------------
// Brute-force protection: lock an IP out after repeated failures.
// ---------------------------------------------------------------------------
const failures = new Map(); // ip -> { count, resetAt }

export function isLockedOut(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (f.resetAt < Date.now()) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

export function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + LOCKOUT_MS });
  else f.count++;
}

export function clearFailures(ip) {
  failures.delete(ip);
}

// Periodically drop expired sessions and stale failure records.
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  for (const [ip, f] of failures) if (f.resetAt < now) failures.delete(ip);
}, 60 * 60 * 1000).unref();
