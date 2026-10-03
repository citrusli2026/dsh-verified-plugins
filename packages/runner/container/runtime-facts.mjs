/**
 * runtime-facts.mjs — runs at IMAGE BUILD TIME, after the first-party DSH
 * runtime is installed.
 *
 * It preserves npm's own report of which dependency install scripts it gated.
 * The container explicitly allows five of them (see the Dockerfile), and a
 * reader of a later report must be able to see that this happened and which
 * packages it covered. Absorbing that decision silently is exactly what this
 * project exists to stop doing.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const LOG = '/opt/dsh-runtime-facts/npm-install.log';
const OUT = '/opt/dsh-runtime-facts/install-scripts.txt';

let log = '';
try {
  log = readFileSync(LOG, 'utf8');
} catch (error) {
  writeFileSync(OUT, `could not read ${LOG}: ${String(error)}\n`);
  process.exit(0);
}

const kept = log
  .split('\n')
  .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd())
  .filter((line) => /install-scripts|added [0-9]+ packages|npm warn deprecated/i.test(line));

writeFileSync(OUT, `${kept.join('\n')}\n`);
