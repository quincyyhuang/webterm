// `webterm set-password <username> [--print]`
//
// Prompts for a password (no echo) on a terminal, or reads a single line from stdin when
// piped (e.g.  echo 'secret' | webterm set-password alice). Then either writes the config
// file (mode 600) or, with --print, prints WEBTERM_USER / WEBTERM_PASSWORD_HASH lines.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { hashPassword } from './auth.js';

const MIN_LENGTH = 8;

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      // Echo only the prompt and line breaks, never the typed characters.
      if (s.startsWith(question) || s === '\r\n' || s === '\n') rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  const first = await promptHidden('Password: ');
  const second = await promptHidden('Confirm password: ');
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

export async function setPassword({ username, configPath, printOnly }) {
  const password = await readPassword();
  if (password.length < MIN_LENGTH) throw new Error(`Password must be at least ${MIN_LENGTH} characters.`);

  const passwordHash = await hashPassword(password);

  if (printOnly) {
    console.log(`WEBTERM_USER='${username}'`);
    console.log(`WEBTERM_PASSWORD_HASH='${passwordHash}'`);
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify({ username, passwordHash }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  console.log(`Wrote credentials for "${username}" to ${configPath}. Restart webterm to apply.`);
}
