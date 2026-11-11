// Shells and the browser tabs connected to them.
//
// Two modes, chosen per connection:
//   shared: there is one shared shell. Every tab in this mode shows it live, and it keeps
//           running when all tabs are closed or the user logs out.
//   tab:    the tab gets a private shell that ends when the tab disconnects.
//
// Each shell is a node-pty process plus a headless xterm mirroring its screen. A tab that
// connects to a running shell gets the headless terminal's serialized state (screen,
// scrollback, colours, modes), so it looks exactly like the other tabs.
//
// Several tabs of different sizes can show one shell, but a pty has a single size: it
// follows the tab the user is actively using (the last one to type or gain focus).

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import pty from 'node-pty';
import { parseOsc9, parseOsc777, osc99Parser } from './notify.js';

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const SCROLLBACK = 5000;

function clampSize(n, fallback, max) {
  n = Math.floor(Number(n));
  return n > 0 && n <= max ? n : fallback;
}

export class ShellManager {
  /**
   * @param {{shell: string, cwd: string, env: object, detachedTimeoutMs: number, notifier?: object}} opts
   *   detachedTimeoutMs: end the shared shell after this long with no tabs open (0 = never).
   *   notifier: a Notifier (lib/notify.js) for push notifications, or null.
   */
  constructor({ shell, cwd, env, detachedTimeoutMs, notifier = null }) {
    this.shell = shell;
    this.notifier = notifier;
    this.cwd = cwd;
    this.env = env;
    this.detachedTimeoutMs = detachedTimeoutMs;
    this.shells = new Map(); // id -> entry
    this.shared = null; // the shared shell's entry, if running
  }

  get(id) {
    return this.shells.get(id);
  }

  /** Connect a WebSocket in the given mode. Returns the shell entry it was attached to. */
  connect(ws, { mode, cols, rows }) {
    cols = clampSize(cols, 80, 1000);
    rows = clampSize(rows, 24, 500);
    let entry;
    let restored = false;
    if (mode === 'tab') {
      entry = this.#create({ cols, rows, shared: false });
    } else if (this.shared) {
      entry = this.shared;
      restored = true;
    } else {
      entry = this.shared = this.#create({ cols, rows, shared: true });
    }
    this.#attach(entry, ws, { cols, rows, restored });
    return entry;
  }

  #create({ cols, rows, shared }) {
    const proc = pty.spawn(this.shell, [], { name: 'xterm-256color', cols, rows, cwd: this.cwd, env: this.env });
    const vt = new HeadlessTerminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    vt.loadAddon(serializer);

    const entry = {
      id: crypto.randomBytes(18).toString('base64url'),
      pid: proc.pid,
      proc,
      vt,
      serializer,
      shared,
      clients: new Map(), // ws -> { cols, rows, pending: string[] | null, watching: boolean }
      active: null, // ws whose size the pty follows
      timer: null,
      title: '', // window title set by the shell/program
    };

    vt.onTitleChange((title) => (entry.title = title));
    this.#watchNotifications(entry);

    proc.onData((data) => {
      vt.write(data);
      for (const [ws, client] of entry.clients) {
        if (client.pending) client.pending.push(data);
        else if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'));
      }
    });

    proc.onExit(({ exitCode }) => {
      console.log(`[pty ${entry.pid}] exited (${exitCode})`);
      clearTimeout(entry.timer);
      this.shells.delete(entry.id);
      if (this.shared === entry) this.shared = null;
      for (const ws of entry.clients.keys()) {
        if (ws.readyState === ws.OPEN) ws.close(1000, 'Shell exited');
      }
      entry.clients.clear();
      vt.dispose();
    });

    this.shells.set(entry.id, entry);
    console.log(`[pty ${entry.pid}] started ${this.shell} (${shared ? 'shared' : 'tab'})`);
    return entry;
  }

  /** Turn notification escape sequences (and optionally the bell) into push notifications. */
  #watchNotifications(entry) {
    const { vt } = entry;
    const fire = (n, tags) => {
      if (!this.notifier) return;
      // Someone is looking at this shell right now: they've seen it, no push needed.
      for (const c of entry.clients.values()) if (c.watching) return;
      this.notifier.notify({ title: n.title || entry.title || 'webterm', message: n.message, tags });
    };
    const osc99 = osc99Parser();
    vt.parser.registerOscHandler(9, (data) => {
      const n = parseOsc9(data);
      if (n) fire(n);
      return true;
    });
    vt.parser.registerOscHandler(777, (data) => {
      const n = parseOsc777(data);
      if (n) fire(n);
      return true;
    });
    vt.parser.registerOscHandler(99, (data) => {
      const n = osc99(data);
      if (n) fire(n);
      return true;
    });
    vt.onBell(() => {
      if (this.notifier?.bell) fire({ message: 'Terminal bell' }, 'bell');
    });
  }

  /** A tab reports whether the user is looking at it (visible and focused). */
  setWatching(entry, ws, watching) {
    const client = entry.clients.get(ws);
    if (client) client.watching = Boolean(watching);
  }

  #attach(entry, ws, { cols, rows, restored }) {
    clearTimeout(entry.timer);
    entry.timer = null;
    // A tab that just connected is usually being looked at; it reports its real state right away.
    const client = { cols, rows, pending: [], watching: true };
    entry.clients.set(ws, client);
    ws.send(JSON.stringify({ type: 'attached', id: entry.id, shared: entry.shared, restored }));

    // Snapshot everything written so far. write('') queues behind pending output, so the
    // callback sees the complete screen; output arriving meanwhile is buffered and sent after.
    entry.vt.write('', () => {
      if (entry.clients.get(ws) !== client) return;
      const data = (restored ? entry.serializer.serialize({ scrollback: SCROLLBACK }) : '') + client.pending.join('');
      client.pending = null;
      if (data && ws.readyState === ws.OPEN) ws.send(Buffer.from(data, 'utf8'));
    });
    this.activate(entry, ws);
  }

  /** A tab went away: end its private shell, or leave the shared shell running. */
  disconnect(entry, ws) {
    if (!entry.clients.delete(ws)) return;
    if (entry.active === ws) {
      entry.active = null;
      const next = [...entry.clients.keys()].pop();
      if (next) this.activate(entry, next);
    }
    if (entry.clients.size > 0) return;

    if (!entry.shared) {
      this.kill(entry);
      return;
    }
    console.log(`[pty ${entry.pid}] no tabs open; shared shell keeps running`);
    if (this.detachedTimeoutMs > 0) {
      entry.timer = setTimeout(() => {
        console.log(`[pty ${entry.pid}] no tabs for too long; ending it`);
        this.kill(entry);
      }, this.detachedTimeoutMs);
      entry.timer.unref();
    }
  }

  /** Record a tab's terminal size; applied if it's the active tab. */
  setSize(entry, ws, cols, rows) {
    const client = entry.clients.get(ws);
    if (!client) return;
    client.cols = clampSize(cols, client.cols, 1000);
    client.rows = clampSize(rows, client.rows, 500);
    if (entry.active === ws) this.#applySize(entry, client);
  }

  /** Make this tab the one whose size the shell follows (it typed or gained focus). */
  activate(entry, ws) {
    const client = entry.clients.get(ws);
    if (!client) return;
    entry.active = ws;
    this.#applySize(entry, client);
  }

  #applySize(entry, { cols, rows }) {
    if (cols === entry.vt.cols && rows === entry.vt.rows) return;
    entry.proc.resize(cols, rows);
    entry.vt.resize(cols, rows);
  }

  kill(entry) {
    try {
      entry.proc.kill(); // SIGHUP, as when a terminal window closes
    } catch {
      /* already exited */
    }
  }
}
