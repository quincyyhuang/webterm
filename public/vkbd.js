// On-screen keyboard for the terminal. Opened from the header (⌨) or the last key of the
// extra-keys row. Keys are fed through term.input(), exactly like typing, so the extra-keys
// row's sticky Ctrl/Alt apply (Ctrl then "c" sends Ctrl+C). While it's open, the system
// on-screen keyboard is suppressed with inputmode="none" on xterm's hidden textarea; the
// textarea keeps focus, so a hardware keyboard still works.

const BKSP = { label: '⌫', send: '\x7f', cls: 'special', grow: 1.5, repeat: true, aria: 'Backspace' };
const ENTER = { label: '↵', send: '\r', cls: 'enter', grow: 1.5, aria: 'Enter' };
const SPACE = { label: 'space', send: ' ', cls: 'space', grow: 5, repeat: true, aria: 'Space' };
const GAP = { spacer: true, grow: 0.5 };
const keys = (s) => [...s].map((c) => ({ label: c, send: c }));

const LAYERS = {
  abc: [
    keys('1234567890'),
    keys('qwertyuiop'),
    [GAP, ...keys('asdfghjkl'), GAP],
    [{ label: '⇧', action: 'shift', cls: 'special', grow: 1.5, aria: 'Shift' }, ...keys('zxcvbnm'), BKSP],
    [{ label: '?123', action: 'layer', to: 'sym', cls: 'special', grow: 1.5 }, ...keys(','), SPACE, ...keys('./'), ENTER],
  ],
  sym: [
    keys('1234567890'),
    keys('!@#$%^&*()'),
    keys('-_=+[]{}\\|'),
    [...keys('~`;:\'"<>?'), BKSP],
    [{ label: 'abc', action: 'layer', to: 'abc', cls: 'special', grow: 1.5 }, ...keys(','), SPACE, ...keys('./'), ENTER],
  ],
};

/**
 * @param {object} o
 * @param {import('/xterm.js').Terminal} o.term
 * @param {HTMLElement[]} o.toggles  buttons that open/close the keyboard
 * @param {boolean} o.touch  touch device: don't pop the system keyboard back up on close
 */
export function initVirtualKeyboard({ term, toggles, touch }) {
  const el = document.getElementById('vkbd');
  let layer = 'abc';
  let shift = 'off'; // 'off' | 'once' | 'locked'
  let lastShiftTap = 0;

  function render() {
    el.replaceChildren();
    for (const row of LAYERS[layer]) {
      const r = document.createElement('div');
      r.className = 'vk-row';
      for (const k of row) {
        if (k.spacer) {
          const s = document.createElement('span');
          s.style.flexGrow = k.grow;
          r.append(s);
          continue;
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;
        b.className = `vk-key ${k.cls || ''}`;
        if (k.grow) b.style.flexGrow = k.grow;
        const upper = shift !== 'off' && /^[a-z]$/.test(k.label);
        b.textContent = upper ? k.label.toUpperCase() : k.label;
        if (k.aria) b.setAttribute('aria-label', k.aria);
        if (k.action === 'shift') {
          b.classList.toggle('active', shift === 'once');
          b.classList.toggle('locked', shift === 'locked');
          if (shift === 'locked') b.textContent = '⇪';
        }
        b._key = k;
        r.append(b);
      }
      el.append(r);
    }
  }

  function press(k) {
    if (k.action === 'layer') {
      layer = k.to;
      shift = 'off';
      return render();
    }
    if (k.action === 'shift') {
      const now = Date.now();
      shift = shift === 'once' && now - lastShiftTap < 400 ? 'locked' : shift === 'off' ? 'once' : 'off';
      lastShiftTap = now;
      return render();
    }
    let data = k.send;
    if (shift !== 'off' && /^[a-z]$/.test(data)) data = data.toUpperCase();
    term.input(data); // same path as typing: sticky Ctrl/Alt, reconnect-on-Enter, ...
    if (shift === 'once' && /^[a-zA-Z]$/.test(data)) {
      shift = 'off';
      render();
    }
  }

  // Keep focus where it is (tapping a key must not blur the terminal).
  el.addEventListener('pointerdown', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => e.preventDefault());

  // Keys fire on release (click); repeating keys (⌫, space) fire on press and repeat while held.
  let timer = null;
  let held = null;
  const stop = () => {
    clearTimeout(timer);
    clearInterval(timer);
    held?.classList.remove('pressed');
    held = null;
  };
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.vk-key');
    if (!b?._key.repeat) return;
    held = b;
    b.classList.add('pressed');
    press(b._key);
    timer = setTimeout(() => (timer = setInterval(() => press(b._key), 55)), 400);
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.vk-key');
    if (b && !b._key.repeat) press(b._key);
  });

  // ---- open / close ----
  const isOpen = () => !el.hidden;
  function suppressSystemKeyboard(on) {
    const ta = term.textarea;
    if (!ta) return;
    // Changing inputmode on a focused field doesn't always take effect, so blur first.
    const focused = document.activeElement === ta;
    if (focused) ta.blur();
    if (on) ta.setAttribute('inputmode', 'none');
    else ta.removeAttribute('inputmode');
    // Open: keep the terminal focused (hardware keyboards, cursor). Close: back to the terminal
    // on desktop; on touch devices stay blurred, so the system keyboard only appears when the
    // terminal is tapped.
    if (on || !touch) term.focus();
  }
  function setOpen(open) {
    if (open === isOpen()) return;
    el.hidden = !open;
    document.body.classList.toggle('vk-open', open);
    for (const t of toggles) {
      t.classList.toggle('active', open);
      t.setAttribute('aria-pressed', String(open));
    }
    if (open) {
      layer = 'abc';
      shift = 'off';
      render();
    }
    suppressSystemKeyboard(open);
  }
  for (const t of toggles) t.addEventListener('click', () => setOpen(!isOpen()));

  return { open: () => setOpen(true), close: () => setOpen(false), isOpen };
}
