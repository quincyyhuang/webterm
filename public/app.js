import { Terminal } from '/xterm.js';
import { FitAddon } from '/addon-fit.js';
import { WebLinksAddon } from '/addon-web-links.js';
import { initFiles } from '/files.js';
import { initBell } from '/bell.js';
import { initNotifySettings } from '/notify-settings.js';
import { activeTheme, applyPageTheme, onSystemChange } from '/theme.js';
import { initThemePicker } from '/theme-picker.js';

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('title');
const termEl = document.getElementById('terminal');
const keysEl = document.getElementById('keys');

// ---------------------------------------------------------------------------
// Viewport: keep the app sized to the *visible* area so the on-screen keyboard
// shrinks the terminal instead of covering it.
// ---------------------------------------------------------------------------
function updateViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty('--app-height', `${vv ? vv.height : window.innerHeight}px`);
  root.setProperty('--app-top', `${vv ? vv.offsetTop : 0}px`);
}
window.visualViewport?.addEventListener('resize', updateViewport);
window.visualViewport?.addEventListener('scroll', updateViewport);
window.addEventListener('resize', updateViewport);
updateViewport();

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
const FONT_KEY = 'webterm.fontSize';
const defaultFontSize = window.innerWidth < 600 ? 12 : 14;
let fontSize = Number(localStorage.getItem(FONT_KEY)) || defaultFontSize;

const term = new Terminal({
  cursorBlink: true,
  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
  fontSize,
  scrollback: 10000,
  allowProposedApi: true,
  // macOS: Option+drag makes a normal selection even when a program (e.g. Claude Code, vim
  // with mouse=a) captures the mouse. Elsewhere xterm.js uses Shift+drag for this.
  macOptionClickForcesSelection: true,
  theme: applyPageTheme(activeTheme()),
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(termEl);

// Mobile keyboards: no autocorrect / auto-capitalisation in a shell.
if (term.textarea) {
  for (const [k, v] of Object.entries({
    autocapitalize: 'off',
    autocorrect: 'off',
    autocomplete: 'off',
    spellcheck: 'false',
  })) {
    term.textarea.setAttribute(k, v);
  }
}

fit.fit();
term.focus();
new ResizeObserver(() => fit.fit()).observe(termEl);

function setFontSize(size) {
  fontSize = Math.min(28, Math.max(8, size));
  term.options.fontSize = fontSize;
  localStorage.setItem(FONT_KEY, String(fontSize));
  fontSizeEl.textContent = String(fontSize);
  fit.fit();
}
// Cursor style (per browser): block (default, like Ghostty), bar, underline, or block_hollow.
// xterm.js only draws a hollow block for an unfocused terminal, so "block_hollow" keeps its
// block cursor and restyles it as an outline in CSS (#terminal.cursor-hollow).
const CURSOR_KEY = 'webterm.cursorStyle';
const CURSOR_STYLES = ['block', 'bar', 'underline', 'block_hollow'];
function setCursorStyle(style) {
  if (!CURSOR_STYLES.includes(style)) style = 'block';
  localStorage.setItem(CURSOR_KEY, style);
  term.options.cursorStyle = style === 'block_hollow' ? 'block' : style;
  termEl.classList.toggle('cursor-hollow', style === 'block_hollow');
  for (const b of document.querySelectorAll('#cursor-style button')) {
    const on = b.dataset.cursor === style;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  }
}
setCursorStyle(localStorage.getItem(CURSOR_KEY) || 'block');
document.getElementById('cursor-style').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cursor]');
  if (b) setCursorStyle(b.dataset.cursor);
});
window.addEventListener('storage', (e) => {
  if (e.key === CURSOR_KEY) setCursorStyle(e.newValue); // changed in another tab
});

const fontSizeEl = document.getElementById('font-size');
fontSizeEl.textContent = String(fontSize);
document.getElementById('font-down').addEventListener('click', () => setFontSize(fontSize - 1));
document.getElementById('font-up').addEventListener('click', () => setFontSize(fontSize + 1));

// Title set by the shell/program, plus a bell marker while a bell rang in a tab you're not viewing.
let baseTitle = 'webterm';
let bellMarker = false;
function renderTitle() {
  titleEl.textContent = baseTitle;
  document.title = (bellMarker ? '🔔 ' : '') + baseTitle;
}
term.onTitleChange((title) => {
  baseTitle = title || 'webterm';
  renderTitle();
});
initBell({
  term,
  termEl,
  setMarker(on) {
    bellMarker = on;
    renderTitle();
  },
});

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
let ws;
let shellId = null; // the server-side shell this tab is attached to (also used by the files panel)

// Shell mode (saved per browser, read once when the tab opens so a tab never switches mode):
//   shared: every tab shows the same shell, which keeps running after tabs close or logout.
//   tab:    each tab gets its own shell, which ends when the tab closes or the user logs out.
const MODE_KEY = 'webterm.shellMode';
const getShellMode = () => (localStorage.getItem(MODE_KEY) === 'tab' ? 'tab' : 'shared');
const setShellMode = (mode) => localStorage.setItem(MODE_KEY, mode);
const tabMode = getShellMode();

function setStatus(state, text) {
  statusEl.className = state;
  statusEl.textContent = text;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Connection lifecycle. Drops are retried automatically with growing delays; the shared shell
// (and, for a couple of minutes, a per-tab shell) keeps running on the server meanwhile, and
// its screen is restored exactly on reconnect.
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000, 15000, 30000];
const STALE_MS = 40000; // the server sends something at least every 15 s; silence this long = dead link
let retryAttempt = 0;
let retryTimer = null;
let lastMessageAt = 0;
let tabShellId = null; // per-tab mode: our shell, to resume after a drop (lives only as long as this page)
let waitingForEnter = false; // the shell exited: start a new one only when the user asks

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  waitingForEnter = false;
  setStatus('connecting', retryAttempt ? 'reconnecting…' : 'connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ mode: tabMode, cols: String(term.cols), rows: String(term.rows) });
  if (tabMode === 'tab' && tabShellId) params.set('resume', tabShellId);
  const socket = new WebSocket(`${proto}://${location.host}/pty?${params}`);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => {
    retryAttempt = 0;
    lastMessageAt = Date.now();
    setStatus('connected', 'connected');
  };

  // Binary frames are terminal output; text frames are JSON control messages.
  socket.onmessage = (ev) => {
    lastMessageAt = Date.now();
    if (typeof ev.data !== 'string') {
      term.write(new Uint8Array(ev.data));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'attached') {
      const lostTabShell = tabMode === 'tab' && tabShellId && tabShellId !== msg.id;
      shellId = msg.id;
      if (tabMode === 'tab') tabShellId = msg.id;
      statusEl.title = msg.shared ? 'Shared shell: the same in every tab' : 'This tab has its own shell';
      term.reset(); // a running shell's screen is re-sent in full right after this
      if (lostTabShell) term.write('\x1b[2m[the previous shell ended while disconnected; this is a new one]\x1b[0m\r\n');
      reportWatching();
      if (msg.restored) {
        setStatus('connected', 'resumed');
        setTimeout(() => ws === socket && socket.readyState === WebSocket.OPEN && setStatus('connected', 'connected'), 3000);
      }
    }
    // {type:'ping'} needs no reply: it only proves the link is alive (lastMessageAt above).
  };

  socket.onclose = (ev) => {
    if (ws === socket) handleDisconnect(ev.code, ev.reason);
  };
}

async function handleDisconnect(code, reason) {
  shellId = null;
  // If the login expired (or the server restarted), go back to the login page.
  try {
    const res = await fetch('/session', { cache: 'no-store' });
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
  } catch {
    /* server unreachable (network down): keep retrying below */
  }
  if (code === 1000 && reason === 'Shell exited') {
    tabShellId = null;
    waitingForEnter = true;
    setStatus('disconnected', 'shell exited');
    term.write('\r\n\x1b[2m[shell exited — press Enter to start a new one]\x1b[0m\r\n');
    return;
  }
  scheduleRetry();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const base = RETRY_DELAYS[Math.min(retryAttempt, RETRY_DELAYS.length - 1)];
  const delay = Math.round(base * (0.8 + Math.random() * 0.4)); // jitter
  retryAttempt++;
  setStatus('disconnected', navigator.onLine === false ? 'offline — waiting for network' : 'reconnecting…');
  retryTimer = setTimeout(connect, delay);
}

/** Give up on a connection that went silent (its close event may take minutes) and retry now. */
function dropStaleConnection() {
  const socket = ws;
  socket.onclose = socket.onmessage = socket.onopen = null;
  try {
    socket.close();
  } catch {
    /* already closing */
  }
  retryAttempt = 0;
  handleDisconnect(0, 'stale');
}

/** Reconnect right away, e.g. when the tab becomes visible again or the network comes back. */
function reconnectNow() {
  if (waitingForEnter) return;
  if (ws.readyState === WebSocket.OPEN) {
    if (Date.now() - lastMessageAt > STALE_MS) dropStaleConnection();
    return;
  }
  if (ws.readyState === WebSocket.CONNECTING) return;
  retryAttempt = 0;
  connect();
}

setInterval(() => {
  if (ws.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > STALE_MS) dropStaleConnection();
}, 5000);
window.addEventListener('online', reconnectNow);
window.addEventListener('pageshow', reconnectNow); // back from the back/forward cache
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) reconnectNow(); // phones drop connections in the background
});

// Leaving the page on purpose (closing the tab, reloading, logging out): tell the server, so a
// per-tab shell ends now instead of waiting out the reconnect grace period.
window.addEventListener('pagehide', () => {
  clearTimeout(retryTimer);
  send({ type: 'bye' });
});

// With a shared shell open in several tabs, the shell's size follows the tab in use.
term.textarea?.addEventListener('focus', () => send({ type: 'focus' }));
window.addEventListener('focus', () => send({ type: 'focus' }));

// Tell the server whether you're looking at this tab, so it only sends push notifications
// (if configured) when you aren't.
const reportWatching = () => send({ type: 'watching', value: !document.hidden && document.hasFocus() });
document.addEventListener('visibilitychange', reportWatching);
window.addEventListener('focus', reportWatching);
window.addEventListener('blur', reportWatching);

function reconnect() {
  retryAttempt = 0;
  connect();
  term.focus();
}

statusEl.addEventListener('click', () => {
  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) reconnect();
});

term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
const toastEl = document.getElementById('toast');
let toastTimer = null;
let toastAction = null;
function toast(text, kind = '', { action = null, duration = 1600 } = {}) {
  toastEl.textContent = text;
  toastEl.className = `show ${kind}${action ? ' action' : ''}`;
  toastAction = action;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = '';
    toastAction = null;
  }, duration);
}
toastEl.addEventListener('click', () => {
  const action = toastAction;
  if (!action) return;
  toastAction = null;
  action(); // runs inside a click, so the browser allows clipboard writes
});

// Over plain HTTP (not localhost) navigator.clipboard doesn't exist, so fall back to
// execCommand('copy'), filling in the clipboard from our own copy-event listener. Both need
// a user gesture (a key press or tap), which every caller here is.
function legacyCopy(text) {
  let done = false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    e.stopImmediatePropagation();
    done = true;
  };
  document.addEventListener('copy', onCopy, { capture: true });
  try {
    document.execCommand('copy');
  } catch {
    /* unsupported */
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true });
  }
  return done;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall back */
    }
  }
  return legacyCopy(text);
}

async function copySelection({ clear = false } = {}) {
  const text = term.getSelection();
  if (!text) {
    toast('Nothing selected');
    return;
  }
  const ok = await copyText(text);
  if (clear) term.clearSelection();
  if (selectMode && clear) setSelectMode(false);
  toast(ok ? 'Copied' : 'Copy failed: try right-click → Copy', ok ? '' : 'error');
}

// OSC 52: a program asks the terminal to put text on the clipboard ("\e]52;c;<base64>\a").
// Claude Code uses this for copy-on-select, as do vim/neovim and tmux (set-clipboard on).
// Writes only: clipboard *reads* ("?") are refused, so programs can't see your clipboard.
const OSC52_MAX = 1024 * 1024;
term.parser.registerOscHandler(52, (data) => {
  const sep = data.indexOf(';');
  const payload = sep < 0 ? '' : data.slice(sep + 1);
  if (!payload || payload === '?' || payload.length > (OSC52_MAX * 4) / 3 + 4) return true;
  let text;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    text = new TextDecoder().decode(bytes);
  } catch {
    return true; // not valid base64
  }
  // With a shared shell every open tab receives this; only the one you're using copies.
  if (!text || document.hidden || !document.hasFocus()) return true;
  osc52Copy(text);
  return true;
});

async function osc52Copy(text) {
  // Usually arrives right after your mouse-up, which counts as a recent user action, so the
  // copy is allowed even over plain HTTP. If the browser still refuses (e.g. Safari, which
  // only allows copying inside the click itself), offer a one-click copy.
  if (await copyText(text)) {
    toast('Copied');
    return;
  }
  const n = text.length;
  toast(`Click to copy ${n} character${n === 1 ? '' : 's'}`, '', {
    duration: 8000,
    action: () => {
      const ok = legacyCopy(text);
      toast(ok ? 'Copied' : 'Copy failed', ok ? '' : 'error');
      term.focus();
    },
  });
}

// Ctrl+Shift+C copies (and keeps the browser from opening DevTools' element picker).
// Ctrl+C copies when text is selected, like Windows Terminal; otherwise it interrupts as
// usual. On macOS, Cmd+C already copies natively, and Ctrl+C always goes to the terminal.
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown' || e.altKey || e.metaKey || !e.ctrlKey) return true;
  if (e.key.toLowerCase() !== 'c') return true;
  if (e.shiftKey) {
    e.preventDefault();
    copySelection();
    return false;
  }
  if (!isMac && term.hasSelection()) {
    e.preventDefault();
    copySelection({ clear: true }); // cleared, so a second Ctrl+C interrupts
    return false;
  }
  return true;
});

// ---------------------------------------------------------------------------
// Sticky modifiers (Ctrl / Alt) from the extra-keys bar.
// Tap = applies to the next key; double-tap = locked until tapped again.
// ---------------------------------------------------------------------------
const mods = { ctrl: 'off', alt: 'off' }; // 'off' | 'once' | 'locked'
const lastModTap = { ctrl: 0, alt: 0 };

function renderMods() {
  for (const btn of keysEl.querySelectorAll('[data-mod]')) {
    const state = mods[btn.dataset.mod];
    btn.classList.toggle('active', state === 'once');
    btn.classList.toggle('locked', state === 'locked');
  }
}

function toggleMod(name) {
  const now = Date.now();
  if (mods[name] === 'once' && now - lastModTap[name] < 400) mods[name] = 'locked';
  else mods[name] = mods[name] === 'off' ? 'once' : 'off';
  lastModTap[name] = now;
  renderMods();
}

function consumeMods() {
  const active = { ctrl: mods.ctrl !== 'off', alt: mods.alt !== 'off' };
  let changed = false;
  for (const k of ['ctrl', 'alt']) {
    if (mods[k] === 'once') {
      mods[k] = 'off';
      changed = true;
    }
  }
  if (changed) renderMods();
  return active;
}

function ctrlChar(ch) {
  const c = ch.toUpperCase();
  if (c >= '@' && c <= '_') return String.fromCharCode(c.charCodeAt(0) - 64);
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

function applyMods(data, active) {
  if (active.ctrl) data = ctrlChar(data);
  if (active.alt) data = '\x1b' + data;
  return data;
}

// All keystrokes (typed, pasted, or from the bar) go through here.
term.onData((data) => {
  if (ws.readyState !== WebSocket.OPEN) {
    // Not connected: Enter starts a new shell after `exit`, or retries right away after a drop.
    // The key itself is dropped, since we can't know what the shell will be doing.
    if (data === '\r' && ws.readyState !== WebSocket.CONNECTING) reconnect();
    return;
  }
  // Modifiers only make sense for a single typed character, not for pastes.
  if (data.length === 1 && (mods.ctrl !== 'off' || mods.alt !== 'off')) {
    data = applyMods(data, consumeMods());
  }
  send({ type: 'input', data });
});

// ---------------------------------------------------------------------------
// Extra-keys bar
// ---------------------------------------------------------------------------
const CURSOR_KEYS = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };
const TILDE_KEYS = { pgup: '5', pgdn: '6' };

function keySequence(name) {
  const active = consumeMods();
  const modParam = 1 + (active.alt ? 2 : 0) + (active.ctrl ? 4 : 0);
  if (name === 'esc') return '\x1b';
  if (name === 'tab') return active.ctrl || active.alt ? '\x1b[Z' : '\t';
  if (name in CURSOR_KEYS) {
    const code = CURSOR_KEYS[name];
    if (modParam > 1) return `\x1b[1;${modParam}${code}`;
    return (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + code;
  }
  if (name in TILDE_KEYS) {
    const n = TILDE_KEYS[name];
    return modParam > 1 ? `\x1b[${n};${modParam}~` : `\x1b[${n}~`;
  }
  return '';
}

function pressButton(btn) {
  const { key, text, mod, action } = btn.dataset;
  if (mod) return toggleMod(mod);
  if (key) return send({ type: 'input', data: keySequence(key) });
  if (text) return send({ type: 'input', data: applyMods(text, consumeMods()) });
  if (action === 'paste') return paste();
  if (action === 'keyboard') return toggleKeyboard();
  if (action === 'select') return setSelectMode(!selectMode);
  if (action === 'copy') return copySelection({ clear: true });
}

async function paste() {
  let text = null;
  try {
    // Only available in secure contexts (https / localhost).
    text = await navigator.clipboard.readText();
  } catch {
    text = window.prompt('Paste text to send to the terminal:');
  }
  if (text) term.paste(text);
  term.focus();
}

function toggleKeyboard() {
  if (document.activeElement === term.textarea) term.blur();
  else term.focus();
}

// Keep focus in the terminal while tapping the bar, so the soft keyboard stays open.
keysEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});
keysEl.addEventListener('mousedown', (e) => e.preventDefault());

// Normal buttons fire on click (so swiping the bar sideways doesn't press keys).
keysEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && !('repeat' in btn.dataset)) pressButton(btn);
});

// Repeating buttons (arrows): tap = one press, hold = auto-repeat.
let repeatTimer = null;
let repeatBtn = null;
let repeated = false;

function stopRepeat(fireIfTap) {
  if (!repeatBtn) return;
  clearTimeout(repeatTimer);
  clearInterval(repeatTimer);
  if (fireIfTap && !repeated) pressButton(repeatBtn);
  repeatBtn.classList.remove('pressed');
  repeatBtn = null;
}

keysEl.addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('button[data-repeat]');
  if (!btn) return;
  repeatBtn = btn;
  repeated = false;
  btn.classList.add('pressed');
  repeatTimer = setTimeout(() => {
    repeated = true;
    pressButton(btn);
    repeatTimer = setInterval(() => pressButton(btn), 60);
  }, 350);
});
keysEl.addEventListener('pointerup', () => stopRepeat(true));
keysEl.addEventListener('pointercancel', () => stopRepeat(false)); // e.g. bar was swiped
keysEl.addEventListener('pointerleave', () => stopRepeat(false));

// ---------------------------------------------------------------------------
// Touch: swipe to scroll scrollback (or send arrow keys in full-screen apps
// like less/vim), tap to focus and open the keyboard. In select mode (the
// "Select" key), dragging selects text instead and tapping selects a word.
// ---------------------------------------------------------------------------
let touchY = null;
let touchAccum = 0;
let touchMoved = false;
let selectMode = false;
let selectStart = null;

function setSelectMode(on) {
  selectMode = on;
  keysEl.querySelector('[data-action="select"]')?.classList.toggle('active', on);
  termEl.classList.toggle('selecting', on);
  if (on) toast('Drag to select, tap a word, then Copy');
}

/** Buffer cell (absolute row) under a touch point. */
function cellAt(touch) {
  const screen = term.element.querySelector('.xterm-screen');
  const rect = screen.getBoundingClientRect();
  const clamp = (n, max) => Math.min(Math.max(n, 0), max);
  const col = clamp(Math.floor(((touch.clientX - rect.left) / rect.width) * term.cols), term.cols - 1);
  const row = clamp(Math.floor(((touch.clientY - rect.top) / rect.height) * term.rows), term.rows - 1);
  return { col, row: row + term.buffer.active.viewportY };
}

function selectRange(a, b) {
  const [start, end] = a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  term.select(start.col, start.row, (end.row - start.row) * term.cols + end.col - start.col + 1);
}

function selectWordAt({ col, row }) {
  const line = term.buffer.active.getLine(row)?.translateToString(true) || '';
  if (!line[col] || /\s/.test(line[col])) return term.clearSelection();
  let from = col;
  let to = col;
  while (from > 0 && !/\s/.test(line[from - 1])) from--;
  while (to < line.length - 1 && !/\s/.test(line[to + 1])) to++;
  term.select(from, row, to - from + 1);
}

termEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
    touchAccum = 0;
    touchMoved = false;
    if (selectMode) selectStart = cellAt(e.touches[0]);
  },
  { passive: true },
);

termEl.addEventListener(
  'touchmove',
  (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (selectMode && selectStart) {
      touchMoved = true;
      selectRange(selectStart, cellAt(e.touches[0]));
      return;
    }
    const y = e.touches[0].clientY;
    touchAccum += touchY - y;
    touchY = y;
    if (Math.abs(touchAccum) > 8) touchMoved = true;

    const screen = term.element?.querySelector('.xterm-screen');
    const lineHeight = screen ? screen.clientHeight / term.rows : 17;
    const lines = Math.trunc(touchAccum / lineHeight);
    if (!lines) return;
    touchAccum -= lines * lineHeight;

    if (term.buffer.active.type === 'alternate') {
      // Full-screen app: no scrollback, so emulate arrow keys.
      const seq = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + (lines > 0 ? 'B' : 'A');
      send({ type: 'input', data: seq.repeat(Math.abs(lines)) });
    } else {
      term.scrollLines(lines);
    }
  },
  { passive: false },
);

termEl.addEventListener(
  'touchend',
  (e) => {
    if (selectMode) {
      // Stop the browser's emulated mousedown/click after a tap: xterm would treat it as a
      // click and clear the selection we just made.
      e.preventDefault();
      if (selectStart && !touchMoved) selectWordAt(selectStart);
      selectStart = null;
      touchY = null;
      return;
    }
    if (touchY !== null && !touchMoved) term.focus();
    touchY = null;
  },
  { passive: false },
);

// ---------------------------------------------------------------------------
// Settings popover
// ---------------------------------------------------------------------------
function initSettings({ getShellMode, setShellMode, onClose }) {
  const notifySettings = initNotifySettings();
  const btn = document.getElementById('settings-btn');
  const pop = document.getElementById('settings');
  const perTab = document.getElementById('shell-per-tab');
  const note = document.getElementById('shell-mode-note');

  function sync() {
    perTab.checked = getShellMode() === 'tab'; // may have been changed in another tab
    note.hidden = getShellMode() === tabMode;
  }
  perTab.addEventListener('change', () => {
    setShellMode(perTab.checked ? 'tab' : 'shared');
    sync();
  });

  function open() {
    sync();
    notifySettings.load();
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }
  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    onClose();
  }
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) close();
  });
}

// Color theme: the picker previews/applies themes; "follow system" reacts to OS changes.
const showTheme = (theme) => (term.options.theme = applyPageTheme(theme));
const themePicker = initThemePicker({ apply: showTheme });
themePicker.onClose = () => term.focus();
onSystemChange(() => {
  if (document.getElementById('themes').hidden) showTheme(activeTheme());
});

initFiles({ getTermId: () => shellId, onClose: () => term.focus() });
initSettings({ getShellMode, setShellMode, onClose: () => term.focus() });

connect();
