// Regenerate public/themes.json from https://github.com/mbadolato/iTerm2-Color-Schemes
// (MIT). Uses its Windows Terminal exports, whose keys map almost 1:1 onto xterm.js themes.
//
//   npm run update-themes
//
// Development-only: the generated file is committed and shipped with the package, so webterm
// never contacts GitHub at runtime.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'mbadolato/iTerm2-Color-Schemes';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'themes.json');
const LICENSE_OUT = path.join(ROOT, 'public', 'themes-license.txt');

const HEX = /^#[0-9a-f]{6}$/i;
const KEYS = {
  // Windows Terminal key -> xterm.js key
  background: 'background',
  foreground: 'foreground',
  cursorColor: 'cursor',
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  purple: 'magenta',
  cyan: 'cyan',
  white: 'white',
  brightBlack: 'brightBlack',
  brightRed: 'brightRed',
  brightGreen: 'brightGreen',
  brightYellow: 'brightYellow',
  brightBlue: 'brightBlue',
  brightPurple: 'brightMagenta',
  brightCyan: 'brightCyan',
  brightWhite: 'brightWhite',
};

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': 'webterm-update-themes' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === 'json' ? res.json() : res.text();
}

/** WCAG relative luminance of #rrggbb. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function convert(src) {
  const colors = {};
  for (const [from, to] of Object.entries(KEYS)) {
    const v = typeof src[from] === 'string' ? src[from].trim().toLowerCase() : '';
    if (HEX.test(v)) colors[to] = v;
  }
  const required = Object.values(KEYS).filter((k) => k !== 'cursor');
  if (!required.every((k) => colors[k])) return null;
  colors.cursor ??= colors.foreground;
  colors.cursorAccent = colors.background; // text under a block cursor stays readable
  // Schemes give an opaque selection colour; make it translucent so selected text stays visible.
  const sel = HEX.test(src.selectionBackground || '') ? src.selectionBackground.toLowerCase() : colors.foreground;
  colors.selectionBackground = sel + (HEX.test(src.selectionBackground || '') ? 'aa' : '40');
  return { name: src.name, dark: luminance(colors.background) < 0.4, colors };
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

const commit = (await get(`https://api.github.com/repos/${REPO}/commits/master`)).sha;
const listing = await get(`https://api.github.com/repos/${REPO}/contents/windowsterminal?ref=${commit}`);
const files = listing.filter((f) => f.type === 'file' && f.name.endsWith('.json'));
if (files.length >= 1000) console.warn('warning: GitHub lists at most 1000 files; some themes may be missing');
console.log(`Fetching ${files.length} themes from ${REPO}@${commit.slice(0, 7)}…`);

let skipped = 0;
const themes = (
  await pool(files, 16, async (f) => {
    try {
      const t = convert(await get(`https://raw.githubusercontent.com/${REPO}/${commit}/windowsterminal/${encodeURIComponent(f.name)}`));
      if (!t) skipped++;
      return t;
    } catch (err) {
      skipped++;
      console.warn(`  skipped ${f.name}: ${err.message}`);
      return null;
    }
  })
)
  .filter(Boolean)
  .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

const data = {
  source: `https://github.com/${REPO}`,
  commit,
  license: 'MIT (see themes-license.txt)',
  generated: new Date().toISOString().slice(0, 10),
  themes,
};
fs.writeFileSync(OUT, JSON.stringify(data) + '\n');
fs.writeFileSync(LICENSE_OUT, await get(`https://raw.githubusercontent.com/${REPO}/${commit}/LICENSE`, 'text'));
console.log(
  `Wrote ${themes.length} themes (${themes.filter((t) => t.dark).length} dark, ${themes.filter((t) => !t.dark).length} light; ` +
    `${skipped} skipped) to ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`,
);
