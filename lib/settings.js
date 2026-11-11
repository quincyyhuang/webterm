// settings.json: the login ("auth", from the setup page or `webterm set-password`) and settings
// changed in the app ("notify"). Holds secrets (password hash, ntfy token), so it's mode 600.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadSettings(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[settings] ignoring unreadable ${file}: ${err.message}`);
    return {};
  }
}

/** Write atomically (temp file + rename) so a crash can't leave a half-written file. */
export function saveSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
