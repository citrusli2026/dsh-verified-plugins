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
import { makeExcerpt, redactPaths, redactSecrets } from './redact.ts';

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
  L2_load: {
    status: string; reason: string; detail: string; diagnostics: string;
    observation?: { found?: boolean; enabled?: boolean; error?: string | null; overrides?: string[];
      browserClientDeclared?: boolean | null;
      rows: Array<{ rowId: string; entryId: string | null; enabled: boolean; fiberPhase: string | null }> } | null;
  };
  L3_run?: {
    status: string;
    reason: string;
    detail: string;
    task: string;
    events: Record<string, unknown> | null;
    replayAdapter: string;
  };
  L5_overhead?: {
    status: string;
    reason: string;
    samples: number;
    baseline: Record<string, number>;
    activated: Record<string, number>;
    delta: Record<string, number>;
    significant: Array<{ metric: string; baseline: number; activated: number; delta: number; ratio: number; reason: string }>;
    runs?: Array<{
      label: string;
      run: number;
      ok: boolean;
      activeKinds?: Record<string, number>;
      libuvHandleTypes?: Record<string, number>;
    }>;
  };
  L6_uninstall: { status: string; reason: string; detail: string; residue: string[] };
  steps: ExecutionStep[];
  notes: string[];
}

const MAX_EXCERPT_BYTES = 2048;
const RUN_PATHS = [
  { from: '/home/verifier', to: '<home>' },
  { from: '/usr/local', to: '<runtime>' },
  { from: '/work', to: '<work>' },
  { from: '/tmp', to: '<tmp>' },
  { from: '/opt', to: '<runtime>' },
];

function redactRunText(value: string): string {
  return redactSecrets(redactPaths(value, { paths: RUN_PATHS }).text).text;
}

function redactSessionFields(value: string): string {
  return value.replace(
    /"(?:text|content|sessionId|message)"\s*:\s*"(?:\\.|[^"\\])*"/g,
    (field) => `${field.slice(0, field.indexOf(':') + 1)}"[redacted:session-content]"`,
  );
}

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
  const raw = step?.excerpt ?? '';
  const capped = makeExcerpt(id === 'e-l3-session' ? redactSessionFields(raw) : raw, {
    paths: RUN_PATHS, maxBytes: MAX_EXCERPT_BYTES,
  });
  return {
    id,
    kind: 'command',
    command: redactRunText(step?.command ?? fallbackCommand),
    ...(step?.exitCode !== null && step?.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
    ...(step ? { durationMs: step.durationMs } : {}),
    excerpt: capped.text,
    excerptBytes: capped.bytes,
    truncated: capped.truncated,
    sha256: createHash('sha256').update(step?.excerpt ?? '').digest('hex'),
  };
}

function l5Skipped(): Dimension {
  return {
    id: 'L5',
    status: 'skip',
    summary: 'not run: the execution result carried no overhead samples',
    evidenceRefs: [],
    notes: [
      'reporting an overhead figure without samples would mean inventing one',
    ],
  };
}

/**
 * Does the subject declare a bundle at all?
 *
 * This is the L0 pre-filter, and it guards a real false pass. A package with no
 * `dsh.bundle.patch` still installs — as a *plain dependency* that is never
 * composed into the tree. Every execution dimension then "succeeds" while
 * measuring the absence of the subject: the install returns 0, the profile
 * boots, a session runs, removal leaves nothing. `@morlay/session-branch` was
 * published with L1-L6 all passing on a package that is not a plugin.
 *
 * A bundle with a *missing* patch path is still a bundle: its install or load
 * can fail informatively, so execution is worth running.
 */
export function declaresBundle(staticReport: Record<string, any>): boolean {
  const patchPaths = staticReport?.dimensions?.L0_qualification?.metrics?.patchPaths;
  if (Array.isArray(patchPaths)) return patchPaths.length > 0;
  // No metric to read: fall back to the declared field, then to the verdict.
  const declared = staticReport?.subject?.dshBundlePatch;
  if (declared !== undefined && declared !== null) return true;
  return staticReport?.dimensions?.L0_qualification?.status === 'pass';
}

const NOT_A_BUNDLE_REASON =
  'not run: the subject declares no dsh.bundle.patch, so it installs as a plain dependency that is never composed; running this dimension would measure the absence of the subject rather than the subject';

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
  if (execution.L2_load.observation) {
    const inventory = makeExcerpt(JSON.stringify(execution.L2_load.observation), {
      paths: RUN_PATHS, maxBytes: MAX_EXCERPT_BYTES,
    });
    evidence.push({
      id: 'e-l2-inventory', kind: 'sample',
      command: 'pluginManager.listBundles() + pluginManager.listPlugins() in the running Host',
      excerpt: inventory.text, excerptBytes: inventory.bytes, truncated: inventory.truncated,
    });
  }
  if (l6Step) evidence.push(evidenceFromStep('e-l6-remove', l6Step, 'dsh plugin --profile verify remove <subject>'));

  // A decisive status must cite evidence. If the execution result claims one but
  // carries no step record for it, the claim cannot be published: it is
  // downgraded to inconclusive rather than propped up with a fabricated entry.
  const missingStepNote = (name: string): string[] => [
    `the execution result reported a status for ${name} but carried no step record, so it could not be evidenced and was downgraded to inconclusive`,
  ];


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

  const l3Step = stepFor(execution, 'l3-session');
  if (l3Step) evidence.push(evidenceFromStep('e-l3-session', l3Step, 'dsh --profile l3 --patch <overlay> --json <task>'));

  const dims = report.dimensions as Record<string, Dimension>;
  const isBundle = declaresBundle(report);

  const l1 = execution.L1_install;
  const l1Status: Dimension['status'] = !l1Step
    ? 'inconclusive'
    : (['pass', 'fail', 'timeout', 'inconclusive'] as const).includes(l1.status as 'pass')
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
      diagnosticsLog: l1.logPath ? redactRunText(l1.logPath) : null,
    },
    evidenceRefs: l1Step ? ['e-l1-install'] : [],
    notes: [
      redactRunText(l1.detail),
      ...(l1Step ? [] : missingStepNote('L1_install')),
      'no dependency build script was approved by the verifier; approval permits commands with the host user permissions',
    ],
  };

  const l2 = execution.L2_load;
  const observedLoadPass = l2.observation?.found && l2.observation.enabled && !l2.observation.error &&
    l2.observation.browserClientDeclared === false &&
    l2.observation.rows.length > 0 && l2.observation.rows.every((row) =>
      row.entryId && row.enabled && row.fiberPhase === 'active');
  if (l2.status === 'skip') {
    dims.L2_load = {
      id: 'L2',
      status: 'skip',
      summary: l2.reason,
      evidenceRefs: [],
      notes: [redactRunText(l2.detail)],
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
      status: l2.status === 'pass' && !observedLoadPass ? 'inconclusive' : l2.status as Dimension['status'],
      summary: l2.status === 'pass' && !observedLoadPass ? 'active subject fibers were not evidenced' : l2.reason,
      metrics: {
        bootBoundMs: execution.environment.bootBoundMs ?? null,
        durationMs: l2Step.durationMs,
        signal: l2Step.signal,
        observedRows: l2.observation?.rows.length ?? null,
        activeRows: l2.observation?.rows.filter((row) => row.enabled && row.fiberPhase === 'active').length ?? null,
        browserClientDeclared: l2.observation?.browserClientDeclared ?? null,
      },
      evidenceRefs: ['e-l2-boot', ...(l2.observation ? ['e-l2-inventory'] : [])],
      notes: [
        redactRunText(l2.detail),
        l2.observation
          ? 'Host bundle rows were read from the running plugin manager; browser client execution requires separate evidence'
          : 'the loader inventory was unavailable; process lifetime alone did not earn a load pass',
      ],
    };
  }

  const l6 = execution.L6_uninstall;
  if (l6.status === 'skip') {
    dims.L6_uninstall = { id: 'L6', status: 'skip', summary: l6.reason, evidenceRefs: [], notes: [redactRunText(l6.detail)] };
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
      metrics: { residue: l6.residue.map(redactRunText), durationMs: l6Step.durationMs },
      evidenceRefs: ['e-l6-remove'],
      notes: [redactRunText(l6.detail)],
    };
  }

  const l3 = execution.L3_run;
  if (!l3) {
    dims.L3_run = {
      id: 'L3',
      status: 'skip',
      summary: 'not run: the execution result carried no L3 outcome',
      evidenceRefs: [],
      notes: ['a session was not attempted'],
    };
  } else if (l3.status === 'skip') {
    dims.L3_run = { id: 'L3', status: 'skip', summary: l3.reason, evidenceRefs: [], notes: [redactRunText(l3.detail)] };
  } else {
    dims.L3_run = {
      id: 'L3',
      status: l3.status as Dimension['status'],
      summary: l3.reason,
      metrics: {
        replayAdapter: l3.replayAdapter,
        probeTask: l3.task,
        events: l3.events ? Object.fromEntries(Object.entries(l3.events).filter(([key]) =>
          ['turnEndReason', 'finalEventSeen', 'textEventCount', 'errorEventSeen', 'exitCode', 'durationMs', 'eventCount'].includes(key))) : null,
      },
      evidenceRefs: l3Step ? ['e-l3-session'] : [],
      notes: [
        redactRunText(l3.detail),
        `probe task, stated verbatim: ${JSON.stringify(l3.task)}`,
        ...(l3Step ? [] : missingStepNote('L3_run')),
      ],
    };
  }

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
    // What the resources actually were, not just how many. A bare count of 11
    // tells a reader nothing about what a plugin holds open.
    const kindsFor = (label: string): Record<string, number> => {
      const run = (l5.runs ?? []).filter((r) => r.label === label && r.ok).pop();
      return { ...(run?.activeKinds ?? {}), ...(run?.libuvHandleTypes ?? {}) };
    };

    report.overhead = {
      method: 'differential',
      status: l5.status,
      samples: l5.samples,
      baseline: l5.baseline,
      activated: l5.activated,
      delta: l5.delta,
      significant: l5.significant,
      resourceKinds: { baseline: kindsFor('baseline'), activated: kindsFor('activated') },
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
  // Enforce the pre-filter last, so it overrides whatever execution reported.
  if (!isBundle) {
    for (const key of ['L1_install', 'L2_load', 'L3_run', 'L5_overhead', 'L6_uninstall'] as const) {
      dims[key] = {
        id: key.slice(0, 2),
        status: 'skip',
        summary: NOT_A_BUNDLE_REASON,
        evidenceRefs: [],
        notes: [
          'a package that is not a bundle cannot be loaded, run, measured or uninstalled as a plugin',
          'this dimension was skipped by the L0 pre-filter rather than measured',
        ],
      };
    }
    delete report.overhead;
    report.limits = [
      ...((report.limits as string[] | undefined) ?? []),
      'the subject is not an installable plugin bundle, so no execution dimension applies to it',
    ];
  }

  report.runtime = runtime;

  report.container = {
    ...report.container,
    image: process.env.VERIFIER_IMAGE ?? report.container?.image ?? 'unknown',
    imageDigest: process.env.VERIFIER_IMAGE_DIGEST ?? null,
    notes: `network-denied execution container; install outcome: ${l1Status}; later phases ran only where their dimensions say so`,
  };

  report.verdict = deriveVerdict(dims as Record<DimensionKey, Dimension>);
  report.limits = [
    ...(report.limits ?? []).filter((l: string) => !/no source paths/.test(l) || true),
    ...(l5 && l5.status !== 'inconclusive'
      ? []
      : ['L5 overhead sampling did not complete, so no cost claim is made']),
    ...(l3 && l3.status === 'pass'
      ? [
          'L3 ran against a replayed transcript from a fixture authored by the verifier, not against a provider: it establishes that a session completes without a credential, not that the plugin behaves correctly against a live model',
        ]
      : []),
    ...(l2.observation ? [] : ['L2 loader inventory was unavailable; no active-fiber claim is made']),
    ...execution.notes.map(redactRunText),
  ].filter((l: string, i: number, all: string[]) => all.indexOf(l) === i);

  report.disclaimers = [DISCLAIMER];
  return report;
}
