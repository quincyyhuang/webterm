// File browsing, download and upload for the files panel.
// All paths are absolute and operate with the server user's permissions. Anyone who can
// reach these endpoints is already logged in and has a shell, so this adds no new access.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ERRNO_STATUS = {
  ENOENT: [404, 'No such file or directory'],
  EACCES: [403, 'Permission denied'],
  EPERM: [403, 'Operation not permitted'],
  ENOTDIR: [400, 'Not a directory'],
  EISDIR: [400, 'Is a directory'],
  EEXIST: [409, 'Already exists'],
  ENOSPC: [507, 'No space left on device'],
  EROFS: [403, 'Read-only file system'],
  ENAMETOOLONG: [400, 'Name too long'],
};

/** Convert any error into { status, message } for an HTTP response. */
export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  const [status, message] = ERRNO_STATUS[err?.code] || [500, 'Internal error'];
  if (status === 500) console.error('[files]', err);
  return new HttpError(status, message);
}

/** Require an absolute path and normalise it. */
export function absPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) {
    throw new HttpError(400, 'Path must be absolute');
  }
  return path.resolve(p);
}

/** Current working directory of a process (the terminal's shell). */
export async function processCwd(pid) {
  try {
    return await fsp.readlink(`/proc/${pid}/cwd`); // Linux
  } catch {
    /* not Linux, or process gone */
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      const line = stdout.split('\n').find((l) => l.startsWith('n'));
      if (line) return line.slice(1);
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Process group currently in the foreground of the shell's terminal: the program the user
 * is typing into (a nested shell, an editor...), or the shell itself at its prompt.
 */
async function foregroundPgid(shellPid) {
  try {
    // Linux /proc/<pid>/stat: "pid (comm) state ppid pgrp session tty_nr tpgid ...".
    // comm may contain spaces or parens, so split after the last ')'.
    const stat = await fsp.readFile(`/proc/${shellPid}/stat`, 'utf8');
    const tpgid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5]);
    if (tpgid > 0) return tpgid;
  } catch {
    /* not Linux, or process gone */
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await promisify(execFile)('ps', ['-o', 'tpgid=', '-p', String(shellPid)]);
      const tpgid = Number(stdout.trim());
      if (tpgid > 0) return tpgid;
    } catch {
      /* fall through */
    }
  }
  return null;
}

/**
 * Working directory the user is "in" for a terminal: that of the foreground program
 * (e.g. a nested bash they cd'd in), falling back to the top-level shell. The foreground
 * group's leader may be unreadable (e.g. owned by root after `sudo -s`) or already gone.
 */
export async function terminalCwd(shellPid) {
  const fg = await foregroundPgid(shellPid);
  if (fg && fg !== shellPid) {
    const cwd = await processCwd(fg);
    if (cwd) return cwd;
  }
  return processCwd(shellPid);
}

export async function listDir(dir) {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const full = path.join(dir, d.name);
      const entry = { name: d.name, type: 'other', size: null, mtime: null, link: d.isSymbolicLink() };
      try {
        const st = await fsp.stat(full); // follows symlinks
        entry.type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        entry.size = st.isFile() ? st.size : null;
        entry.mtime = st.mtimeMs;
      } catch {
        /* broken symlink or no permission: keep as 'other' */
      }
      return entry;
    }),
  );
  // Directories first, then alphabetical.
  entries.sort((a, b) => {
    const aDir = a.type === 'dir';
    const bDir = b.type === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries };
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Stream a file to the response as a download. */
export async function sendDownload(res, file, headers) {
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw new HttpError(400, 'Is a directory');
  if (!st.isFile()) throw new HttpError(400, 'Not a regular file');

  const stream = fs.createReadStream(file);
  await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', reject);
  });
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': contentDisposition(path.basename(file)),
  });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function validName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    Buffer.byteLength(name) <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0]/.test(name)
  );
}

/**
 * Stream the request body into dir/name. Writes to a temporary file first and renames it
 * into place on success, so failed or aborted uploads never leave partial files behind.
 */
export async function receiveUpload(req, { dir, name, overwrite, maxBytes }) {
  if (!validName(name)) throw new HttpError(400, 'Invalid file name');

  const declared = Number(req.headers['content-length']);
  if (maxBytes && declared > maxBytes) throw new HttpError(413, 'File too large');

  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new HttpError(400, 'Not a directory');

  const target = path.join(dir, name);
  if (!overwrite) {
    const exists = await fsp.lstat(target).then(
      () => true,
      (e) => (e.code === 'ENOENT' ? false : Promise.reject(e)),
    );
    if (exists) throw new HttpError(409, 'File already exists');
  } else {
    const existing = await fsp.stat(target).catch(() => null);
    if (existing?.isDirectory()) throw new HttpError(409, 'A directory with that name exists');
  }

  const temp = path.join(dir, `.webterm-upload-${crypto.randomBytes(6).toString('hex')}`);
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (maxBytes && received > maxBytes) cb(new HttpError(413, 'File too large'));
      else cb(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(temp, { flags: 'wx' }));
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.unlink(temp).catch(() => {});
    if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE' || req.aborted) throw new HttpError(400, 'Upload aborted');
    throw err;
  }
  return { path: target, size: received };
}
