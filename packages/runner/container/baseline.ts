/**
 * baseline.ts — V0 baseline measurement, run INSIDE the verification container.
 *
 * Emits one JSON document on stdout (and to /work/out/baseline.json) recording
 * the container's cold-start cost and the fixed overhead of the `dsh plugin`
 * install path. It installs only a trivial non-plugin package (`is-number`) so
 * the number measures the toolchain, not a payload.
 *
 * Two modes:
 *   --offline  every step must work with no network. Install is EXPECTED to
 *              fail; that failure is the evidence that egress is denied.
 *   --online   a registry is reachable; the install baseline is timed.
 *
 * Node 24 runs this TypeScript directly (native type stripping), so the
 * container needs no build step and no dependencies.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';

const ONLINE = process.argv.includes('--online');
const OUT_DIR = process.env.OUT_DIR ?? '/work/out';
// Trivial package, no install scripts. Overridable so tests can measure the
// install path without fetching anything from a registry.
const BASELINE_PKG = process.env.BASELINE_PKG ?? 'is-number@7.0.0';
const PROFILE = 'baseline';

interface Step {
  name: string;
  ms: number;
  exitCode: number;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
}

const steps: Step[] = [];
const notes: string[] = [];

const tail = (s: string, n = 1200): string =>
  s.length <= n ? s : `…(trimmed)…\n${s.slice(-n)}`;

function run(name: string, cmd: string, args: string[], timeoutMs: number): Step {
  const started = performance.now();
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env },
  });
  const ms = Math.round(performance.now() - started);
  const step: Step = {
    name,
    ms,
    exitCode: r.status ?? -1,
    timedOut: r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT',
    stdoutTail: tail(r.stdout ?? ''),
    stderrTail: tail(r.stderr ?? ''),
  };
  steps.push(step);
  return step;
}

function readFileTrim(path: string): string | null {
  try {
    return execFileSync('cat', [path], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

mkdirSync(OUT_DIR, { recursive: true });

// 1. Cold start: how long does the pinned runtime take to answer at all?
const versionStep = run('dsh-version', 'dsh', ['--version'], 60_000);
const dshVersion = versionStep.stdoutTail.trim().split('\n').pop()?.trim() ?? 'unknown';

// 2. Profile initialisation + install path, on a cold cache.
if (ONLINE) {
  run('plugin-add-baseline', 'dsh', ['plugin', `--profile`, PROFILE, 'add', BASELINE_PKG], 180_000);
} else {
  const denied = run(
    'plugin-add-must-be-denied',
    'dsh',
    ['plugin', `--profile`, PROFILE, 'add', BASELINE_PKG],
    120_000,
  );
  if (denied.exitCode === 0) {
    notes.push(
      'EXPECTED DENIAL DID NOT HAPPEN: the install succeeded with no network. ' +
        'The offline assumption is unsafe until this is explained.',
    );
  } else {
    notes.push('offline install denied as expected; that failure is the egress evidence.');
  }
}

// 3. Once the profile exists, time an offline read-only operation. This is the
//    number V1 compares against, so it must not depend on the registry.
run('profile-readonly', 'dsh', ['plugin', `--profile`, PROFILE, 'version-exemptions'], 60_000);

const report = {
  schema: 'dsh.verifier.baseline.v1',
  mode: ONLINE ? 'online' : 'offline',
  container: {
    nodeVersion: process.version,
    dshVersion,
    os: `${platform()} ${release()}`,
    arch: arch(),
    cpus: cpus().length,
  },
  measurements: Object.fromEntries(steps.map((s) => [s.name, { ms: s.ms, exitCode: s.exitCode }])),
  steps,
  profileDir: `${process.env.DSH_HOME ?? ''}/profiles/${PROFILE}`,
  profilePackageJson: readFileTrim(`${process.env.DSH_HOME ?? ''}/profiles/${PROFILE}/package.json`),
  notes,
  generatedAt: new Date().toISOString(),
};

const text = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(`${OUT_DIR}/baseline.json`, text);
process.stdout.write(text);
