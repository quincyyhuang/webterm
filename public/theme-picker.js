// Theme picker (⚙ → Theme): search the ~900 bundled schemes, preview on hover/focus, click to
// choose. "Follow system" keeps one light and one dark theme and switches with the OS.

import { DEFAULT_THEME, loadChoice, saveChoice, activeTheme, isDark } from '/theme.js';

const $ = (id) => document.getElementById(id);

const POPULAR = [
  'Catppuccin Mocha', 'Catppuccin Latte', 'Dracula', 'TokyoNight', 'TokyoNight Day', 'Nord', 'Gruvbox Dark',
  'Gruvbox Light', 'iTerm2 Solarized Dark', 'iTerm2 Solarized Light', 'One Half Dark', 'One Half Light',
  'GitHub Dark', 'GitHub Light Default', 'Rose Pine', 'Rose Pine Dawn', 'Kanagawa Wave', 'Everforest Dark Med',
  'Monokai Pro', 'Ayu', 'Ayu Light', 'Night Owl', 'Atom One Dark', 'Tomorrow Night',
];
const SWATCH = ['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];

/**
 * @param {{ apply: (theme: {name, colors}) => void }} o  shows a theme on the page and terminal
 */
export function initThemePicker({ apply }) {
  const modal = $('themes');
  const list = $('themes-list');
  const search = $('themes-search');
  const nameEl = $('theme-name');
  let themes = null; // [{ name, dark, colors }], loaded on first open
  let choice = loadChoice();
  let slot = 'fixed'; // which theme a click sets: 'fixed', or 'light'/'dark' in system mode
  let filter = 'all';
  let rows = []; // { li, btn, theme } for every listed theme
  let sections = []; // { header, rows } for "Popular" and "All themes"

  const current = () => choice[slot];
  const showName = () => {
    nameEl.textContent =
      choice.mode === 'system' ? `${choice.light.name} / ${choice.dark.name}` : choice.fixed.name;
  };
  showName();

  async function load() {
    if (themes) return;
    list.innerHTML = '<li class="empty">Loading themes…</li>';
    try {
      const res = await fetch('/themes.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      themes = [{ name: DEFAULT_THEME.name, dark: true, colors: DEFAULT_THEME.colors }, ...(await res.json()).themes];
    } catch (err) {
      list.innerHTML = `<li class="empty">Could not load themes: ${err.message}</li>`;
      throw err;
    }
    renderList();
  }

  // Build every row once; filtering just hides rows.
  function renderList() {
    list.replaceChildren();
    const byName = new Map(themes.map((t) => [t.name, t]));
    const popular = [DEFAULT_THEME.name, ...POPULAR].map((n) => byName.get(n)).filter(Boolean);
    rows = [];
    const section = (title, items) => {
      const h = document.createElement('li');
      h.className = 'section';
      h.textContent = title;
      list.append(h);
      const start = rows.length;
      for (const t of items) list.append(row(t));
      return { header: h, rows: rows.slice(start) };
    };
    sections = [section('Popular', popular), section(`All themes (${themes.length - 1})`, themes.slice(1))];
    applyFilter();
  }

  function row(theme) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'theme-row';
    btn.type = 'button';
    btn.dataset.name = theme.name;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = theme.colors.background;
    for (const k of SWATCH) {
      const dot = document.createElement('i');
      dot.style.background = theme.colors[k];
      sw.append(dot);
    }
    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = theme.name;
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = '✓';
    btn.append(sw, name, check);
    btn.addEventListener('pointerenter', () => preview(theme));
    btn.addEventListener('focus', () => preview(theme));
    btn.addEventListener('click', () => choose(theme));
    li.append(btn);
    rows.push({ li, btn, theme });
    return li;
  }

  function applyFilter() {
    const q = search.value.trim().toLowerCase();
    for (const s of sections) {
      let visible = 0;
      for (const r of s.rows) {
        const show =
          (!q || r.theme.name.toLowerCase().includes(q)) &&
          (filter === 'all' || (filter === 'dark') === r.theme.dark);
        r.li.hidden = !show;
        if (show) visible++;
      }
      // While searching, one flat list reads better than repeating matches under "Popular".
      s.header.hidden = !visible || (q && s === sections[0]);
      if (q && s === sections[0]) for (const r of s.rows) r.li.hidden = true;
    }
    markSelected();
  }

  function markSelected() {
    const name = current().name;
    for (const r of rows) r.btn.classList.toggle('selected', r.theme.name === name);
  }

  function preview(theme) {
    apply(theme);
  }

  function choose(theme) {
    choice = { ...choice, [slot]: { name: theme.name, colors: theme.colors } };
    saveChoice(choice);
    showName();
    syncModeUi();
    markSelected();
    preview(theme);
  }

  // ---- mode: fixed / follow system ----
  const systemToggle = $('themes-system');
  const slotTabs = $('themes-slots');
  function syncModeUi() {
    systemToggle.checked = choice.mode === 'system';
    slotTabs.hidden = choice.mode !== 'system';
    if (choice.mode === 'system') {
      $('slot-light').textContent = `Light: ${choice.light.name}`;
      $('slot-dark').textContent = `Dark: ${choice.dark.name}`;
      $('slot-light').classList.toggle('active', slot === 'light');
      $('slot-dark').classList.toggle('active', slot === 'dark');
    }
  }
  function setSlot(s) {
    slot = s;
    if (s === 'light' || s === 'dark') setFilter(s);
    syncModeUi();
    markSelected();
    preview(current());
  }
  systemToggle.addEventListener('change', () => {
    const active = activeTheme(choice);
    if (systemToggle.checked) {
      // Keep the current theme for its own appearance; pick a sensible partner for the other.
      // Dark partner: the default (Ghostty, which has no light variant); light: Catppuccin Latte.
      const partner = (dark) => (dark ? DEFAULT_THEME : themes?.find((t) => t.name === 'Catppuccin Latte'));
      const dark = isDark(active.colors) ? active : partner(true);
      const light = !isDark(active.colors) ? active : partner(false) || active;
      choice = { mode: 'system', light: { name: light.name, colors: light.colors }, dark: { name: dark.name, colors: dark.colors } };
      saveChoice(choice);
      setSlot(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    } else {
      choice = { mode: 'fixed', fixed: active };
      saveChoice(choice);
      setSlot('fixed');
      setFilter('all');
    }
    showName();
  });
  $('slot-light').addEventListener('click', () => setSlot('light'));
  $('slot-dark').addEventListener('click', () => setSlot('dark'));

  // ---- filter / search ----
  function setFilter(f) {
    filter = f;
    for (const b of document.querySelectorAll('#themes-filter button')) b.classList.toggle('active', b.dataset.filter === f);
    if (themes) applyFilter();
  }
  $('themes-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (b) setFilter(b.dataset.filter);
  });
  search.addEventListener('input', () => themes && applyFilter());

  // Leaving the list returns the preview to the chosen theme.
  list.addEventListener('pointerleave', () => preview(current()));

  // Arrow keys move through visible rows (each focus previews); Enter chooses.
  function visibleButtons() {
    return rows.filter((r) => !r.li.hidden).map((r) => r.btn);
  }
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = visibleButtons();
    if (!btns.length) return;
    e.preventDefault();
    const i = btns.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(i + 1, btns.length - 1)) : Math.max(i - 1, 0);
    btns[next].focus();
    btns[next].scrollIntoView({ block: 'nearest' });
  });

  // ---- open / close ----
  async function open() {
    choice = loadChoice(); // may have changed in another tab
    slot = choice.mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : 'fixed';
    filter = choice.mode === 'system' ? slot : 'all';
    search.value = '';
    // The picker is opened from the settings menu, which would otherwise sit on top of it.
    $('settings').hidden = true;
    $('settings-btn').setAttribute('aria-expanded', 'false');
    modal.hidden = false;
    document.body.classList.add('modal-open');
    syncModeUi();
    setFilter(filter);
    search.focus();
    await load();
    const sel = rows.find((r) => r.theme.name === current().name && !r.li.hidden);
    sel?.btn.scrollIntoView({ block: 'center' });
  }
  function close() {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    apply(activeTheme(choice)); // drop any preview
    onClose?.();
  }
  let onClose = null;
  $('theme-btn').addEventListener('click', () => open());
  $('themes-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  return {
    open,
    set onClose(fn) {
      onClose = fn;
    },
  };
}
