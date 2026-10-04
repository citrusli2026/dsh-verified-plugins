/**
 * Tests for the execution merge: the point where a static-only `partial` either
 * earns its execution dimensions or does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadSchema, validateReport, DISCLAIMER, type Dimension } from '../src/validate.ts';
import { mergeExecution, type ExecutionResult, type ExecutionStep } from '../src/merge.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = loadSchema(join(HERE, '..', '..', '..', 'schemas', 'dsh.plugin.report.v1.schema.json'));

function dim(id: string, status: Dimension['status'], refs: string[] = []): Dimension {
  return { id, status, summary: 'static result', evidenceRefs: refs };
}

function staticReport(): Record<string, any> {
  return {
    schema: 'dsh.plugin.report.v1',
    reportId: 'npm:example@1.0.0',
    generatedAt: '2026-10-03T00:00:00.000Z',
    verifier: { name: 'dsh-verified', version: '0.1.0' },
    subject: { spec: 'example@1.0.0', name: 'example', version: '1.0.0', integrity: 'sha512-AAAA' },
    runtime: { dshVersion: 'not-executed', nodeVersion: 'v24.0.0' },
    container: { image: 'none', imageDigest: null },
    verdict: 'partial',
    dimensions: {
      L0_qualification: dim('L0', 'pass', ['e-l0']),
      L1_install: dim('L1', 'skip'),
      L2_load: dim('L2', 'skip'),
      L3_run: dim('L3', 'skip'),
      L4_capability: dim('L4', 'pass', ['e-l4']),
      L5_overhead: dim('L5', 'skip'),
      L6_uninstall: dim('L6', 'skip'),
    },
    capabilities: [],
    evidence: [
      { id: 'e-l0', kind: 'static' },
      { id: 'e-l4', kind: 'static' },
    ],
    disclaimers: [DISCLAIMER],
  };
}

function step(name: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    name,
    command: `dsh ${name}`,
    exitCode: 0,
    signal: null,
    durationMs: 1234,
    timedOut: false,
    excerpt: 'ok',
    ...overrides,
  };
}

function execution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    schema: 'dsh.verifier.execution.v1',
    spec: 'example@1.0.0',
    generatedAt: '2026-10-03T00:10:00.000Z',
    environment: { dshVersion: '0.2.0-rc.2', nodeVersion: 'v24.21.0', bootBoundMs: 25_000 },
    L1_install: {
      status: 'pass',
      reason: 'installed',
      detail: 'exit 0',
      declaredPeers: null,
      bundlesAfter: ['example'],
      pendingBuildScripts: [],
      logPath: null,
    },
    L2_load: {
      status: 'pass', reason: 'one subject row active', detail: 'inventory read', diagnostics: '',
      observation: { found: true, enabled: true, error: null, overrides: [],
        rows: [{ rowId: 'subject', entryId: 'subject', enabled: true, fiberPhase: 'active' }] },
    },
    L6_uninstall: { status: 'pass', reason: 'removed without residue', detail: 'clean', residue: [] },
    steps: [step('l1-install'), step('l2-boot', { signal: 'SIGKILL', timedOut: true, exitCode: null }), step('l6-remove')],
    notes: [],
    ...overrides,
  };
}

test('merge: the merged report satisfies the published schema', () => {
  const merged = mergeExecution(staticReport(), execution());
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: execution replaces the skipped dimensions with real statuses', () => {
  const merged = mergeExecution(staticReport(), execution());
  const dims = merged.dimensions as Record<string, Dimension>;
  assert.equal(dims.L1_install.status, 'pass');
  assert.equal(dims.L2_load.status, 'pass');
  assert.equal(dims.L6_uninstall.status, 'pass');
  assert.equal(merged.runtime.dshVersion, '0.2.0-rc.2');
});

test('merge: a load pass without active subject fiber evidence is downgraded', () => {
  const result = execution();
  delete result.L2_load.observation;
  const merged = mergeExecution(staticReport(), result);
  assert.equal(merged.dimensions.L2_load.status, 'inconclusive');
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: an offline cache miss cannot become an install failure', () => {
  const exec = execution({
    L1_install: {
      status: 'inconclusive', reason: 'offline artifact resolution was incomplete',
      detail: 'the required package was absent from the offline store',
      declaredPeers: null, bundlesAfter: null, pendingBuildScripts: [], logPath: null,
    },
    L2_load: { status: 'skip', reason: 'not installed', detail: 'not run', diagnostics: '' },
    L6_uninstall: { status: 'skip', reason: 'not installed', detail: 'not run', residue: [] },
    steps: [step('l1-install', { exitCode: 1, excerpt: 'ERR_PNPM_NO_OFFLINE_META' })],
  });
  const merged = mergeExecution(staticReport(), exec);
  assert.equal(merged.dimensions.L1_install.status, 'inconclusive');
  assert.equal(merged.verdict, 'partial');
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: a peer-incompatible install is a failure, and skips load and uninstall', () => {
  const exec = execution({
    L1_install: {
      status: 'fail',
      reason: 'peer-incompatible with the pinned runtime',
      detail: 'DSH refused the install',
      declaredPeers: { '@deepseek-ai/dsh-tools': '^0.1.0-rc.6' },
      bundlesAfter: ['@deepseek-ai/dsh-base'],
      pendingBuildScripts: [],
      logPath: '/work/logs/pnpm.log',
    },
    L2_load: { status: 'skip', reason: 'not run: the subject did not install', detail: 'x', diagnostics: '' },
    L6_uninstall: { status: 'skip', reason: 'not run: the subject did not install', detail: 'x', residue: [] },
    steps: [step('l1-install', { exitCode: 1, excerpt: 'installation rejected' })],
  });
  const merged = mergeExecution(staticReport(), exec);
  const dims = merged.dimensions as Record<string, Dimension>;
  assert.equal(dims.L1_install.status, 'fail');
  assert.equal(dims.L2_load.status, 'skip');
  assert.equal(dims.L6_uninstall.status, 'skip');
  assert.equal(merged.verdict, 'partial');
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: sampled peers and the approved-build-script count are recorded', () => {
  const exec = execution({
    L1_install: {
      status: 'pass',
      reason: 'installed',
      detail: 'exit 0',
      declaredPeers: { '@deepseek-ai/dsh-tools': '^0.2.0' },
      bundlesAfter: ['@deepseek-ai/dsh-base', 'example'],
      pendingBuildScripts: ['sharp'],
      logPath: '/work/logs/pnpm.log',
    },
  });
  const merged = mergeExecution(staticReport(), exec);
  const metrics = (merged.dimensions as Record<string, any>).L1_install.metrics;
  assert.deepEqual(metrics.declaredPeers, { '@deepseek-ai/dsh-tools': '^0.2.0' });
  assert.deepEqual(metrics.pendingBuildScripts, ['sharp']);
  assert.equal(metrics.buildScriptsApproved, 0, 'the verifier never approves build scripts');
});

test('merge: without an L3 outcome, the dimension is skipped rather than asserted', () => {
  const merged = mergeExecution(staticReport(), execution());
  const l3 = (merged.dimensions as Record<string, Dimension>).L3_run;
  assert.equal(l3.status, 'skip');
  assert.match(l3.summary, /no L3 outcome/);
  assert.notEqual(merged.verdict, 'verified');
});

test('merge: a completed keyless session is an L3 pass with its probe task published', () => {
  const exec = execution({
    L3_run: {
      status: 'pass',
      reason: 'a session completed with no credential',
      detail: 'the model call was served by the replay adapter',
      task: 'reply with any text',
      events: { turnEndReason: { kind: 'completed' }, finalText: 'fixture', exitCode: 0 },
      replayAdapter: '@deepseek-ai/dsh-llm-replay@0.2.0-rc.2',
    },
    steps: [step('l1-install'), step('l2-boot', { signal: 'SIGKILL', timedOut: true, exitCode: null }), step('l3-session'), step('l6-remove')],
  });
  const merged = mergeExecution(staticReport(), exec);
  const l3 = (merged.dimensions as Record<string, Dimension>).L3_run;
  assert.equal(l3.status, 'pass');
  assert.deepEqual(l3.evidenceRefs, ['e-l3-session']);
  assert.equal(l3.metrics?.probeTask, 'reply with any text');
  assert.equal((l3.metrics?.events as Record<string, unknown>).finalText, undefined);
  // The detailed claim lives once, in the dimension notes...
  assert.ok(l3.notes?.some((n) => /served by the replay adapter/.test(n)));
  // ...and the report says plainly what a replayed session does not establish.
  assert.ok(
    (merged.limits as string[]).some((l) => /not against a provider/.test(l)),
    'a replayed L3 must carry its own limitation',
  );
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: execution evidence does not publish container paths, tokens or session text', () => {
  const exec = execution({
    L1_install: {
      ...execution().L1_install,
      logPath: '/work/dsh-home/profiles/verify/pnpm.log',
    },
    L3_run: {
      status: 'pass', reason: 'completed', detail: 'fixture', task: 'reply with any text',
      events: { finalText: 'secret transcript', finalEventSeen: true },
      replayAdapter: '@deepseek-ai/dsh-llm-replay@0.2.0-rc.2',
    },
    steps: [
      step('l1-install', { excerpt: 'at /usr/local/lib/tool.js TOKEN=private-value' }),
      step('l2-boot'),
      step('l3-session', { command: 'dsh --patch /work/fixtures/replay/l3-overlay.yml', excerpt: '{"type":"final","text":"secret transcript","sessionId":"abc"}' }),
      step('l6-remove'),
    ],
  });
  const merged = mergeExecution(staticReport(), exec);
  const serialized = JSON.stringify(merged);
  assert.ok(!serialized.includes('/work/'));
  assert.ok(!serialized.includes('/usr/local/'));
  assert.ok(!serialized.includes('private-value'));
  assert.ok(!serialized.includes('secret transcript'));
  assert.ok(!serialized.includes('"sessionId":"abc"'));
  assert.match(serialized, /\[redacted:session-content\]/);
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: all seven dimensions passing reaches verified', () => {
  // The first time the ladder can be satisfied: with L3 measured, nothing is
  // skipped or blocked any more.
  const exec = execution({
    L3_run: {
      status: 'pass',
      reason: 'a session completed with no credential',
      detail: 'served by the replay adapter',
      task: 'reply with any text',
      events: { turnEndReason: { kind: 'completed' } },
      replayAdapter: '@deepseek-ai/dsh-llm-replay@0.2.0-rc.2',
    },
    L5_overhead: {
      status: 'no-significant-delta',
      reason: 'no metric moved beyond the significance thresholds; that is the finding',
      samples: 6,
      baseline: { rss: 100 },
      activated: { rss: 101 },
      delta: { rss: 1 },
      significant: [],
    },
    steps: [step('l1-install'), step('l2-boot', { signal: 'SIGKILL', timedOut: true, exitCode: null }), step('l3-session'), step('l6-remove')],
  });
  const merged = mergeExecution(staticReport(), exec);
  assert.equal(merged.verdict, 'verified');
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: a verdict may never exceed what executed', () => {
  const merged = mergeExecution(staticReport(), execution());
  assert.equal(merged.verdict, 'partial');
});

test('merge: long step output is capped and flagged, not published whole', () => {
  const exec = execution({
    steps: [step('l1-install', { excerpt: 'x'.repeat(9000) })],
  });
  const merged = mergeExecution(staticReport(), exec);
  const evidence = (merged.evidence as any[]).find((e) => e.id === 'e-l1-install');
  assert.ok(evidence.excerptBytes <= 2048, `expected <= 2048, got ${evidence.excerptBytes}`);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.excerptBytes, Buffer.byteLength(evidence.excerpt, 'utf8'));
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: every executed dimension cites evidence that resolves', () => {
  const merged = mergeExecution(staticReport(), execution());
  const ids = new Set((merged.evidence as any[]).map((e) => e.id));
  for (const dimension of Object.values(merged.dimensions as Record<string, Dimension>)) {
    if (dimension.status === 'pass' || dimension.status === 'fail') {
      assert.ok(dimension.evidenceRefs.length > 0, `${dimension.id} must cite evidence`);
    }
    for (const ref of dimension.evidenceRefs) {
      assert.ok(ids.has(ref), `${dimension.id} cites missing evidence ${ref}`);
    }
  }
});

test('merge: a measured overhead delta is a pass and cites its samples', () => {
  const exec = execution({
    L5_overhead: {
      status: 'measured',
      reason: '1 metric(s) moved beyond the significance thresholds',
      samples: 6,
      baseline: { rss: 100_000_000, libuvHandles: 12, watchers: 0 },
      activated: { rss: 260_000_000, libuvHandles: 480, watchers: 69_000 },
      delta: { rss: 160_000_000, libuvHandles: 468, watchers: 69_000 },
      significant: [
        { metric: 'rss', baseline: 100_000_000, activated: 260_000_000, delta: 160_000_000, ratio: 2.6, reason: 'resident memory grew by more than 100 MiB' },
      ],
    },
  });
  const merged = mergeExecution(staticReport(), exec);
  const l5 = (merged.dimensions as Record<string, Dimension>).L5_overhead;
  assert.equal(l5.status, 'pass');
  assert.match(l5.summary, /beyond the significance thresholds/);
  assert.deepEqual(l5.evidenceRefs, ['e-l5-overhead']);
  assert.equal(merged.overhead.status, 'measured');
  assert.equal(merged.overhead.significant.length, 1);
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: no significant delta is a finding, not a missing measurement', () => {
  const exec = execution({
    L5_overhead: {
      status: 'no-significant-delta',
      reason: 'no metric moved beyond the significance thresholds; that is the finding',
      samples: 6,
      baseline: { rss: 100_000_000 },
      activated: { rss: 101_000_000 },
      delta: { rss: 1_000_000 },
      significant: [],
    },
  });
  const merged = mergeExecution(staticReport(), exec);
  const l5 = (merged.dimensions as Record<string, Dimension>).L5_overhead;
  assert.equal(l5.status, 'pass', 'a completed measurement passes even with a null result');
  assert.equal(merged.overhead.status, 'no-significant-delta');
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: an incomplete differential makes no cost claim', () => {
  const exec = execution({
    L5_overhead: {
      status: 'inconclusive',
      reason: 'the subject did not install, so there was nothing to activate',
      samples: 0,
      baseline: { rss: 100_000_000 },
      activated: {},
      delta: {},
      significant: [],
    },
  });
  const merged = mergeExecution(staticReport(), exec);
  const l5 = (merged.dimensions as Record<string, Dimension>).L5_overhead;
  assert.equal(l5.status, 'inconclusive');
  assert.equal(merged.overhead, undefined, 'no overhead object may be published without a measurement');
  assert.ok((merged.limits as string[]).some((l) => /no cost claim/.test(l)));
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('merge: without execution overhead at all, L5 stays skipped', () => {
  const merged = mergeExecution(staticReport(), execution());
  assert.equal((merged.dimensions as Record<string, Dimension>).L5_overhead.status, 'skip');
  assert.equal(merged.overhead, undefined);
});

test('merge: a non-bundle cannot collect execution passes', () => {
  // Regression: @morlay/session-branch@0.1.5 declares no dsh.bundle.patch, yet
  // it installed as a plain dependency and every execution dimension reported a
  // pass — a confident result about a subject that was never composed.
  const staticNonBundle = staticReport();
  staticNonBundle.dimensions.L0_qualification = {
    id: 'L0',
    status: 'fail',
    summary: 'package.json declares no dsh.bundle.patch',
    metrics: { patchPaths: [], fileCount: 15 },
    evidenceRefs: ['e-l0'],
  };
  staticNonBundle.verdict = 'not-installable';

  const merged = mergeExecution(staticNonBundle, execution());
  const dims = merged.dimensions as Record<string, Dimension>;
  for (const key of ['L1_install', 'L2_load', 'L3_run', 'L5_overhead', 'L6_uninstall']) {
    assert.equal(dims[key].status, 'skip', `${key} must not claim a result for a non-bundle`);
  }
  assert.equal(dims.L4_capability.status, 'pass', 'static findings still apply');
  assert.equal(merged.verdict, 'not-installable');
  assert.equal(merged.overhead, undefined, 'no cost claim may survive for a non-bundle');
  assert.deepEqual(validateReport(merged, SCHEMA), []);
});

test('declaresBundle: a bundle with a missing patch path is still a bundle', () => {
  const staticBrokenBundle = staticReport();
  staticBrokenBundle.dimensions.L0_qualification = {
    id: 'L0',
    status: 'fail',
    summary: 'declared bundle patch paths not present in the tarball',
    metrics: { patchPaths: ['./cordis.patch.yml'], missingPatchPaths: ['./cordis.patch.yml'] },
    evidenceRefs: ['e-l0'],
  };
  const merged = mergeExecution(staticBrokenBundle, execution());
  const dims = merged.dimensions as Record<string, Dimension>;
  assert.equal(dims.L1_install.status, 'pass', 'execution still applies to a malformed bundle');
});
