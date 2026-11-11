// Color themes: a terminal palette (xterm.js theme) plus page colors derived from it.
//
// The choice is saved per browser in localStorage:
//   webterm.theme      { mode: 'fixed', fixed: T } | { mode: 'system', light: T, dark: T }
//                      where T = { name, colors } (colors = an xterm.js theme)
//   webterm.themeVars  the page's CSS variables for that choice, so the login page and the
//                      app can apply them before first paint (see the inline <head> scripts)

const THEME_KEY = 'webterm.theme';
const VARS_KEY = 'webterm.themeVars';

// The default: Ghostty's built-in colors (ghostty-org/ghostty: src/terminal/color.zig for the
// 16-color palette, src/config/Config.zig for background/foreground). Ghostty draws selections
// as inverted window colors, i.e. a white highlight with dark text, and the cursor in the
// foreground color.
export const DEFAULT_THEME = {
  name: 'Ghostty default',
  colors: {
    background: '#282c34',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#282c34',
    selectionBackground: '#ffffff',
    selectionForeground: '#282c34',
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
  },
};

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** Blend `b` into `a` by fraction t (0 = a, 1 = b). */
function mix(a, b, t) {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((v, i) => v + (y[i] - v) * t));
}

function luminance(color) {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** First candidate with enough contrast against bg; otherwise the best one available. */
function readable(bg, candidates, min = 3) {
  const ok = candidates.find((c) => c && contrast(c, bg) >= min);
  return ok || candidates.filter(Boolean).sort((a, b) => contrast(b, bg) - contrast(a, bg))[0];
}

export const isDark = (colors) => luminance(colors.background) < 0.4;

/** Page CSS variables for a terminal palette. */
export function deriveVars(theme) {
  if (theme.vars) return theme.vars;
  const c = theme.colors;
  const bg = c.background;
  const fg = c.foreground;
  const dark = isDark(c);
  const accent = readable(bg, [c.blue, c.brightBlue, c.cyan, c.magenta, fg]);
  return {
    '--bg': bg,
    '--panel': dark ? mix(bg, '#000000', 0.2) : mix(bg, fg, 0.05),
    '--surface': mix(bg, fg, 0.13),
    '--surface-2': mix(bg, fg, 0.22),
    '--text': fg,
    '--subtext': mix(fg, bg, 0.2),
    '--muted': readable(bg, [mix(fg, bg, 0.45), mix(fg, bg, 0.3)], 3),
    '--faint': mix(fg, bg, 0.6),
    '--accent': accent,
    '--accent-hover': mix(accent, dark ? '#000000' : '#ffffff', 0.15),
    // Text on accent-colored buttons: whichever of background/foreground reads better.
    '--on-accent': contrast(bg, accent) >= contrast(fg, accent) ? bg : fg,
    '--danger': readable(bg, [c.red, c.brightRed, fg]),
    '--success': readable(bg, [c.green, c.brightGreen, fg]),
    '--warning': readable(bg, [c.yellow, c.brightYellow, mix(c.yellow, fg, 0.5), fg]),
    '--pink': readable(bg, [c.magenta, c.brightMagenta, fg]),
    '--overlay': mix(bg, '#000000', dark ? 0.45 : 0.3) + 'cc',
    '--shadow': dark ? '#00000088' : '#00000033',
    // Not a custom property: native controls (checkboxes, scrollbars) match the theme.
    'color-scheme': dark ? 'dark' : 'light',
  };
}

// ---------------------------------------------------------------------------
// Saved choice
// ---------------------------------------------------------------------------
export function loadChoice() {
  try {
    const c = JSON.parse(localStorage.getItem(THEME_KEY) || 'null');
    if (c?.mode === 'system' && c.light?.colors && c.dark?.colors) return c;
    if (c?.mode === 'fixed' && c.fixed?.colors) return c;
  } catch {
    /* corrupt: fall back to the default */
  }
  return { mode: 'fixed', fixed: DEFAULT_THEME };
}

export function saveChoice(choice) {
  localStorage.setItem(THEME_KEY, JSON.stringify(choice));
  const vars =
    choice.mode === 'system'
      ? { light: deriveVars(choice.light), dark: deriveVars(choice.dark) }
      : { fixed: deriveVars(choice.fixed) };
  localStorage.setItem(VARS_KEY, JSON.stringify(vars));
}

const systemDark = matchMedia('(prefers-color-scheme: dark)');

/** The theme in effect right now (following the OS appearance in system mode). */
export function activeTheme(choice = loadChoice()) {
  if (choice.mode === 'system') return systemDark.matches ? choice.dark : choice.light;
  return choice.fixed;
}

/** Apply page colors (and the browser UI color) for a theme. Returns its xterm.js palette. */
export function applyPageTheme(theme) {
  const vars = deriveVars(theme);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars['--panel']);
  // Themes saved with hand-picked page colors (the pre-Ghostty default) have no color-scheme
  // entry; clear any left over from a previous theme.
  if (!vars['color-scheme']) root.removeProperty('color-scheme');
  return theme.colors;
}

/** Call fn() when the OS switches between light and dark. */
export function onSystemChange(fn) {
  systemDark.addEventListener('change', fn);
}
