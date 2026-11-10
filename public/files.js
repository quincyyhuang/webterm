// Files panel: browse the server's file system, download files, upload files.

const $ = (id) => document.getElementById(id);

// Inline SVG icons (emoji are missing on many desktop Linux systems).
const svg = (d) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
const ICONS = {
  dir: svg('M3 6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.4.6L12 6h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
  file: svg('M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V9h5.5z'),
  other: svg('M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 14v2h2v-2zm1-10a4 4 0 0 0-4 4h2a2 2 0 1 1 3 1.7c-1.2.7-2 1.5-2 3.3h2c0-1 .4-1.4 1-1.8A4 4 0 0 0 12 6z'),
};

function formatSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${i === 0 ? bytes : bytes.toFixed(bytes < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  });
}

function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

async function api(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Not logged in');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export function initFiles({ getTermId, onClose }) {
  const modal = $('files');
  const list = $('files-list');
  const crumbs = $('files-path');
  const errorEl = $('files-error');
  const transfers = $('files-transfers');
  const fileInput = $('files-input');
  const hiddenToggle = $('files-hidden');

  let current = null; // listing currently shown: { path, parent, entries }
  let loadSeq = 0;

  hiddenToggle.checked = localStorage.getItem('webterm.showHidden') === '1';

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  async function shellCwd() {
    const { path } = await api(`/api/cwd?term=${encodeURIComponent(getTermId() || '')}`);
    return path;
  }

  async function navigate(path) {
    const seq = ++loadSeq;
    list.setAttribute('aria-busy', 'true');
    try {
      const listing = await api(`/api/list?path=${encodeURIComponent(path)}`);
      if (seq !== loadSeq) return; // a newer navigation won
      current = listing;
      showError('');
      render();
    } catch (err) {
      if (seq === loadSeq) showError(`${path}: ${err.message}`);
    } finally {
      if (seq === loadSeq) list.removeAttribute('aria-busy');
    }
  }

  function renderCrumbs(path) {
    crumbs.replaceChildren();
    const addButton = (label, target) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = target;
      b.addEventListener('click', () => navigate(target));
      crumbs.append(b);
    };
    addButton('/', '/');
    let acc = '';
    path
      .split('/')
      .filter(Boolean)
      .forEach((part, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'sep';
          sep.textContent = '/';
          crumbs.append(sep);
        }
        acc += `/${part}`;
        addButton(part, acc);
      });
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function render() {
    renderCrumbs(current.path);
    $('files-up').disabled = !current.parent;
    const showHidden = hiddenToggle.checked;
    const entries = current.entries.filter((e) => showHidden || !e.name.startsWith('.'));

    list.replaceChildren();
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = current.entries.length ? 'Only hidden files here' : 'Empty directory';
      list.append(li);
      return;
    }

    for (const e of entries) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = `entry ${e.type}`;
      const full = joinPath(current.path, e.name);

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.innerHTML = ICONS[e.type] || ICONS.other;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.name + (e.link ? ' →' : '');
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = [formatSize(e.size), formatDate(e.mtime)].filter(Boolean).join(' · ');
      btn.append(icon, name, meta);

      if (e.type === 'dir') {
        btn.title = `Open ${e.name}`;
        btn.addEventListener('click', () => navigate(full));
      } else if (e.type === 'file') {
        btn.title = `Download ${e.name}`;
        btn.addEventListener('click', () => download(full));
      } else {
        btn.disabled = true;
      }
      li.append(btn);
      list.append(li);
    }
  }

  function download(path) {
    const a = document.createElement('a');
    a.href = `/api/download?path=${encodeURIComponent(path)}`;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  }

  // --- uploads -------------------------------------------------------------

  function addTransferRow(name) {
    const row = document.createElement('div');
    row.className = 'transfer';
    const label = document.createElement('span');
    label.className = 'tname';
    label.textContent = name;
    const status = document.createElement('span');
    status.className = 'tstatus';
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = 0;
    row.append(label, status, bar);
    transfers.append(row);
    return {
      progress(fraction) {
        bar.value = fraction;
        status.textContent = `${Math.floor(fraction * 100)}%`;
      },
      done() {
        row.classList.add('ok');
        status.textContent = 'done';
        bar.value = 1;
        setTimeout(() => row.remove(), 2500);
      },
      fail(message) {
        row.classList.add('failed');
        status.textContent = message;
        bar.remove();
        row.title = 'Click to dismiss';
        row.addEventListener('click', () => row.remove());
      },
    };
  }

  function sendFile(file, dir, overwrite, onProgress) {
    return new Promise((resolve) => {
      const q = new URLSearchParams({ dir, name: file.name });
      if (overwrite) q.set('overwrite', '1');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?${q}`);
      xhr.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON error body */
        }
        resolve({ status: xhr.status, error: body.error });
      };
      xhr.onerror = () => resolve({ status: 0, error: 'Network error' });
      xhr.send(file);
    });
  }

  async function uploadOne(file, dir) {
    const row = addTransferRow(file.name);
    let overwrite = false;
    for (;;) {
      const { status, error } = await sendFile(file, dir, overwrite, row.progress);
      if (status === 201) return row.done();
      if (status === 401) return (location.href = '/login');
      if (status === 409 && !overwrite && error === 'File already exists') {
        if (confirm(`"${file.name}" already exists in ${dir}. Replace it?`)) {
          overwrite = true;
          continue;
        }
        return row.fail('skipped (exists)');
      }
      return row.fail(error || `failed (HTTP ${status})`);
    }
  }

  async function upload(fileList) {
    const items = [...fileList];
    if (!items.length) return;
    if (!current) await navigate(await shellCwd());
    if (!current) return;
    const dir = current.path;
    // One at a time keeps progress readable and avoids saturating slow links.
    for (const file of items) await uploadOne(file, dir);
    if (current?.path === dir) navigate(dir);
  }

  // --- open / close --------------------------------------------------------

  async function open() {
    modal.hidden = false;
    document.body.classList.add('modal-open');
    try {
      await navigate(await shellCwd());
    } catch (err) {
      showError(err.message);
    }
    $('files-close').focus();
  }

  function close() {
    modal.hidden = true;
    document.body.classList.remove('modal-open');
    onClose?.();
  }

  $('files-btn').addEventListener('click', open);
  $('files-close').addEventListener('click', close);
  $('files-up').addEventListener('click', () => current?.parent && navigate(current.parent));
  $('files-shell').addEventListener('click', async () => navigate(await shellCwd()));
  $('files-refresh').addEventListener('click', () => current && navigate(current.path));
  $('files-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    upload(fileInput.files);
    fileInput.value = '';
  });
  hiddenToggle.addEventListener('change', () => {
    localStorage.setItem('webterm.showHidden', hiddenToggle.checked ? '1' : '0');
    if (current) render();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      e.preventDefault();
      close();
    }
  });

  // Drag and drop anywhere on the page: opens the panel and uploads into the directory shown.
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const dropped = [...e.dataTransfer.files];
    if (modal.hidden) await open();
    upload(dropped);
  });

  return { open, close };
}
