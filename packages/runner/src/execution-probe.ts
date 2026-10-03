/**
 * execution-probe.ts — L1, L2 and L6, run INSIDE the verification container.
 *
 * It emits `dsh.verifier.execution.v1`, which the host-side merge step turns
 * into the published `dsh.plugin.report.v1`. Keeping execution results separate
 * from the report means the runner can be tested against a fixture, and the
 * merge, validation and publication path can be tested without a container.
 *
 * Every behaviour here was established by running the real CLI in the real
 * container first (see packages/runner/container/probe.sh and the captured
 * evidence in docs/evidence/V3.md). Nothing is assumed about a pre-1.0 internal
 * API — the executor drives the published CLI and reads what it prints.
 *
 * L5 (overhead sampling) is deliberately NOT implemented here yet: it is V3's
 * subject, and reporting a number this round would mean inventing one.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { platform, arch, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const SPEC = process.argv[2] ?? process.env.PROBE_SPEC ?? '';
const OUT_DIR = process.env.OUT_DIR ?? '/work/out';
const DSH_HOME = process.env.DSH_HOME ?? '/tmp/verify-home';
const PROFILE = 'verify';
const BOOT_BOUND_MS = Number(process.env.BOOT_BOUND_MS ?? 25_000);
const MAX_EXCERPT = 2048;

if (SPEC === '') {
  process.stderr.write('execution-probe: no spec given\n');
  process.exit(2);
}

interface StepResult {
  name: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  errorCode?: string | null;
  excerpt: string;
}

const steps: StepResult[] = [];

/** Truncates from the front: the tail of a diagnostic carries the reason. */
function excerpt(text: string, max = MAX_EXCERPT): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, '');
  if (Buffer.byteLength(clean, 'utf8') <= max) return clean;
  const buf = Buffer.from(clean, 'utf8').subarray(-max);
  return `…(trimmed)…\n${new TextDecoder('utf-8', { fatal: false }).decode(buf)}`;
}

function run(name: string, args: string[], timeoutMs: number): StepResult {
  const started = performance.now();
  const result = spawnSync('dsh', args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, DSH_HOME, CI: '1' },
  });
  const durationMs = Math.round(performance.now() - started);
  const signal = result.signal ?? null;
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? null;
  const step: StepResult = {
    name,
    command: `dsh ${args.join(' ')}`,
    exitCode: result.status ?? null,
    signal,
    durationMs,
    // The bound firing is its own fact, and it cannot be inferred from the exit
    // code: DSH installs a SIGTERM handler that shuts down *gracefully with
    // exit 0*. Reading a graceful shutdown as "the composition exited early"
    // would report a healthy boot as a load failure.
    timedOut: errorCode === 'ETIMEDOUT' || signal === 'SIGKILL' || signal === 'SIGTERM',
    errorCode,
    excerpt: excerpt(`${result.stdout ?? ''}${result.stderr ?? ''}`),
  };
  steps.push(step);
  return step;
}

// DSH keeps profiles under $DSH_HOME/profiles/<name>. Getting this wrong made
// every profile read return null, which silently turned "no residue found" into
// a claim about a directory that was never inspected.
const profileDir = join(DSH_HOME, 'profiles', PROFILE);

function readProfilePackageJson(): Record<string, any> | null {
  const file = join(profileDir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

interface L1Outcome {
  status: 'pass' | 'fail' | 'timeout';
  reason: string;
  detail: string;
  declaredPeers: Record<string, string> | null;
  bundlesAfter: string[] | null;
  pendingBuildScripts: string[];
  logPath: string | null;
}

/**
 * Classifies the install result. The peer-incompatibility branch is not
 * hypothetical: DSH refuses the install outright, which is the single most
 * decision-relevant fact about a plugin that a static scan cannot see.
 */
function classifyInstall(step: StepResult): L1Outcome {
  const text = step.excerpt;
  const peers = /peerDependencies\s+(\{[^}]*\})/.exec(text);
  let declaredPeers: Record<string, string> | null = null;
  if (peers?.[1]) {
    try {
      declaredPeers = JSON.parse(peers[1]) as Record<string, string>;
    } catch {
      declaredPeers = null;
    }
  }

  const pkg = readProfilePackageJson();
  const bundles = (pkg?.dsh?.profile?.bundles ?? null) as string[] | null;
  const logPath = /diagnostics:\s*(\S+)/.exec(text)?.[1] ?? null;

  // Pending build scripts: pnpm gates them and DSH reports the names. They are
  // a finding, never something this executor approves.
  const pending = [...text.matchAll(/^\s*([@\w./-]+)\s+\((?:pre|post)?install:/gm)].map((m) => m[1] as string);

  if (step.timedOut) {
    return {
      status: 'timeout',
      reason: 'wall-clock ceiling reached during install',
      detail: `the install did not finish within the bound`,
      declaredPeers,
      bundlesAfter: bundles,
      pendingBuildScripts: [...new Set(pending)],
      logPath,
    };
  }

  if (step.exitCode === 0) {
    return {
      status: 'pass',
      reason: 'installed',
      detail: 'the CLI completed the install with exit code 0',
      declaredPeers,
      bundlesAfter: bundles,
      pendingBuildScripts: [...new Set(pending)],
      logPath,
    };
  }

  const peerRejected = /installation rejected/i.test(text) && /incompatible with/i.test(text);
  const pnpmError = /ERR_PNPM_[A-Z_]+/.exec(text)?.[0] ?? null;

  return {
    status: 'fail',
    reason: peerRejected
      ? 'peer-incompatible with the pinned runtime'
      : pnpmError
        ? `package manager error (${pnpmError})`
        : 'install failed',
    detail: peerRejected
      ? `DSH refused the install: the plugin's declared peerDependencies on @deepseek-ai/dsh* do not match the runtime. An exact-version exemption would bypass this check; granting one is a user decision and is not done here.`
      : `the CLI exited ${step.exitCode}`,
    declaredPeers,
    bundlesAfter: bundles,
    pendingBuildScripts: [...new Set(pending)],
    logPath,
  };
}

interface L2Outcome {
  status: 'pass' | 'fail' | 'timeout' | 'skip';
  reason: string;
  detail: string;
  diagnostics: string;
}

/**
 * Did anything actually fail?
 *
 * The first version treated *any* output as a failure signal, on the assumption
 * that a clean composition is silent. The first real execution disproved it:
 * dsh-cost-meter prints its own success line ("loaded, ledger: ...") on startup
 * and was duly reported as a load failure. Plugins log; that is not an error.
 *
 * The test is therefore failure-shaped text. The composition's own diagnostics
 * are the authority: DSH names a skipped bundle and a failed entry, so their
 * absence while the app stays alive is evidence the bundle was neither skipped
 * nor rejected.
 */
const FAILURE_SHAPES = [
  /failed to load/i,
  /\bERR_[A-Z_]+\b/,
  /\bskippedBundles?\b/i,
  /incompatible with/i,
  /installation rejected/i,
  /(^|\n)\s*(?:uncaught|unhandled)/i,
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/,
];

function failureDiagnostics(text: string, subjectName: string): string[] {
  if (text.trim() === '') return [];
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter(
      (line) =>
        FAILURE_SHAPES.some((re) => re.test(line)) ||
        (subjectName !== '' && line.includes(subjectName) && /fail|skip|deny|error|refus/i.test(line)),
    );
}

/**
 * Load: boot the profile under a wall-clock bound.
 *
 * Observed behaviour (evidence in docs/evidence/V3.md): a healthy composition
 * boots, mounts and waits, so the bound reaches it and DSH shuts down
 * gracefully. A composition whose plugins fail to load reports them, and a
 * failed *required* entry exits non-zero. The classifier keys on failure-shaped
 * diagnostics, never on the mere presence of output.
 */
function classifyBoot(step: StepResult, subjectName: string): L2Outcome {
  const text = step.excerpt.trim();
  const failures = failureDiagnostics(text, subjectName);

  if (failures.length > 0) {
    return {
      status: 'fail',
      reason: 'the composition reported a failure',
      detail: `${failures.length} failure-shaped diagnostic line(s); the composition names what it could not load`,
      diagnostics: failures.join('\n'),
    };
  }

  if (step.timedOut) {
    return {
      status: 'pass',
      reason: 'booted, mounted and stayed alive',
      detail:
        'the process was still running when the wall-clock bound reached it and reported no failure diagnostics, so the bundle was neither skipped nor rejected',
      diagnostics: text,
    };
  }

  if (step.exitCode === 0) {
    return {
      status: 'pass',
      reason: 'the composition booted and exited cleanly',
      detail: `exit code 0 with no failure diagnostics, before the wall-clock bound`,
      diagnostics: text,
    };
  }

  return {
    status: 'fail',
    reason: `the composition exited with code ${step.exitCode}`,
    detail:
      'a profile whose plugins fail to load exits before the agent runner mounts, so a non-zero exit is the load-failure signal',
    diagnostics: text,
  };
}

interface L6Outcome {
  status: 'pass' | 'fail' | 'skip' | 'inconclusive';
  reason: string;
  detail: string;
  residue: string[];
}

interface ResidueCheck {
  residue: string[];
  /** False when the profile could not be inspected at all — a pass would be unfounded. */
  inspectable: boolean;
}

function collectResidue(subjectName: string): ResidueCheck {
  if (!existsSync(profileDir)) {
    return { residue: [], inspectable: false };
  }
  const residue: string[] = [];
  const pkg = readProfilePackageJson();
  if (pkg === null) return { residue: [], inspectable: false };

  const bundles = (pkg.dsh?.profile?.bundles ?? []) as string[];
  if (bundles.some((b) => b === subjectName)) residue.push(`bundle still selected: ${subjectName}`);
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.includes(subjectName)) residue.push(`dependency entry remains: ${subjectName}`);
  const nodeModules = join(profileDir, 'node_modules');
  if (existsSync(nodeModules) && existsSync(join(nodeModules, subjectName))) {
    residue.push(`files remain: node_modules/${subjectName}`);
  }
  return { residue, inspectable: true };
}

// --- L1 -------------------------------------------------------------------
mkdirSync(DSH_HOME, { recursive: true });
// The runtime version is a first-class fact: every finding is scoped to it, and
// DSH behaviour moves between release candidates.
const versionStep = run('dsh-version', ['--version'], 30_000);
const dshVersion = versionStep.excerpt.trim().split('\n').pop()?.trim() ?? 'unknown';

const l1Step = run('l1-install', ['plugin', `--profile`, PROFILE, 'add', SPEC], 240_000);
const l1 = classifyInstall(l1Step);

// --- L2 and L6 only make sense once something installed -------------------
let l2: L2Outcome = {
  status: 'skip',
  reason: 'not run: the subject did not install',
  detail: 'loading a plugin that is not present would measure nothing',
  diagnostics: '',
};
let l6: L6Outcome = {
  status: 'skip',
  reason: 'not run: the subject did not install',
  detail: 'removal was not attempted because nothing was installed',
  residue: [],
};

if (l1.status === 'pass') {
  const subjectNameForBoot = SPEC.startsWith('@')
    ? SPEC.slice(0, SPEC.lastIndexOf('@'))
    : (SPEC.split('@')[0] as string);
  l2 = classifyBoot(run('l2-boot', ['--profile', PROFILE], BOOT_BOUND_MS), subjectNameForBoot);

  const subjectName = SPEC.startsWith('@')
    ? SPEC.slice(0, SPEC.lastIndexOf('@'))
    : (SPEC.split('@')[0] as string);
  run('l6-remove', ['plugin', `--profile`, PROFILE, 'remove', subjectName], 180_000);
  const check = collectResidue(subjectName);
  l6 = !check.inspectable
    ? {
        status: 'inconclusive',
        reason: 'the profile could not be inspected after removal',
        detail: `no profile manifest was readable at ${profileDir}, so "no residue" cannot be claimed`,
        residue: [],
      }
    : {
        status: check.residue.length === 0 ? 'pass' : 'fail',
        reason: check.residue.length === 0 ? 'removed without residue' : 'residue after removal',
        detail:
          check.residue.length === 0
            ? 'the profile retains no bundle selection, dependency entry or files for the subject'
            : check.residue.join('; '),
        residue: check.residue,
      };
}

const execution = {
  schema: 'dsh.verifier.execution.v1',
  spec: SPEC,
  generatedAt: new Date().toISOString(),
  environment: {
    dshVersion,
    nodeVersion: process.version,
    os: `${platform()} ${release()}`,
    arch: arch(),
    dshHome: DSH_HOME,
    profile: PROFILE,
    bootBoundMs: BOOT_BOUND_MS,
  },
  L1_install: l1,
  L2_load: l2,
  L6_uninstall: l6,
  steps,
  notes: [
    'L5 overhead sampling is not implemented; the dimension is reported as skip rather than estimated',
    'no dependency build script was approved by this executor',
  ],
};

mkdirSync(OUT_DIR, { recursive: true });
const text = `${JSON.stringify(execution, null, 2)}\n`;
try {
  writeFileSync(join(OUT_DIR, 'execution.json'), text);
} catch (error) {
  process.stderr.write(`execution-probe: could not write execution.json: ${String(error)}\n`);
}
process.stdout.write(text);
