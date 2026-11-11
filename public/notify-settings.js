// Push notification (ntfy) settings in the ⚙ menu. These are saved on the server (shared by
// every browser), because the server is what sends the notifications.

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// A long random topic: on ntfy.sh, the topic name is effectively the password.
function randomTopic() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return 'webterm-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function initNotifySettings() {
  const form = $('notify-form');
  const urlInput = $('notify-url');
  const tokenInput = $('notify-token');
  const clearToken = $('notify-token-clear');
  const bell = $('notify-bell');
  const state = $('notify-state');
  const status = $('notify-status');
  const saveBtn = $('notify-save');
  const testBtn = $('notify-test');

  let saved = null; // last state from the server: { url, hasToken, bell }
  let removeToken = false;
  let dirty = false;

  function setStatus(text, kind = '') {
    status.textContent = text;
    status.className = kind;
  }

  function render() {
    urlInput.value = saved.url;
    bell.checked = saved.bell;
    tokenInput.value = '';
    removeToken = false;
    tokenInput.placeholder = saved.hasToken ? 'saved (leave blank to keep)' : 'none';
    clearToken.hidden = !saved.hasToken;
    state.textContent = saved.url ? 'on' : 'off';
    state.className = saved.url ? 'badge on' : 'badge';
    testBtn.disabled = !saved.url;
    dirty = false;
  }

  async function load() {
    if (dirty) return; // don't throw away edits in progress
    try {
      saved = (await api('/api/settings')).notify;
      render();
      setStatus('');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  form.addEventListener('input', () => (dirty = true));

  $('notify-generate').addEventListener('click', () => {
    if (urlInput.value && !confirm('Replace the current topic with a new random one?')) return;
    urlInput.value = `https://ntfy.sh/${randomTopic()}`;
    dirty = true;
    setStatus('New topic: subscribe to it in the ntfy app, then Save.');
  });

  clearToken.addEventListener('click', () => {
    removeToken = true;
    tokenInput.value = '';
    tokenInput.placeholder = 'will be removed when you save';
    clearToken.hidden = true;
    dirty = true;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { url: urlInput.value.trim(), bell: bell.checked };
    if (tokenInput.value.trim()) body.token = tokenInput.value.trim();
    else if (removeToken) body.token = '';
    saveBtn.disabled = true;
    setStatus('Saving…');
    try {
      saved = (await api('/api/settings/notify', body)).notify;
      render();
      setStatus(saved.url ? 'Saved. Use “Send test” to check it reaches your device.' : 'Saved. Notifications are off.', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  testBtn.addEventListener('click', async () => {
    if (dirty) {
      setStatus('Save your changes first.', 'error');
      return;
    }
    testBtn.disabled = true;
    setStatus('Sending…');
    try {
      await api('/api/settings/notify/test', {});
      setStatus('Test notification sent.', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      testBtn.disabled = !saved?.url;
    }
  });

  return { load };
}
