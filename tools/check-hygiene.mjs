#!/usr/bin/env node
/**
 * check-hygiene.mjs — repository hygiene gates that CI enforces.
 *
 * Zero dependencies. Node >= 24, plain ESM.
 *
 * Checks
 *   1. required root files exist
 *   2. no credential-shaped or secret-shaped file is tracked
 *   3. .gitignore actually covers the secret and scratch patterns
 *   4. no tracked file exceeds the size budget
 *   5. LICENSE is MIT
 *   6. no file contains an obvious live-looking credential
 *
 * Usage: node tools/check-hygiene.mjs
 * Exit:  0 = clean, 1 = violations.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 1024 * 1024; // 1 MiB — this repo holds text and small logs

const REQUIRED_FILES = [
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'CONTRIBUTING.md',
  '.gitignore',
  'docs/method.md',
  'docs/security.md',
  'docs/schema.md',
  'schemas/dsh.plugin.report.v1.schema.json',
  '.github/workflows/ci.yml',
  '.github/workflows/verify.yml',
];

const REQUIRED_IGNORE_PATTERNS = [
  '.env',
  '.credentials.yaml',
  'node_modules/',
  '.DS_Store',
  '.verify/',
];

/** Files that must never be tracked, whatever they contain. */
const FORBIDDEN_TRACKED = [
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)\.credentials\.ya?ml$/,
  /(^|\/)credentials\.json$/,
  /\.(pem|key|p12)$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.dsh\//,
];

/** Content patterns that look like a live credential. Deliberately narrow to
 *  avoid flagging documentation about secrets. */
const SECRET_CONTENT = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, what: 'GitHub token' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, what: 'API key (sk- prefix)' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'private key block' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'AWS access key id' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/, what: 'npm token' },
];

const problems = [];

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    return null; // not a git repository; skip VCS-dependent checks
  }
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// 1. required files
for (const f of REQUIRED_FILES) {
  if (!existsSync(join(ROOT, f))) problems.push(`missing required file: ${f}`);
}

// 2. + 4. + 6. tracked files
const tracked = trackedFiles();
if (tracked === null) {
  console.log('note: not a git repository — skipping tracked-file checks');
} else {
  for (const f of tracked) {
    const rel = f;
    for (const re of FORBIDDEN_TRACKED) {
      if (re.test(rel)) problems.push(`tracked file must never be committed: ${rel}`);
    }
    const abs = join(ROOT, f);
    if (existsSync(abs)) {
      const size = statSync(abs).size;
      if (size > MAX_BYTES) problems.push(`${f} is ${(size / 1048576).toFixed(2)} MiB, over the 1 MiB budget`);
    }
  }
}

// 3. .gitignore coverage
if (existsSync(join(ROOT, '.gitignore'))) {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const p of REQUIRED_IGNORE_PATTERNS) {
    if (!ignore.includes(p)) problems.push(`.gitignore does not cover "${p}"`);
  }
}

// 5. license
if (existsSync(join(ROOT, 'LICENSE'))) {
  const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  if (!license.includes('MIT License')) problems.push('LICENSE is not the MIT license');
}

// 6. secret-shaped content in tracked text files
if (tracked) {
  for (const f of tracked) {
    const abs = join(ROOT, f);
    if (!existsSync(abs) || statSync(abs).size > MAX_BYTES) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // binary
    for (const { re, what } of SECRET_CONTENT) {
      if (re.test(text)) problems.push(`${f}: contains what looks like a live ${what}`);
    }
  }
}

// Report a count of what was inspected, so a silent pass is not mistaken for
// a thorough pass.
const allFiles = walk(ROOT);
console.log(`inspected ${allFiles.length} file(s) on disk, ${tracked ? tracked.length : 0} tracked`);

if (problems.length > 0) {
  console.error(`\nFAIL: ${problems.length} hygiene problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('OK: repository hygiene clean.');
