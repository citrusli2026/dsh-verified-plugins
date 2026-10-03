#!/usr/bin/env node
/**
 * validate-reports.mjs — validates every reports/<plugin>/report.md against
 * schemas/report.schema.json and the tier/verdict rules in docs/method.md.
 *
 * Zero dependencies. Node >= 24, plain ESM.
 *
 * Usage: node tools/validate-reports.mjs [--verbose]
 * Exit:  0 = all reports valid (including "no reports yet"), 1 = failures.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS_DIR = join(ROOT, 'reports');
const SCHEMA_PATH = join(ROOT, 'schemas', 'report.schema.json');

const TIERS = ['t0_static', 't1_install', 't2_load', 't3_measure', 't4_behaviour'];
const TIER_INDEX = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const REQUIRED_BODY_SECTION = '## What this report does not establish';

const verbose = process.argv.includes('--verbose');
const problems = [];
const notes = [];

/* ------------------------------------------------------------------ parsing */

/**
 * Parses the flat YAML front-matter of a report. Deliberately minimal: this is
 * why schemas/report.schema.json is flat. Nested mappings are rejected loudly
 * rather than silently mis-read.
 */
function parseFrontMatter(text, label) {
  if (!text.startsWith('---')) {
    problems.push(`${label}: missing front-matter (file must start with "---")`);
    return null;
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    problems.push(`${label}: front-matter is not terminated by "---"`);
    return null;
  }
  const body = text.slice(end + 4);
  const fields = {};
  const lines = text.slice(3, end).split('\n');

  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) {
      problems.push(`${label}: front-matter line ${i + 2} is not a flat "key: value" pair: ${JSON.stringify(raw)}`);
      continue;
    }
    const [, key, rawValue] = m;
    let value = rawValue.trim();
    // Strip one layer of matching quotes.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value === '') {
      problems.push(`${label}: front-matter key "${key}" has an empty value`);
      continue;
    }
    if (Object.hasOwn(fields, key)) {
      problems.push(`${label}: duplicate front-matter key "${key}"`);
      continue;
    }
    fields[key] = value;
  }
  return { fields, body };
}

/* ------------------------------------------------------- schema (subset) */

/** Validates a flat value against the subset of JSON Schema this repo uses. */
function validateAgainstSchema(fields, schema, label) {
  const defs = schema.$defs ?? {};

  const resolve = (s) => {
    if (s && typeof s.$ref === 'string' && s.$ref.startsWith('#/$defs/')) {
      const name = s.$ref.slice('#/$defs/'.length);
      if (!defs[name]) throw new Error(`schema $ref not found: ${s.$ref}`);
      return defs[name];
    }
    return s;
  };

  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(fields, key)) problems.push(`${label}: missing required field "${key}"`);
  }

  if (schema.additionalProperties === false) {
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(fields)) {
      if (!known.has(key)) problems.push(`${label}: unknown field "${key}" (schema forbids additional properties)`);
    }
  }

  for (const [key, rawSchema] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(fields, key)) continue;
    const s = resolve(rawSchema);
    const value = fields[key];

    if (s.type === 'string' && typeof value !== 'string') {
      problems.push(`${label}: "${key}" must be a string`);
      continue;
    }
    if (s.enum && !s.enum.includes(value)) {
      problems.push(`${label}: "${key}" = ${JSON.stringify(value)} is not one of ${s.enum.join(', ')}`);
    }
    if (s.pattern) {
      let re;
      try {
        re = new RegExp(s.pattern);
      } catch {
        problems.push(`${label}: schema pattern for "${key}" is invalid`);
        continue;
      }
      if (!re.test(value)) {
        problems.push(`${label}: "${key}" = ${JSON.stringify(value)} does not match required pattern ${s.pattern}`);
      }
    }
  }
}

/* --------------------------------------------------- semantic tier rules */

/**
 * The rubric from docs/method.md: a verdict names the highest tier that
 * actually executed. This is the rule that stops a report from overclaiming.
 */
function validateVerdictConsistency(fields, label) {
  const verdict = fields.verdict;
  const tierValues = TIERS.map((t) => fields[t]).filter((v) => v !== undefined);
  if (!verdict || tierValues.length !== TIERS.length) return;

  const passCount = TIERS.filter((t) => fields[t] === 'pass').length;

  if (Object.hasOwn(TIER_INDEX, verdict)) {
    const level = TIER_INDEX[verdict];
    for (const [i, tier] of TIERS.entries()) {
      const value = fields[tier];
      if (i <= level && value !== 'pass') {
        problems.push(`${label}: verdict ${verdict} requires ${tier} = "pass", but it is "${value}"`);
      }
      if (i > level && value !== 'skip') {
        problems.push(`${label}: verdict ${verdict} but ${tier} = "${value}"; tiers above the verdict must be "skip"`);
      }
    }
    // A skipped tier at or below the level is already caught above.
  } else if (verdict === 'X-FAILED') {
    if (!TIERS.some((t) => fields[t] === 'fail')) {
      problems.push(`${label}: verdict X-FAILED requires at least one tier = "fail"`);
    }
  } else if (verdict === 'BLOCKED') {
    if (!TIERS.some((t) => fields[t] === 'blocked')) {
      problems.push(`${label}: verdict BLOCKED requires at least one tier = "blocked"`);
    }
  } else if (verdict === 'REFUSED') {
    if (passCount > 0) {
      problems.push(`${label}: verdict REFUSED must not have passing tiers (found ${passCount})`);
    }
  }

  // Integrity is only obtainable by actually resolving the artifact.
  if (!fields.integrity && ['L1', 'L2', 'L3', 'L4', 'X-FAILED'].includes(verdict)) {
    problems.push(`${label}: verdict ${verdict} requires "integrity" (the resolved hash)`);
  }

  if (fields.date) {
    const today = new Date().toISOString().slice(0, 10);
    if (fields.date > today) problems.push(`${label}: date ${fields.date} is in the future`);
  }

  // Evidence that a claim rests on must actually be present.
  if (['L1', 'L2', 'L3', 'L4'].includes(verdict)) {
    const evidenceDir = fields.__evidenceDir;
    if (!evidenceDir) {
      problems.push(`${label}: verdict ${verdict} requires an evidence/ directory`);
    } else {
      const entries = readdirSync(evidenceDir).filter((f) => !f.startsWith('.'));
      if (entries.length === 0) problems.push(`${label}: verdict ${verdict} requires non-empty evidence/`);
      else if (verbose) notes.push(`${label}: ${entries.length} evidence file(s)`);
    }
    if (!fields.__hasRepro) problems.push(`${label}: verdict ${verdict} requires repro.sh`);
  }
}

/** Slug the directory name must match, e.g. "@scope/name" -> "scope__name". */
function expectedSlug(pluginName) {
  return pluginName.replace(/^@/, '').replace(/\//g, '__');
}

/* -------------------------------------------------------------- main flow */

function main() {
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`fatal: schema not found at ${SCHEMA_PATH}`);
    process.exit(1);
  }
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

  if (!existsSync(REPORTS_DIR)) {
    console.error('fatal: reports/ directory not found');
    process.exit(1);
  }

  const reportDirs = readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();

  let checked = 0;

  for (const dir of reportDirs) {
    const dirPath = join(REPORTS_DIR, dir);
    const reportPath = join(dirPath, 'report.md');
    const label = `reports/${dir}/report.md`;

    if (!existsSync(reportPath)) {
      problems.push(`reports/${dir}/: missing report.md`);
      continue;
    }

    const parsed = parseFrontMatter(readFileSync(reportPath, 'utf8'), label);
    if (!parsed) continue;
    const { fields, body } = parsed;

    fields.__evidenceDir = existsSync(join(dirPath, 'evidence')) ? join(dirPath, 'evidence') : null;
    const reproPath = join(dirPath, 'repro.sh');
    fields.__hasRepro = existsSync(reproPath);

    validateAgainstSchema(fields, schema, label);
    validateVerdictConsistency(fields, label);

    if (fields.plugin && expectedSlug(fields.plugin) !== dir) {
      problems.push(`${label}: directory "${dir}" should be "${expectedSlug(fields.plugin)}" for plugin "${fields.plugin}"`);
    }

    if (!body.includes(REQUIRED_BODY_SECTION)) {
      problems.push(`${label}: body must contain the "${REQUIRED_BODY_SECTION}" section`);
    }

    if (fields.__hasRepro) {
      const mode = statSync(reproPath).mode;
      if ((mode & 0o111) === 0) problems.push(`reports/${dir}/repro.sh: not executable (chmod +x)`);
      const src = readFileSync(reproPath, 'utf8');
      if (!/DSH_HOME/.test(src)) {
        problems.push(`reports/${dir}/repro.sh: must redirect DSH_HOME to a throwaway profile`);
      }
      if (/[\w.-]*(credentials|\.env|token)[\w.-]*/i.test(src) && /\bcat\b|source|\.\s/.test(src)) {
        notes.push(`reports/${dir}/repro.sh: mentions credential paths — review that no secret is read`);
      }
    }

    checked += 1;
  }

  for (const n of notes) console.log(`note: ${n}`);

  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.length} problem(s) across ${checked} report(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nSee docs/method.md for the report contract.');
    process.exit(1);
  }

  console.log(`OK: ${checked} report(s) valid${checked === 0 ? ' (none published yet)' : ''}.`);
}

main();
