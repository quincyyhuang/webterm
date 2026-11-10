import { Terminal } from '/xterm.js';
import { FitAddon } from '/addon-fit.js';
import { WebLinksAddon } from '/addon-web-links.js';
import { initFiles } from '/files.js';

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
  theme: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b7066',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
  },
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
const fontSizeEl = document.getElementById('font-size');
fontSizeEl.textContent = String(fontSize);
document.getElementById('font-down').addEventListener('click', () => setFontSize(fontSize - 1));
document.getElementById('font-up').addEventListener('click', () => setFontSize(fontSize + 1));

term.onTitleChange((title) => {
  titleEl.textContent = title || 'webterm';
  document.title = title || 'webterm';
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

function connect() {
  setStatus('connecting', 'connecting…');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ mode: tabMode, cols: String(term.cols), rows: String(term.rows) });
  const socket = new WebSocket(`${proto}://${location.host}/pty?${params}`);
  socket.binaryType = 'arraybuffer';
  ws = socket;

  socket.onopen = () => setStatus('connected', 'connected');

  // Binary frames are terminal output; text frames are JSON control messages.
  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') {
      term.write(new Uint8Array(ev.data));
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'attached') {
      shellId = msg.id;
      statusEl.title = msg.shared ? 'Shared shell: the same in every tab' : 'This tab has its own shell';
      term.reset(); // a running shell's screen is re-sent in full right after this
      if (msg.restored) {
        setStatus('connected', 'resumed');
        setTimeout(() => ws === socket && socket.readyState === WebSocket.OPEN && setStatus('connected', 'connected'), 3000);
      }
    }
  };

  socket.onclose = async (ev) => {
    if (ws !== socket) return;
    shellId = null;
    // If the login expired (or the server restarted), go back to the login page.
    try {
      const res = await fetch('/session', { cache: 'no-store' });
      if (res.status === 401) {
        location.href = '/login';
        return;
      }
    } catch {
      /* server unreachable: fall through to the reconnect prompt */
    }
    let note;
    if (ev.code === 1000 && ev.reason === 'Shell exited') note = 'shell exited — press Enter to start a new one';
    else if (tabMode === 'tab') note = 'disconnected; this tab\'s shell has ended — press Enter to start a new one';
    else note = 'disconnected — press Enter to reconnect';
    setStatus('disconnected', 'disconnected — tap to reconnect');
    term.write(`\r\n\x1b[2m[${note}]\x1b[0m\r\n`);
  };
}

// With a shared shell open in several tabs, the shell's size follows the tab in use.
term.textarea?.addEventListener('focus', () => send({ type: 'focus' }));
window.addEventListener('focus', () => send({ type: 'focus' }));

function reconnect() {
  connect();
  term.focus();
}

statusEl.addEventListener('click', () => {
  if (ws.readyState === WebSocket.CLOSED) reconnect();
});

term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

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
  if (ws.readyState === WebSocket.CLOSED) {
    if (data === '\r') reconnect();
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
// like less/vim), tap to focus and open the keyboard.
// ---------------------------------------------------------------------------
let touchY = null;
let touchAccum = 0;
let touchMoved = false;

termEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) return;
    touchY = e.touches[0].clientY;
    touchAccum = 0;
    touchMoved = false;
  },
  { passive: true },
);

termEl.addEventListener(
  'touchmove',
  (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
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

termEl.addEventListener('touchend', () => {
  if (touchY !== null && !touchMoved) term.focus();
  touchY = null;
});

// ---------------------------------------------------------------------------
// Settings popover
// ---------------------------------------------------------------------------
function initSettings({ getShellMode, setShellMode, onClose }) {
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

initFiles({ getTermId: () => shellId, onClose: () => term.focus() });
initSettings({ getShellMode, setShellMode, onClose: () => term.focus() });

connect();
