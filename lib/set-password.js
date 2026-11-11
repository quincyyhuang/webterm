// `webterm set-password <username> [--print]`
//
// Prompts for a password (no echo) on a terminal, or reads a single line from stdin when
// piped (e.g.  echo 'secret' | webterm set-password alice). Then either saves the login in
// settings.json (mode 600) or, with --print, prints WEBTERM_USER / WEBTERM_PASSWORD_HASH lines.

import readline from 'node:readline';
import { hashPassword, saveCredentials, usernameProblem, MIN_PASSWORD_LENGTH } from './auth.js';

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

export async function setPassword({ username, settingsPath, printOnly }) {
  const problem = usernameProblem(username);
  if (problem) throw new Error(problem);
  const password = await readPassword();
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  const passwordHash = await hashPassword(password);

  if (printOnly) {
    console.log(`WEBTERM_USER='${username}'`);
    console.log(`WEBTERM_PASSWORD_HASH='${passwordHash}'`);
    return;
  }

  saveCredentials(settingsPath, username, passwordHash);
  console.log(`Saved the login for "${username}" in ${settingsPath}. Restart webterm to apply.`);
}
