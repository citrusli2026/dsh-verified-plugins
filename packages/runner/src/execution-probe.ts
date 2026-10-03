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

  // Pending build scripts: pnpm gates them, and they are a finding rather than
  // something this executor ever approves. Two formats are seen in practice:
  //
  //   npm warn install-scripts  <pkg> (postinstall: ...)   -- one line each
  //   Error: ERR_PNPM_IGNORED_BUILDS
  //     Ignored build scripts: a@1.0.0, better-            -- one wrapped list
  //         sqlite3@12.11.1, onnxruntime-node@1.30.0
  //
  // The second wraps *inside* a package name, so the block is rejoined before
  // splitting rather than splitting on lines.
  const pending: string[] = [...text.matchAll(/^\s*([@\w./-]+)\s+\((?:pre|post)?install:/gm)].map(
    (m) => m[1] as string,
  );

  const ignoredBlock = /Ignored build scripts:\s*([\s\S]{0,900}?)(?:\n\s*help:|\n\s*$|$)/.exec(text);
  if (ignoredBlock?.[1]) {
    const joined = ignoredBlock[1].replace(/\s*\n\s*/g, '');
    for (const part of joined.split(',')) {
      const name = part.trim().replace(/\.$/, '');
      if (name !== '' && name.includes('@')) pending.push(name);
    }
  }

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
  const buildsBlocked = pending.length > 0 && (pnpmError === 'ERR_PNPM_IGNORED_BUILDS' || /Ignored build scripts:/i.test(text));

  return {
    status: 'fail',
    reason: buildsBlocked
      ? 'installation blocked pending dependency build-script approval'
      : peerRejected
        ? 'peer-incompatible with the pinned runtime'
        : pnpmError
          ? `package manager error (${pnpmError})`
          : 'install failed',
    detail: buildsBlocked
      ? `pnpm refused to run build scripts for ${pending.length} package(s) and the install did not complete. This verifier never approves them: approval permits commands with the host user's permissions, which is the user's decision and a finding rather than a chore. The requested scripts are listed in the metrics.`
      : peerRejected
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

interface L3Outcome {
  status: 'pass' | 'fail' | 'skip' | 'inconclusive';
  reason: string;
  detail: string;
  /** The probe task, stated verbatim so a reader can re-run it. */
  task: string;
  events: Record<string, unknown> | null;
  replayAdapter: string;
}

/**
 * The probe task is fixed and published verbatim: T4-class claims are bounded
 * by the prompt, and a reader has to be able to re-run exactly this.
 */
const L3_TASK = 'reply with any text';

/**
 * Parse the `--json` event stream. The headless runner projects committed
 * assistant messages and a terminal `final`; a turn that fails still ends with
 * `final` but carries a non-completed `turn_end` reason, so the reason is the
 * signal rather than the stream's shape.
 */
function classifyRun(step: StepResult): L3Outcome {
  const replayAdapter = `@deepseek-ai/dsh-llm-replay@${dshVersion}`;
  const base = { task: L3_TASK, events: null, replayAdapter } as Partial<L3Outcome>;

  const lines = step.excerpt.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  const parsed: Array<Record<string, any>> = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as Record<string, any>);
    } catch {
      // A truncated or non-JSON line is skipped; the terminal events matter.
    }
  }

  const final = parsed.find((e) => e.type === 'final');
  const turnEnd = parsed.find((e) => e.type === 'turn_end' || e.type === 'status');
  const turnEndReason = parsed
    .filter((e) => e.type === 'status' && e.phase === 'turn_end')
    .map((e) => e.reason)
    .pop();
  const errorEvent = parsed.find((e) => e.type === 'error');
  const textEvents = parsed.filter((e) => e.type === 'text').map((e) => e.text);

  const events = {
    session: parsed.find((e) => e.type === 'session')?.sessionId ?? null,
    turnEndReason: turnEndReason ?? null,
    finalText: final?.text ?? null,
    textEventCount: textEvents.length,
    error: errorEvent?.message ?? null,
    exitCode: step.exitCode,
    durationMs: step.durationMs,
    eventCount: parsed.length,
  };

  if (step.timedOut) {
    return { status: 'fail', reason: 'the session did not finish within the bound', detail: 'no terminal event was reached before the wall-clock ceiling', ...base, events };
  }
  if (errorEvent) {
    return { status: 'fail', reason: 'the runner reported an error', detail: String(errorEvent.message ?? 'error event'), ...base, events };
  }
  if (step.exitCode !== 0) {
    return { status: 'fail', reason: `the session exited ${step.exitCode}`, detail: 'a non-zero exit is the failure signal', ...base, events };
  }
  const completed = (turnEndReason as { kind?: string } | undefined)?.kind === 'completed';
  if (final && completed) {
    return {
      status: 'pass',
      reason: 'a session completed with no credential',
      detail:
        'the model call was served by the official replay adapter from a fixture authored in this repository; no provider was contacted and no credential was present',
      ...base,
      events,
    };
  }
  if (final) {
    return {
      status: 'fail',
      reason: 'the turn ended without completing',
      detail: `turn_end reason: ${JSON.stringify(turnEndReason ?? null)}`,
      ...base,
      events,
    };
  }
  return {
    status: 'inconclusive',
    reason: 'no terminal event was found in the stream',
    detail: turnEnd ? 'the stream carried no final event' : 'the stream carried no recognisable events',
    ...base,
    events,
  };
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

// --- L5: differential overhead sampling -----------------------------------
//
// Baseline pass (a profile with no subject) then activated pass (after the
// subject is installed), same container, same order, median of N runs. Both
// passes load the sampler into the host process itself, so the numbers come
// from the process under test rather than from outside it.
//
// Only repeatable, significant deltas are reported. When nothing clears the
// thresholds the result is `no-significant-delta`, which is a finding, not an
// absence of one.

const SAMPLER_PATH = process.env.SAMPLER_PATH ?? '/work/host-sampler.mjs';
const SAMPLE_RUNS = Number(process.env.SAMPLE_RUNS ?? 3);
const SAMPLE_SETTLE_MS = Number(process.env.SAMPLE_SETTLE_MS ?? 6000);
const SAMPLE_COUNT = Number(process.env.SAMPLE_COUNT ?? 5);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS ?? 1000);
const BASELINE_PROFILE = 'baseline';
const L3_PROFILE = 'l3';

const SAMPLED_METRICS = [
  'atMs',
  'rss',
  'heapUsed',
  'external',
  'activeTotal',
  'watchers',
  'timers',
  'libuvHandles',
  'libuvActiveHandles',
  'libuvRequests',
  'fds',
] as const;

type SampledMetric = (typeof SAMPLED_METRICS)[number];

function median(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) : (sorted[mid] as number);
}

interface SampledRun {
  label: string;
  run: number;
  ok: boolean;
  reason: string;
  file: string;
  perMetric: Partial<Record<SampledMetric, number>>;
  /** What the active resources actually were — a bare count tells a reader little. */
  activeKinds?: Record<string, number>;
  libuvHandleTypes?: Record<string, number>;
}

/**
 * One sampling run. The sampler exits by itself once it has written its file,
 * so the bound here is a backstop rather than the normal path.
 */
function sampleOnce(profile: string, label: string, run: number): SampledRun {
  const file = join(OUT_DIR, `sample-${label}-${run}.json`);
  const t0 = Date.now();
  const bound = SAMPLE_SETTLE_MS + SAMPLE_COUNT * SAMPLE_INTERVAL_MS + 20_000;

  spawnSync('dsh', ['--profile', profile], {
    encoding: 'utf8',
    timeout: bound,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${SAMPLER_PATH}`,
      SAMPLE_OUT: file,
      SAMPLER_T0: String(t0),
      SAMPLE_SETTLE_MS: String(SAMPLE_SETTLE_MS),
      SAMPLE_COUNT: String(SAMPLE_COUNT),
      SAMPLE_INTERVAL_MS: String(SAMPLE_INTERVAL_MS),
    },
  });

  if (!existsSync(file)) {
    return { label, run, ok: false, reason: 'the host produced no sample file', file, perMetric: {} };
  }

  let parsed: { samples?: Array<Record<string, number>> };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { samples?: Array<Record<string, number>> };
  } catch (error) {
    return { label, run, ok: false, reason: `unreadable sample file: ${String(error)}`, file, perMetric: {} };
  }

  const samples = parsed.samples ?? [];
  if (samples.length === 0) {
    return { label, run, ok: false, reason: 'the sample file carried no samples', file, perMetric: {} };
  }

  const perMetric: Partial<Record<SampledMetric, number>> = {};
  for (const metric of SAMPLED_METRICS) {
    const values = samples.map((s) => s[metric]).filter((v): v is number => typeof v === 'number');
    const m = median(values);
    if (m !== null) perMetric[metric] = m;
  }

  const last = samples[samples.length - 1] as Record<string, any>;
  return {
    label,
    run,
    ok: true,
    reason: `${samples.length} samples`,
    file,
    perMetric,
    activeKinds: (last.activeKinds ?? {}) as Record<string, number>,
    libuvHandleTypes: (last.libuvHandleTypes ?? {}) as Record<string, number>,
  };
}

interface OverheadOutcome {
  status: 'measured' | 'no-significant-delta' | 'inconclusive';
  reason: string;
  samples: number;
  baseline: Partial<Record<SampledMetric, number>>;
  activated: Partial<Record<SampledMetric, number>>;
  delta: Partial<Record<SampledMetric, number>>;
  significant: Array<{ metric: string; baseline: number; activated: number; delta: number; ratio: number; reason: string }>;
  runs: SampledRun[];
}

function aggregate(runs: SampledRun[]): Partial<Record<SampledMetric, number>> {
  const out: Partial<Record<SampledMetric, number>> = {};
  const ok = runs.filter((r) => r.ok);
  if (ok.length === 0) return out;
  for (const metric of SAMPLED_METRICS) {
    const per = ok.map((r) => r.perMetric[metric]).filter((v): v is number => typeof v === 'number');
    const m = median(per);
    if (m !== null) out[metric] = m;
  }
  return out;
}

/**
 * Thresholds are deliberately coarse. The specification's examples are
 * order-of-magnitude watcher changes, RSS growth beyond 100 MB and startup
 * increases beyond 2 s; anything finer on a shared CI runner is noise dressed
 * up as measurement.
 */
function findSignificant(
  baseline: Partial<Record<SampledMetric, number>>,
  activated: Partial<Record<SampledMetric, number>>,
): OverheadOutcome['significant'] {
  const found: OverheadOutcome['significant'] = [];
  const push = (metric: SampledMetric, reason: string) => {
    const b = baseline[metric];
    const a = activated[metric];
    if (b === undefined || a === undefined) return;
    found.push({ metric, baseline: b, activated: a, delta: a - b, ratio: b === 0 ? Infinity : Number((a / b).toFixed(2)), reason });
  };

  const bH = baseline.libuvHandles;
  const aH = activated.libuvHandles;
  if (bH !== undefined && aH !== undefined && aH >= bH * 2 && aH - bH >= 20) push('libuvHandles', 'at least doubled and grew by 20 or more');
  const bA = baseline.activeTotal;
  const aA = activated.activeTotal;
  if (bA !== undefined && aA !== undefined && aA >= bA * 2 && aA - bA >= 10) push('activeTotal', 'at least doubled and grew by 10 or more');
  const bW = baseline.watchers;
  const aW = activated.watchers;
  if (bW !== undefined && aW !== undefined && ((aW >= bW * 2 && aW - bW >= 5) || aW - bW >= 10)) push('watchers', 'filesystem watchers increased materially');
  const bT = baseline.timers;
  const aT = activated.timers;
  if (bT !== undefined && aT !== undefined && aT - bT >= 20) push('timers', '20 or more additional timers');
  const bR = baseline.rss;
  const aR = activated.rss;
  if (bR !== undefined && aR !== undefined && aR - bR > 100 * 1024 * 1024) push('rss', 'resident memory grew by more than 100 MiB');
  const bF = baseline.fds;
  const aF = activated.fds;
  if (bF !== undefined && aF !== undefined && aF - bF >= 50) push('fds', '50 or more additional open descriptors');
  const bS = baseline.atMs;
  const aS = activated.atMs;
  if (bS !== undefined && aS !== undefined && aS - bS > 2000) push('atMs', 'steady state arrived more than 2 s later');
  return found;
}

// --- L1 -------------------------------------------------------------------
mkdirSync(DSH_HOME, { recursive: true });
// The sampler writes into OUT_DIR from inside the host process, so the
// directory must exist before the first sampling run.
mkdirSync(OUT_DIR, { recursive: true });
// The runtime version is a first-class fact: every finding is scoped to it, and
// DSH behaviour moves between release candidates.
const versionStep = run('dsh-version', ['--version'], 30_000);
const dshVersion = versionStep.excerpt.trim().split('\n').pop()?.trim() ?? 'unknown';

// Baseline first, on a profile that does not contain the subject.
run('l5-baseline-profile', ['plugin', `--profile`, BASELINE_PROFILE, 'version-exemptions'], 60_000);
const baselineRuns: SampledRun[] = [];
if (existsSync(join(DSH_HOME, 'profiles', BASELINE_PROFILE, 'package.json'))) {
  for (let i = 0; i < SAMPLE_RUNS; i++) baselineRuns.push(sampleOnce(BASELINE_PROFILE, 'baseline', i));
}

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

const subjectName = SPEC.startsWith('@')
  ? SPEC.slice(0, SPEC.lastIndexOf('@'))
  : (SPEC.split('@')[0] as string);

const activatedRuns: SampledRun[] = [];

let l3: L3Outcome = {
  status: 'skip',
  reason: 'not run: the subject did not install',
  detail: 'a session cannot be attributed to a subject that is not present',
  task: L3_TASK,
  events: null,
  replayAdapter: `@deepseek-ai/dsh-llm-replay@${dshVersion}`,
};

if (l1.status === 'pass') {
  for (let i = 0; i < SAMPLE_RUNS; i++) activatedRuns.push(sampleOnce(PROFILE, 'activated', i));

  const subjectNameForBoot = subjectName;
  l2 = classifyBoot(run('l2-boot', ['--profile', PROFILE], BOOT_BOUND_MS), subjectNameForBoot);

  // --- L3: a keyless session ----------------------------------------------
  // The subject is installed into a headless profile too, so the session that
  // runs is one the subject is actually loaded in. Without that the result
  // would say nothing about the subject.
  const L3_OVERLAY = process.env.L3_OVERLAY ?? '/work/fixtures/replay/l3-overlay.yml';
  if (existsSync(L3_OVERLAY)) {
    run('l3-profile', ['--profile', L3_PROFILE, '--from-default-profile', 'headless'], 120_000);
    run('l3-install-subject', ['plugin', '--profile', L3_PROFILE, 'add', SPEC], 240_000);
    // Derived from the runtime, never resolved by bare name: the `latest` tag
    // points at a version from an older generation whose peers cannot match.
    run(
      'l3-install-replay',
      ['plugin', `--profile`, L3_PROFILE, 'add', `@deepseek-ai/dsh-llm-replay@${dshVersion}`],
      240_000,
    );
    l3 = classifyRun(
      run('l3-session', ['--profile', L3_PROFILE, '--patch', L3_OVERLAY, '--json', L3_TASK], 180_000),
    );
  } else {
    l3 = {
      status: 'inconclusive',
      reason: 'the replay overlay was not available',
      detail: `no overlay at ${L3_OVERLAY}`,
      task: L3_TASK,
      events: null,
      replayAdapter: `@deepseek-ai/dsh-llm-replay@${dshVersion}`,
    };
  }

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

const baselineAgg = aggregate(baselineRuns);
const activatedAgg = aggregate(activatedRuns);
const overhead: OverheadOutcome = (() => {
  const runs = [...baselineRuns, ...activatedRuns];
  const empty = { method: 'differential' as const };
  if (baselineRuns.length === 0 || !baselineRuns.some((r) => r.ok)) {
    return { ...empty, status: 'inconclusive', reason: 'no usable baseline samples were collected', samples: 0, baseline: {}, activated: {}, delta: {}, significant: [], runs } as OverheadOutcome;
  }
  if (l1.status !== 'pass') {
    return { ...empty, status: 'inconclusive', reason: 'the subject did not install, so there was nothing to activate', samples: 0, baseline: baselineAgg, activated: {}, delta: {}, significant: [], runs } as OverheadOutcome;
  }
  if (activatedRuns.length === 0 || !activatedRuns.some((r) => r.ok)) {
    return { ...empty, status: 'inconclusive', reason: 'no usable activated samples were collected', samples: 0, baseline: baselineAgg, activated: {}, delta: {}, significant: [], runs } as OverheadOutcome;
  }

  const delta: Partial<Record<SampledMetric, number>> = {};
  for (const metric of SAMPLED_METRICS) {
    const b = baselineAgg[metric];
    const a = activatedAgg[metric];
    if (b !== undefined && a !== undefined) delta[metric] = a - b;
  }
  const significant = findSignificant(baselineAgg, activatedAgg);
  const usableRuns = [...baselineRuns, ...activatedRuns].filter((r) => r.ok).length;

  return {
    ...empty,
    status: significant.length > 0 ? 'measured' : 'no-significant-delta',
    reason:
      significant.length > 0
        ? `${significant.length} metric(s) moved beyond the significance thresholds`
        : 'no metric moved beyond the significance thresholds; that is the finding',
    samples: usableRuns,
    baseline: baselineAgg,
    activated: activatedAgg,
    delta,
    significant,
    runs,
  } as OverheadOutcome;
})();

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
    baselineProfile: BASELINE_PROFILE,
    bootBoundMs: BOOT_BOUND_MS,
    sampleRuns: SAMPLE_RUNS,
    sampleSettleMs: SAMPLE_SETTLE_MS,
    sampleCount: SAMPLE_COUNT,
  },
  L1_install: l1,
  L2_load: l2,
  L3_run: l3,
  L5_overhead: overhead,
  L6_uninstall: l6,
  steps,
  notes: [
    'no dependency build script was approved by this executor',
    'overhead is reported only where a delta cleared the significance thresholds; otherwise the result is no-significant-delta',
    'sampling happens inside the host process via NODE_OPTIONS=--import, so process.getActiveResourcesInfo() and process.report.getReport() describe the process under test',
  ],
};

const text = `${JSON.stringify(execution, null, 2)}\n`;
try {
  writeFileSync(join(OUT_DIR, 'execution.json'), text);
} catch (error) {
  process.stderr.write(`execution-probe: could not write execution.json: ${String(error)}\n`);
}
process.stdout.write(text);
