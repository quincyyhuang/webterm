// Environment hygiene. When webterm is started through npm (`npm start`, `npm run ...`, `npx`),
// npm adds its own entries to PATH (every ancestor's node_modules/.bin, its node-gyp shim, the
// npx cache) and sets npm_* variables, which change npm's own behavior. None of that belongs in
// the user's shells or in a service unit. The user's shell startup files still run inside each
// shell, so anything they add to PATH themselves is unaffected.

const NPM_PATH_ENTRY = [/\/node_modules\/\.bin\/?$/, /\/@npmcli\/run-script\/lib\/node-gyp-bin\/?$/, /\/_npx\//];

/** PATH without npm-injected entries, and without duplicates (first occurrence wins). */
export function cleanPath(value = '') {
  const seen = new Set();
  return value
    .split(':')
    .filter((p) => p && !NPM_PATH_ENTRY.some((re) => re.test(p)) && !seen.has(p) && seen.add(p))
    .join(':');
}

/** A copy of env without npm's variables and webterm's own settings (e.g. the password hash). */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^npm_/i.test(k) || k.startsWith('WEBTERM_') || k === 'INIT_CWD') continue;
    if (k === 'COLOR' && env.npm_lifecycle_event) continue; // set by npm run-script
    out[k] = v;
  }
  if (out.PATH) out.PATH = cleanPath(out.PATH);
  return out;
}
