#!/usr/bin/env node
/**
 * dsh-verified — run a verification, or validate a report.
 *
 * Usage
 *   node packages/cli/src/main.ts static <spec> [--out <file>] [--registry <url>]
 *   node packages/cli/src/main.ts validate <report.json> [...]
 *   node packages/cli/src/main.ts --help
 *
 * `static` performs L0 + L4 only: it resolves an exact artifact, reads it, and
 * reports what it declares and can reach for. It executes no plugin code, so it
 * is safe to run anywhere — and its verdict is capped at `partial`.
 *
 * L1-L6 require the verification container; see docs/security.md.
 *
 * TypeScript is executed directly by Node 24's type stripping. No build step,
 * no dependencies.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStaticReport } from '../../collector/src/static-report.ts';
import { loadSchema, validateReport } from '../../report/src/validate.ts';
import { buildCatalogIndex, INDEX_SCHEMA, summariseReport } from '../../report/src/catalog.ts';
import { mergeExecution, type ExecutionResult } from '../../report/src/merge.ts';
import { searchPackageNames, survey } from '../../collector/src/survey.ts';
import { RegistryError } from '../../collector/src/registry.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'schemas', 'dsh.plugin.report.v1.schema.json');

function usage(): void {
  process.stdout.write(
    [
      'dsh-verified — execution-verified reports for DeepSeek Harness plugins',
      '',
      'Usage:',
      '  dsh-verified static <spec> [--out <file>] [--registry <url>]',
      '  dsh-verified validate <report.json> [...]',
      '  dsh-verified catalog [catalog-dir]',
      '  dsh-verified merge <static.json> <execution.json> [--out <file>]',
      '  dsh-verified survey (--query <text> | --list <a,b>) [--limit N] [--out <file>]',
      '',
      '  static    L0 qualification + L4 capability scan. Runs no plugin code.',
      '  validate  Check report(s) against the schema and the verdict rules.',
      '  catalog   Rebuild and validate catalog/index.json from the reports on disk.',
      '  merge     Combine a static report (L0+L4) with execution results (L1+L2+L6).',
      '  survey    Registry metadata only: how many packages that claim to be DSH',
      '            plugins actually declare an installable bundle. Runs no plugin code.',
      '',
      'Specs are exact: name@1.2.3 or a bare name (resolves to latest).',
      '',
    ].join('\n'),
  );
}

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (inline !== undefined) flags.set(name as string, inline);
      else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(name as string, next);
          i += 1;
        } else flags.set(name as string, 'true');
      }
    } else positional.push(arg);
  }

  return { command, positional, flags };
}

async function commandStatic(args: ParsedArgs): Promise<number> {
  const spec = args.positional[0];
  if (!spec) {
    process.stderr.write('error: static requires a spec, e.g. dsh-pet@0.3.1\n');
    return 2;
  }

  const registry = args.flags.get('registry');
  const out = args.flags.get('out');

  const { report } = await buildStaticReport(spec, registry ? { registry } : {});

  const issues = validateReport(report, loadSchema(SCHEMA_PATH));
  if (issues.length > 0) {
    process.stderr.write(`error: produced a report that fails its own schema (${issues.length} issue(s)):\n`);
    for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
    return 1;
  }

  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(text);
  }

  const dims = report.dimensions as Record<string, { status: string }>;
  process.stderr.write(
    `\n${report.reportId}  verdict=${report.verdict}  ` +
      `L0=${dims.L0_qualification?.status} L4=${dims.L4_capability?.status}\n`,
  );
  return 0;
}

function commandValidate(args: ParsedArgs): number {
  if (args.positional.length === 0) {
    process.stderr.write('error: validate requires at least one report path\n');
    return 2;
  }

  const schema = loadSchema(SCHEMA_PATH);
  let failed = 0;

  for (const file of args.positional) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      process.stderr.write(`FAIL ${file}: not readable JSON (${String(error)})\n`);
      failed += 1;
      continue;
    }

    const issues = validateReport(parsed, schema);
    if (issues.length === 0) {
      process.stdout.write(`OK   ${file}\n`);
      continue;
    }

    failed += 1;
    process.stderr.write(`FAIL ${file}: ${issues.length} issue(s)\n`);
    for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
  }

  return failed > 0 ? 1 : 0;
}

/**
 * The L0 pre-filter at scale, without a container: registry metadata only.
 * This is the by-product the specification asks for — how many packages
 * claiming to be DSH plugins are actually installable bundles.
 */
async function commandSurvey(args: ParsedArgs): Promise<number> {
  const query = args.flags.get('query');
  const list = args.flags.get('list');
  const limit = Number(args.flags.get('limit') ?? 250);
  const registry = args.flags.get('registry');

  if (!query && !list) {
    process.stderr.write('error: survey needs --query <text> or --list <a,b,c>\n');
    return 2;
  }

  let names: string[];
  if (list) {
    names = list.split(',').map((n) => n.trim()).filter(Boolean).slice(0, limit);
  } else {
    process.stderr.write(`searching: ${query}\n`);
    names = await searchPackageNames(query as string, limit);
  }

  process.stderr.write(`surveying ${names.length} package(s) — registry metadata only\n`);
  const runtimeVersion = args.flags.get('runtime') ?? null;
  const summary = await survey(names, {
    ...(registry ? { registry } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
    query: query ?? null,
  });

  const out = args.flags.get('out');
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(text);
  }

  const c = summary.counts;
  process.stderr.write(
    `\nscanned ${c.scanned}  reachable ${c.reachable}  unreachable ${c.unreachable}\n` +
      `declares an installable bundle: ${c.declaresBundle} of ${c.reachable}\n` +
      `declares no bundle: ${c.declaresNoBundle}\n` +
      (summary.runtimeVersion
        ? `peer-compatible with DSH ${summary.runtimeVersion}: ${c.peerCompatible} of ${c.declaresBundle}\n` +
          `peer-incompatible: ${c.peerIncompatible}\n`
        : ''),
  );
  return 0;
}

/**
 * Combines the static report with the container execution results. The verdict
 * is recomputed from the merged dimensions rather than carried over, so a
 * static-only `partial` cannot survive execution that established less.
 */
function commandMerge(args: ParsedArgs): number {
  const [staticPath, executionPath] = args.positional;
  if (!staticPath || !executionPath) {
    process.stderr.write('error: merge requires <static.json> <execution.json>\n');
    return 2;
  }

  let staticReport: Record<string, any>;
  let execution: ExecutionResult;
  try {
    staticReport = JSON.parse(readFileSync(staticPath, 'utf8')) as Record<string, any>;
    execution = JSON.parse(readFileSync(executionPath, 'utf8')) as ExecutionResult;
  } catch (error) {
    process.stderr.write(`error: could not read inputs: ${String(error)}\n`);
    return 2;
  }

  if (execution.schema !== 'dsh.verifier.execution.v1') {
    process.stderr.write(`error: unexpected execution schema "${execution.schema}"\n`);
    return 2;
  }

  const merged = mergeExecution(staticReport, execution);
  const issues = validateReport(merged, loadSchema(SCHEMA_PATH));
  if (issues.length > 0) {
    process.stderr.write(`error: merged report fails its own schema (${issues.length} issue(s)):\n`);
    for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
    return 1;
  }

  const out = args.flags.get('out');
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    process.stderr.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(text);
  }

  const dims = merged.dimensions as Record<string, { status: string }>;
  process.stderr.write(
    `\n${merged.reportId}  verdict=${merged.verdict}  ` +
      Object.entries(dims).map(([k, v]) => `${k.slice(0, 2)}=${v.status}`).join(' ') +
      '\n',
  );
  return 0;
}

/**
 * Rebuilds catalog/index.json from the reports on disk, validating every one
 * on the way through. The index is derived, never hand-edited: a stale index
 * misstates coverage, which is the one thing this project cannot afford.
 */
function commandCatalog(args: ParsedArgs): number {
  const dir = args.positional[0] ?? join(REPO_ROOT, 'catalog');
  if (!existsSync(dir)) {
    process.stderr.write(`error: no catalog directory at ${dir}\n`);
    return 2;
  }

  const schema = loadSchema(SCHEMA_PATH);
  const files = (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => f.endsWith('.json') && basename(f) !== 'index.json')
    .sort();

  const summaries = [];
  let failed = 0;

  for (const relative of files) {
    const full = join(dir, relative);
    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8')) as Record<string, any>;
    } catch (error) {
      process.stderr.write(`FAIL ${relative}: not readable JSON (${String(error)})\n`);
      failed += 1;
      continue;
    }

    const issues = validateReport(parsed, schema);
    if (issues.length > 0) {
      failed += 1;
      process.stderr.write(`FAIL ${relative}: ${issues.length} issue(s)\n`);
      for (const issue of issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
      continue;
    }

    summaries.push(summariseReport(`catalog/${relative}`, parsed));
  }

  if (failed > 0) {
    process.stderr.write(`\nrefusing to write an index over ${failed} invalid report(s)\n`);
    return 1;
  }

  const index = buildCatalogIndex(summaries);
  const indexPath = join(dir, 'index.json');

  // --check fails when the committed index does not match what the reports on
  // disk imply. `generatedAt` is excluded because it changes on every run; the
  // entries are what must not drift. A stale index misstates coverage.
  if (args.flags.has('check')) {
    if (!existsSync(indexPath)) {
      process.stderr.write('error: catalog/index.json is missing; run without --check to create it\n');
      return 1;
    }
    const existing = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    const strip = (value: Record<string, unknown>) => JSON.stringify({ ...value, generatedAt: undefined });
    if (strip(existing) !== strip(index as unknown as Record<string, unknown>)) {
      process.stderr.write(
        'FAIL catalog/index.json is stale relative to the reports on disk;\n' +
          '     re-run: node packages/cli/src/main.ts catalog\n',
      );
      return 1;
    }
    process.stdout.write(`OK   catalog/index.json is current (${index.counts.total} report(s))\n`);
    return 0;
  }

  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  process.stdout.write(
    `${INDEX_SCHEMA}: ${index.counts.total} report(s) ${JSON.stringify(index.counts.byVerdict)}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === '' || args.command === '--help' || args.command === '-h' || args.command === 'help') {
    usage();
    process.exit(0);
  }

  try {
    let code: number;
    switch (args.command) {
      case 'static':
        code = await commandStatic(args);
        break;
      case 'validate':
        code = commandValidate(args);
        break;
      case 'catalog':
        code = commandCatalog(args);
        break;
      case 'merge':
        code = commandMerge(args);
        break;
      case 'survey':
        code = await commandSurvey(args);
        break;
      default:
        process.stderr.write(`error: unknown command "${args.command}"\n\n`);
        usage();
        code = 2;
    }
    process.exit(code);
  } catch (error) {
    if (error instanceof RegistryError) {
      process.stderr.write(`error: ${error.kind}: ${error.message}\n`);
      process.exit(3);
    }
    process.stderr.write(`error: ${String(error)}\n`);
    process.exit(1);
  }
}

await main();
