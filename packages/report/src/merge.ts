/**
 * merge.ts — combine a static report (L0 + L4) with execution results
 * (L1 + L2 + L6) into the published `dsh.plugin.report.v1`.
 *
 * The split exists so the container-side runner can be tested against a fixture
 * and the merge/validate/publish path can be tested without a container. It also
 * keeps the honest boundary visible: whatever the execution step did not run
 * stays `skip` or `blocked`, and the verdict is recomputed from the result
 * rather than carried over from the static-only document.
 */

import { createHash } from 'node:crypto';

import type { Dimension, EvidenceEntry } from './validate.ts';
import { deriveVerdict, DISCLAIMER, type DimensionKey } from './validate.ts';

export interface ExecutionStep {
  name: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  excerpt: string;
}

export interface ExecutionResult {
  schema: string;
  spec: string;
  generatedAt: string;
  environment: {
    dshVersion?: string;
    nodeVersion?: string;
    os?: string;
    arch?: string;
    bootBoundMs?: number;
  };
  L1_install: {
    status: string;
    reason: string;
    detail: string;
    declaredPeers: Record<string, string> | null;
    bundlesAfter: string[] | null;
    pendingBuildScripts: string[];
    logPath: string | null;
  };
  L2_load: { status: string; reason: string; detail: string; diagnostics: string };
  L5_overhead?: {
    status: string;
    reason: string;
    samples: number;
    baseline: Record<string, number>;
    activated: Record<string, number>;
    delta: Record<string, number>;
    significant: Array<{ metric: string; baseline: number; activated: number; delta: number; ratio: number; reason: string }>;
  };
  L6_uninstall: { status: string; reason: string; detail: string; residue: string[] };
  steps: ExecutionStep[];
  notes: string[];
}

const MAX_EXCERPT_BYTES = 2048;

function capExcerpt(text: string): { excerpt: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_EXCERPT_BYTES) return { excerpt: text, bytes, truncated: false };
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_EXCERPT_BYTES);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\uFFFD+$/, '');
  return { excerpt: decoded, bytes: Buffer.byteLength(decoded, 'utf8'), truncated: true };
}

function stepFor(execution: ExecutionResult, name: string): ExecutionStep | undefined {
  return execution.steps.find((s) => s.name === name);
}

function evidenceFromStep(id: string, step: ExecutionStep | undefined, fallbackCommand: string): EvidenceEntry {
  const capped = capExcerpt(step?.excerpt ?? '');
  return {
    id,
    kind: 'command',
    command: step?.command ?? fallbackCommand,
    ...(step?.exitCode !== null && step?.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
    ...(step ? { durationMs: step.durationMs } : {}),
    excerpt: capped.excerpt,
    excerptBytes: capped.bytes,
    truncated: capped.truncated,
    sha256: createHash('sha256').update(step?.excerpt ?? '').digest('hex'),
  };
}

/**
 * L3 is recorded from the observed install refusal rather than from an
 * assumption. `@deepseek-ai/dsh-llm-replay` is the sanctioned key-free path and
 * DSH refuses to install it against the current runtime, so no session can be
 * driven without a credential. Inventing a "run" result would be the exact
 * overclaiming this project exists to prevent.
 */
function l3Blocked(dshVersion: string): Dimension {
  return {
    id: 'L3',
    status: 'blocked',
    summary: `not run: the sanctioned key-free model adapter is not installable against dsh ${dshVersion}`,
    evidenceRefs: ['e-l3-blocked'],
    notes: [
      '@deepseek-ai/dsh-llm-replay declares peerDependencies on ^0.0.1-rc.1 packages, one of which (@deepseek-ai/dsh-compact) does not exist on npm, and DSH refuses peer-incompatible installs',
      'a session therefore requires a real credential, which this project never injects',
      'resolving L3 needs either a pinned older runtime whose peers match, or a recorded-transcript adapter',
    ],
  };
}

function l5Skipped(): Dimension {
  return {
    id: 'L5',
    status: 'skip',
    summary: 'not run: differential overhead sampling is not implemented yet',
    evidenceRefs: [],
    notes: [
      'reporting an overhead figure here would mean inventing one; the dimension stays visible as not having run',
    ],
  };
}

export function mergeExecution(
  staticReport: Record<string, any>,
  execution: ExecutionResult,
): Record<string, any> {
  const report = JSON.parse(JSON.stringify(staticReport)) as Record<string, any>;
  const dshVersion = execution.environment.dshVersion ?? 'unknown';

  const evidence: EvidenceEntry[] = report.evidence;
  const l1Step = stepFor(execution, 'l1-install');
  const l2Step = stepFor(execution, 'l2-boot');
  const l6Step = stepFor(execution, 'l6-remove');

  evidence.push(evidenceFromStep('e-l1-install', l1Step, `dsh plugin --profile verify add ${execution.spec}`));
  if (l2Step) evidence.push(evidenceFromStep('e-l2-boot', l2Step, 'dsh --profile verify'));
  if (l6Step) evidence.push(evidenceFromStep('e-l6-remove', l6Step, 'dsh plugin --profile verify remove <subject>'));

  // A decisive status must cite evidence. If the execution result claims one but
  // carries no step record for it, the claim cannot be published: it is
  // downgraded to inconclusive rather than propped up with a fabricated entry.
  const missingStepNote = (name: string): string[] => [
    `the execution result reported a status for ${name} but carried no step record, so it could not be evidenced and was downgraded to inconclusive`,
  ];

  evidence.push({
    id: 'e-l3-blocked',
    kind: 'static',
    command: 'dsh plugin --profile replay add @deepseek-ai/dsh-llm-replay',
    exitCode: 1,
    excerpt: capExcerpt(
      [
        '@deepseek-ai/dsh-llm-replay@0.0.1-rc.1 declares peerDependencies:',
        '  @deepseek-ai/dsh-llm ^0.0.1-rc.1, @deepseek-ai/dsh-compact ^0.0.1-rc.1,',
        '  @deepseek-ai/dsh-session ^0.0.1-rc.1, @deepseek-ai/dsh-invariants ^0.0.1-rc.1',
        `DSH ${dshVersion} refuses the install: caret ranges on 0.0.x cannot reach 0.2.x,`,
        'and @deepseek-ai/dsh-compact does not exist on npm at any version.',
        'Observed in the container; see docs/evidence/V3.md.',
      ].join('\n'),
    ).excerpt,
  });

  // L5 evidence is the medians themselves: the numbers a reader would have to
  // reproduce to disagree, rather than a rendered conclusion.
  const l5 = execution.L5_overhead;
  if (l5 && l5.status !== 'inconclusive') {
    evidence.push({
      id: 'e-l5-overhead',
      kind: 'sample',
      command: 'dsh --profile <baseline|activated> with the host sampler injected via NODE_OPTIONS=--import',
      excerpt: capExcerpt(
        JSON.stringify(
          {
            method: 'differential',
            status: l5.status,
            samples: l5.samples,
            baselineMedian: l5.baseline,
            activatedMedian: l5.activated,
            delta: l5.delta,
            significant: l5.significant,
          },
          null,
          2,
        ),
      ).excerpt,
    });
  }

  const dims = report.dimensions as Record<string, Dimension>;

  const l1 = execution.L1_install;
  const l1Status: Dimension['status'] = !l1Step
    ? 'inconclusive'
    : (['pass', 'fail', 'timeout'] as const).includes(l1.status as 'pass')
      ? (l1.status as Dimension['status'])
      : 'inconclusive';
  dims.L1_install = {
    id: 'L1',
    status: l1Status,
    summary: l1Status === 'inconclusive' && !l1Step ? 'the execution result carried no install step' : l1.reason,
    metrics: {
      durationMs: l1Step?.durationMs ?? null,
      exitCode: l1Step?.exitCode ?? null,
      declaredPeers: l1.declaredPeers,
      bundlesAfterInstall: l1.bundlesAfter,
      pendingBuildScripts: l1.pendingBuildScripts,
      buildScriptsApproved: 0,
      diagnosticsLog: l1.logPath,
    },
    evidenceRefs: l1Step ? ['e-l1-install'] : [],
    notes: [
      l1.detail,
      ...(l1Step ? [] : missingStepNote('L1_install')),
      'no dependency build script was approved by the verifier; approval permits commands with the host user permissions',
    ],
  };

  const l2 = execution.L2_load;
  if (l2.status === 'skip') {
    dims.L2_load = {
      id: 'L2',
      status: 'skip',
      summary: l2.reason,
      evidenceRefs: [],
      notes: [l2.detail],
    };
  } else if (!l2Step) {
    dims.L2_load = {
      id: 'L2',
      status: 'inconclusive',
      summary: 'the execution result carried no boot step record',
      evidenceRefs: [],
      notes: missingStepNote('L2_load'),
    };
  } else {
    dims.L2_load = {
      id: 'L2',
      status: l2.status as Dimension['status'],
      summary: l2.reason,
      metrics: {
        bootBoundMs: execution.environment.bootBoundMs ?? null,
        durationMs: l2Step.durationMs,
        signal: l2Step.signal,
      },
      evidenceRefs: ['e-l2-boot'],
      notes: [
        l2.detail,
        'the fiber phase is not read directly: an early exit with diagnostics is the load-failure signal, and a boot that settles and waits is the success signal',
      ],
    };
  }

  const l6 = execution.L6_uninstall;
  if (l6.status === 'skip') {
    dims.L6_uninstall = { id: 'L6', status: 'skip', summary: l6.reason, evidenceRefs: [], notes: [l6.detail] };
  } else if (!l6Step) {
    dims.L6_uninstall = {
      id: 'L6',
      status: 'inconclusive',
      summary: 'the execution result carried no removal step record',
      evidenceRefs: [],
      notes: missingStepNote('L6_uninstall'),
    };
  } else {
    dims.L6_uninstall = {
      id: 'L6',
      status: l6.status as Dimension['status'],
      summary: l6.reason,
      metrics: { residue: l6.residue, durationMs: l6Step.durationMs },
      evidenceRefs: ['e-l6-remove'],
      notes: [l6.detail],
    };
  }

  dims.L3_run = l3Blocked(dshVersion);

  if (!l5) {
    dims.L5_overhead = l5Skipped();
  } else if (l5.status === 'inconclusive') {
    dims.L5_overhead = {
      id: 'L5',
      status: 'inconclusive',
      summary: l5.reason,
      metrics: { samples: l5.samples },
      evidenceRefs: [],
      notes: ['no overhead claim is made when the differential could not be completed'],
    };
  } else {
    // A successful measurement is a pass whether or not a delta cleared the
    // thresholds: `no-significant-delta` is a finding, not a missing one.
    dims.L5_overhead = {
      id: 'L5',
      status: 'pass',
      summary:
        l5.status === 'measured'
          ? `${l5.significant.length} metric(s) beyond the significance thresholds across ${l5.samples} sampled run(s)`
          : `no significant delta across ${l5.samples} sampled run(s)`,
      metrics: { samples: l5.samples, baseline: l5.baseline, activated: l5.activated, delta: l5.delta },
      evidenceRefs: ['e-l5-overhead'],
      notes: [
        l5.reason,
        'differential attribution: baseline profile first, then the subject activated, same container and order',
        'thresholds are coarse on purpose — order-of-magnitude watcher changes, RSS growth beyond 100 MiB, steady state more than 2 s later',
      ],
    };
  }

  if (l5 && l5.status !== 'inconclusive') {
    report.overhead = {
      method: 'differential',
      status: l5.status,
      samples: l5.samples,
      baseline: l5.baseline,
      activated: l5.activated,
      delta: l5.delta,
      significant: l5.significant,
    };
  }

  // Only set keys that actually have a value: an `undefined` property is still
  // a property, and the schema rejects it. This produced invalid reports
  // whenever the execution environment omitted os/arch.
  const runtime: Record<string, string> = { dshVersion };
  const nodeVersion = execution.environment.nodeVersion ?? report.runtime?.nodeVersion;
  const os = execution.environment.os ?? report.runtime?.os;
  const arch = execution.environment.arch ?? report.runtime?.arch;
  if (nodeVersion !== undefined) runtime.nodeVersion = nodeVersion;
  if (os !== undefined) runtime.os = os;
  if (arch !== undefined) runtime.arch = arch;
  report.runtime = runtime;

  report.container = {
    ...report.container,
    image: process.env.VERIFIER_IMAGE ?? report.container?.image ?? 'unknown',
    imageDigest: process.env.VERIFIER_IMAGE_DIGEST ?? null,
    notes: 'executed in a one-off container; the subject was installed, booted and removed there',
  };

  report.verdict = deriveVerdict(dims as Record<DimensionKey, Dimension>);
  report.limits = [
    ...(report.limits ?? []).filter((l: string) => !/no source paths/.test(l) || true),
    ...(l5 && l5.status !== 'inconclusive'
      ? []
      : ['L5 overhead sampling did not complete, so no cost claim is made']),
    'the load result is inferred from exit behaviour and diagnostics rather than a directly read fiber phase',
    ...execution.notes,
  ].filter((l: string, i: number, all: string[]) => all.indexOf(l) === i);

  report.disclaimers = [DISCLAIMER];
  return report;
}
