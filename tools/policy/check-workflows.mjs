#!/usr/bin/env node
/**
 * check-workflows.mjs — enforces the P0 workflow policy from docs/method.md.
 *
 * Zero dependencies. Node >= 24, plain ESM.
 *
 * Rules
 *   R1  no workflow may reference `secrets.*`
 *   R2  no `pull_request_target` / `workflow_run` trigger
 *   R3  no write permissions anywhere (`write-all`, `x: write`, `id-token: write`)
 *   R4  every action pinned to a full 40-hex commit SHA (local paths exempt)
 *   R5  plugin-executing commands only under maintainer-controlled triggers
 *       (workflow_dispatch / schedule / workflow_call) — never under a trigger
 *       an outside contributor can cause, such as pull_request
 *   R6  a plugin-executing workflow must declare `permissions: {}`
 *   R7  a plugin-executing workflow must not expose a token to the environment
 *   R8  every workflow must declare top-level `permissions:` explicitly
 *   R9  a plugin-executing workflow must disable checkout credential persistence
 *   R10 the batch runner keeps its fetch/execute network split
 *   R11 the batch runner applies hard execution resource ceilings
 *
 * Usage: node tools/policy/check-workflows.mjs [--verbose]
 * Exit:  0 = policy clean and self-test green, 1 = violation or broken self-test.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOWS_DIR = join(ROOT, '.github', 'workflows');
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RUN_SUITE = join(ROOT, 'packages', 'runner', 'container', 'run-suite.sh');
const PREFETCH = join(ROOT, 'packages', 'runner', 'container', 'prefetch.sh');

const verbose = process.argv.includes('--verbose');

/**
 * Commands that install or execute third-party plugin code.
 *
 * `docker run` is included deliberately: a container run that installs or boots
 * a plugin IS execution, even when the actual `pnpm add` is hidden inside a
 * script the workflow merely invokes. Matching only the literal command would
 * leave a trivial bypass — call a script instead.
 */
const EXEC_COMMAND_RE =
  /pnpm\s+(?:add|install|i)\b|npm\s+(?:install|i|exec)\b|yarn\s+add\b|npx\s+\S|dsh\s+plugin\b|dsh\s+--profile\b|docker\s+(?:run|build)\b|packages\/runner\/|run-baseline\.sh|dsh-verified/m;

const FORBIDDEN_TRIGGERS = ['pull_request_target', 'workflow_run'];

/**
 * Triggers a maintainer controls. An executor workflow may use only these,
 * because the risk is not execution per se — it is *who can cause* execution.
 * A pull request from any fork must never be able to run third-party code.
 */
const SAFE_EXEC_TRIGGERS = new Set(['workflow_dispatch', 'schedule', 'workflow_call']);

/**
 * R7 detects *exposure* of a CI token, not any mention of one. Scrubbing a
 * token by name (`unset ACTIONS_RUNTIME_TOKEN`) is defensive and must stay
 * legal; assigning, wiring or interpolating one is not.
 */
const TOKEN_EXPOSURE_RES = [
  { re: /\$\{\{\s*(?:secrets\.[\w.]+|github\.token)\s*\}\}/, what: 'interpolates a CI token into the step' },
  { re: /^\s*(?:GITHUB_TOKEN|GH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN)\s*:/m, what: 'assigns a CI token into the environment' },
];

const PIN_RE = /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/;

/** Strips full-line comments. Limitation: '#' inside YAML block scalars is
 *  treated as a comment. Documented, and acceptable for a policy linter. */
function stripComments(text) {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
}

function parseTriggers(text) {
  const lines = text.split('\n');
  const triggers = new Set();

  for (let i = 0; i < lines.length; i++) {
    const m = /^on:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;

    const inline = m[1].trim();
    if (inline.startsWith('[')) {
      for (const t of inline.replace(/^\[/, '').replace(/\]$/, '').split(',')) {
        const v = t.trim().replace(/['"]/g, '');
        if (v) triggers.add(v);
      }
      return triggers;
    }
    if (inline !== '') {
      triggers.add(inline.replace(/['"]/g, ''));
      return triggers;
    }

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) break; // dedented back to top level
      const indent = /^\s*/.exec(line)[0].length;
      if (indent !== 2) continue; // nested configuration under a trigger
      const t = line.trim();
      if (t.startsWith('- ')) triggers.add(t.slice(2).trim().replace(/['"]/g, ''));
      else {
        const k = /^([\w-]+):/.exec(t);
        if (k) triggers.add(k[1]);
      }
    }
    return triggers;
  }
  return triggers;
}

function parseTopLevelPermissions(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^permissions:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline !== '') return { present: true, inline, empty: inline === '{}' };
    const entries = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (!/^\s/.test(line)) break;
      entries.push(line.trim());
    }
    return { present: true, inline: entries.join(' '), empty: entries.length === 0 };
  }
  return { present: false, inline: '', empty: false };
}

function scan(label, text) {
  const src = stripComments(text);
  const errors = [];
  const warnings = [];

  const triggers = parseTriggers(src);
  const perms = parseTopLevelPermissions(src);
  const usesMatches = [...src.matchAll(/^\s*-?\s*uses:\s*['"]?([^\s'"]+)['"]?\s*$/gm)].map((m) => m[1]);
  const executesPluginCode = EXEC_COMMAND_RE.test(src);

  // R1 — secrets are never referenced. This repo configures none, by design.
  const secretRefs = [...src.matchAll(/\bsecrets\s*\.\s*([A-Za-z_][\w]*)/g)].map((m) => m[1]);
  if (secretRefs.length > 0) {
    errors.push(`R1 references ${secretRefs.length} secret(s): ${[...new Set(secretRefs)].join(', ')} — this repo configures zero secrets`);
  }

  // R2 — privileged triggers hand tokens to untrusted code.
  for (const t of FORBIDDEN_TRIGGERS) {
    if (triggers.has(t)) errors.push(`R2 forbidden trigger "${t}" hands a privileged token to untrusted code`);
  }

  // R3 — no write permissions, anywhere (top-level, job-level, or nested).
  if (perms.present && perms.inline === 'write-all') {
    errors.push('R3 top-level "permissions: write-all"');
  } else if (perms.present && perms.inline === 'write') {
    errors.push('R3 top-level legacy "permissions: write"');
  }
  for (const m of src.matchAll(/^\s+([\w-]+):\s*write\s*$/gm)) {
    errors.push(`R3 grants write permission "${m[1]}: write"`);
  }

  // R8 — explicit top-level permissions in every workflow.
  if (!perms.present) {
    errors.push('R8 missing explicit top-level "permissions:"; declare it rather than relying on the default');
  }

  // R4 — actions pinned to immutable commit SHAs.
  for (const use of usesMatches) {
    if (use.startsWith('./')) continue; // local composite action, part of this repo
    if (use.startsWith('docker://')) {
      warnings.push(`R4 docker action not SHA-pinned: ${use}`);
      continue;
    }
    if (!PIN_RE.test(use)) {
      errors.push(`R4 action not pinned to a 40-character commit SHA: ${use}`);
    }
  }

  // R5 / R6 / R7 / R9 — the execution tier must be maintainer-triggered and
  // credential-free.
  if (executesPluginCode) {
    const unsafeTriggers = [...triggers].filter((t) => !SAFE_EXEC_TRIGGERS.has(t));
    if (triggers.size === 0 || unsafeTriggers.length > 0) {
      errors.push(
        `R5 executes third-party plugin code but triggers on {${[...triggers].join(', ')}}; ` +
          'execution must be limited to workflow_dispatch / schedule / workflow_call, ' +
          'never a trigger an outside contributor can cause',
      );
    }
    if (!perms.present || !perms.empty) {
      errors.push(`R6 executes third-party plugin code but permissions are not "{}" (got "${perms.inline || 'none'}")`);
    }
    for (const { re, what } of TOKEN_EXPOSURE_RES) {
      if (re.test(src)) errors.push(`R7 executes third-party plugin code and ${what}`);
    }
    if (usesMatches.some((u) => u.startsWith('actions/checkout')) && !/persist-credentials:\s*false/.test(src)) {
      errors.push('R9 executes third-party plugin code without "persist-credentials: false" on checkout');
    }
  }

  if (verbose) {
    console.log(`  ${label}: triggers={${[...triggers].join(',')}} permissions=${perms.present ? JSON.stringify(perms.inline) : 'absent'} exec=${executesPluginCode}`);
  }
  return { errors, warnings, rules: new Set(errors.map((e) => e.slice(0, 2).trim())) };
}

/* ------------------------------------------------------------- self-test */

function selfTest() {
  if (!existsSync(FIXTURES_DIR)) {
    console.error('fatal: policy fixtures directory missing — the guardrail cannot be shown to fire');
    return false;
  }
  const fixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  if (fixtures.length === 0) {
    console.error('fatal: no policy fixtures — the guardrail cannot be shown to fire');
    return false;
  }

  let ok = true;
  for (const file of fixtures) {
    const text = readFileSync(join(FIXTURES_DIR, file), 'utf8');
    const expectLine = /^#\s*policy-expect:\s*(.+)$/m.exec(text);
    if (!expectLine) {
      console.error(`  SELFTEST FAIL ${file}: missing "# policy-expect:" directive`);
      ok = false;
      continue;
    }
    const expectation = expectLine[1].trim();
    const { rules, errors } = scan(`fixtures/${file}`, text);

    if (expectation === 'clean') {
      if (errors.length > 0) {
        console.error(`  SELFTEST FAIL ${file}: expected clean, got ${errors.length} error(s):`);
        for (const e of errors) console.error(`      ${e}`);
        ok = false;
      }
      continue;
    }

    const expected = expectation.split(/\s+/).filter(Boolean);
    const missing = expected.filter((r) => !rules.has(r));
    if (missing.length > 0) {
      console.error(`  SELFTEST FAIL ${file}: rule(s) ${missing.join(', ')} did not fire (got: ${[...rules].join(', ') || 'none'})`);
      ok = false;
    }
  }
  const safeSuite = 'docker volume create --opt type=tmpfs --opt device=tmpfs --opt o=size=3g,uid=10001,gid=10001 "$cachevol"\n' +
    'docker run --name "$cname" --network none --read-only --cpus 2 --memory 2g --memory-swap 2g --pids-limit 256 ' +
    '--tmpfs /tmp:rw,size=256m --tmpfs /home/verifier:rw,size=256m ' +
    '--tmpfs /work/dsh-home:rw,size=1g --tmpfs /work/out:rw,size=512m --entrypoint node -e npm_config_offline=true';
  const safeFetch = 'pnpm add --lockfile-only --ignore-scripts\npnpm fetch --prod';
  if (runnerBoundaryErrors(safeSuite, safeFetch).length !== 0 ||
      runnerBoundaryErrors(safeSuite.replace('--network none', ''), safeFetch).length === 0 ||
      runnerBoundaryErrors(safeSuite, safeFetch.replace('--ignore-scripts', '')).length === 0 ||
      runnerBoundaryErrors(safeSuite.replace('--memory 2g', ''), safeFetch).length === 0) {
    console.error('  SELFTEST FAIL R10/R11 did not detect a removed network, script or resource gate');
    ok = false;
  }
  return ok;
}

function runnerBoundaryErrors(suite, prefetch) {
  const errors = [];
  const execution = /docker run --name "\$cname"[\s\S]*/.exec(suite)?.[0] ?? '';
  if (!execution.includes('--network none') || !execution.includes('--entrypoint node') ||
      !execution.includes('-e npm_config_offline=true')) {
    errors.push('R10 execution container must have --network none and pnpm offline mode');
  }
  if (!/pnpm add --lockfile-only --ignore-scripts/.test(prefetch) ||
      !/pnpm fetch --prod/.test(prefetch)) {
    errors.push('R10 networked fetch must use lockfile-only resolution and pnpm fetch');
  }
  const required = [
    '--read-only', '--cpus 2', '--memory 2g', '--memory-swap 2g',
    '--pids-limit 256', '--tmpfs /tmp:rw,size=256m',
    '--tmpfs /home/verifier:rw,size=256m',
    '--tmpfs /work/dsh-home:rw,size=1g', '--tmpfs /work/out:rw,size=512m',
  ];
  if (required.some((flag) => !execution.includes(flag)) ||
      !/docker volume create[^\n]*--opt type=tmpfs[^\n]*--opt device=tmpfs[\s\S]*--opt o=size=3g/.test(suite)) {
    errors.push('R11 execution container must have CPU, memory, process and bounded writable storage limits');
  }
  return errors;
}

/* ------------------------------------------------------------------- main */

function main() {
  let failed = false;

  console.log('policy self-test (bad fixtures must trip their rule):');
  if (selfTest()) console.log(`  OK: all fixtures behaved as declared`);
  else failed = true;

  console.log('\nscanning .github/workflows/:');
  if (!existsSync(WORKFLOWS_DIR)) {
    console.error('fatal: .github/workflows/ not found');
    process.exit(1);
  }
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
  if (files.length === 0) {
    console.error('fatal: no workflows found');
    process.exit(1);
  }

  let totalErrors = 0;
  const allWarnings = [];
  for (const file of files) {
    const { errors, warnings } = scan(`.github/workflows/${basename(file)}`, readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
    if (errors.length === 0 && warnings.length === 0) console.log(`  OK   ${file}`);
    for (const w of warnings) allWarnings.push(`${file}: ${w}`);
    for (const e of errors) {
      console.error(`  FAIL ${file}: ${e}`);
      totalErrors += 1;
      failed = true;
    }
    if (errors.length > 0 && warnings.length > 0) continue;
    if (errors.length > 0) continue;
    for (const w of warnings) console.log(`  warn ${file}: ${w}`);
  }

  if (totalErrors === 0) console.log(`  OK: ${files.length} workflow(s) satisfy P0`);

  console.log('\nscanning the batch runner boundary:');
  if (!existsSync(RUN_SUITE) || !existsSync(PREFETCH)) {
    console.error('  FAIL R10 batch runner or prefetch script missing');
    failed = true;
  } else {
    const errors = runnerBoundaryErrors(readFileSync(RUN_SUITE, 'utf8'), readFileSync(PREFETCH, 'utf8'));
    if (errors.length === 0) console.log('  OK: fetch-only phase and network-denied execution are present');
    for (const error of errors) {
      console.error(`  FAIL ${error}`);
      failed = true;
    }
  }

  if (failed) {
    console.error('\nFAIL: P0 workflow policy violated (see docs/method.md § Threat model).');
    process.exit(1);
  }
  console.log('\nOK: P0 workflow policy satisfied and enforced.');
}

main();
