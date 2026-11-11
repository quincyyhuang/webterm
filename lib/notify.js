// Push notifications via ntfy (https://ntfy.sh, or a self-hosted ntfy server).
//
// Programs request a notification with an escape sequence:
//   OSC 9 ; <message> ST                 iTerm2 style:  printf '\e]9;build done\a'
//   OSC 777 ; notify ; <title> ; <body> ST  rxvt/foot style
//   OSC 99 ; <metadata> ; <payload> ST     kitty style (chunks and base64 supported)
// and, if enabled, the terminal bell. The server catches these on its headless copy of the
// terminal, so it works with plain HTTP and even when no browser tab is open. Pushes only go
// out when nobody is looking at the shell, and are rate-limited.

const MIN_GAP_MS = 5000; // at most one push per 5 s; extras are counted into the next one
const MAX_TEXT = 1000;

const clip = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Drop control characters that could garble the notification.
const clean = (s) => clip(String(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim());

/** OSC 9 payload -> message, or null. ConEmu/Windows Terminal reuse OSC 9 for "9;4;..." (progress) etc. */
export function parseOsc9(data) {
  if (/^\d+(;|$)/.test(data)) return null;
  const message = clean(data);
  return message ? { message } : null;
}

/** OSC 777 payload: "notify;<title>;<body>" -> { title, message }, or null. */
export function parseOsc777(data) {
  const [kind, title = '', ...body] = data.split(';');
  if (kind !== 'notify') return null;
  const message = clean(body.join(';')) || clean(title);
  return message ? { title: clean(title), message } : null;
}

/**
 * Kitty OSC 99. Metadata is colon-separated key=value pairs: i=<id>, d=0 (more chunks
 * follow), p=title|body, e=1 (payload is base64). Returns a stateful parser.
 */
export function osc99Parser() {
  const pending = new Map(); // id -> { title, body }
  return (data) => {
    const sep = data.indexOf(';');
    if (sep < 0) return null;
    const meta = Object.fromEntries(
      data
        .slice(0, sep)
        .split(':')
        .filter(Boolean)
        .map((kv) => {
          const i = kv.indexOf('=');
          return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
        }),
    );
    let payload = data.slice(sep + 1);
    if (meta.e === '1') {
      try {
        payload = Buffer.from(payload, 'base64').toString('utf8');
      } catch {
        return null;
      }
    }
    const part = meta.p || 'title';
    if (part !== 'title' && part !== 'body') return null; // icons, buttons, queries: ignore

    const id = meta.i || '';
    const n = pending.get(id) || { title: '', body: '' };
    n[part] += payload;
    if (meta.d === '0') {
      pending.set(id, n);
      if (pending.size > 32) pending.delete(pending.keys().next().value);
      return null;
    }
    pending.delete(id);
    const title = clean(n.title);
    const body = clean(n.body);
    if (!title && !body) return null;
    return body ? { title, message: body } : { message: title };
  };
}

export class Notifier {
  /**
   * @param {{url: string, token?: string, bell?: boolean}} opts
   *   url: ntfy topic URL, e.g. https://ntfy.sh/my-random-topic
   */
  constructor({ url, token, bell }) {
    const hint = 'Topic URL must look like https://ntfy.sh/<topic>';
    try {
      this.url = new URL(url);
    } catch {
      throw new Error(`${hint} (not a valid URL)`);
    }
    if (!/^https?:$/.test(this.url.protocol) || this.url.pathname.length < 2) throw new Error(hint);
    this.token = token || '';
    this.bell = Boolean(bell);
    this.lastSent = 0;
    this.dropped = 0;
    this.clickUrl = ''; // webterm's own URL, learned from incoming connections
    this.lastError = '';
  }

  /** Where notifications go, without revealing the topic (which acts as a password on ntfy.sh). */
  describe() {
    return `${this.url.host} (topic set${this.token ? ', with access token' : ''})${this.bell ? ', bell on' : ''}`;
  }

  /**
   * Queue a notification. Returns true if it was sent (or attempted), false if rate-limited.
   * @param {{title?: string, message: string, tags?: string}} n
   */
  notify({ title, message, tags }) {
    const now = Date.now();
    if (now - this.lastSent < MIN_GAP_MS) {
      this.dropped++;
      return false;
    }
    this.lastSent = now;
    let body = message;
    if (this.dropped) {
      body += `\n(+${this.dropped} more since the last notification)`;
      this.dropped = 0;
    }
    this.#post({ title: title || 'webterm', message: body, tags });
    return true;
  }

  /** Send immediately, bypassing the rate limit (used by the "Send test" button). */
  async sendNow(n) {
    return this.#post(n);
  }

  async #post({ title, message, tags }) {
    // Query parameters (rather than headers) so titles can contain any Unicode.
    const url = new URL(this.url);
    url.searchParams.set('title', clip(title, 200));
    if (tags) url.searchParams.set('tags', tags);
    if (this.clickUrl) url.searchParams.set('click', this.clickUrl);
    const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: message, signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      this.lastError = '';
      return true;
    } catch (err) {
      const cause = err?.cause?.code || err?.cause?.message;
      const msg = (err?.message || String(err)) + (cause ? ` (${cause})` : '');
      if (msg !== this.lastError) console.warn(`[notify] failed to send: ${msg}`); // don't spam the log
      this.lastError = msg;
      return false;
    }
  }
}
