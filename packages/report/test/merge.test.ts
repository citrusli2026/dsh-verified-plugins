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
    L2_load: { status: 'pass', reason: 'booted and settled', detail: 'no diagnostics', diagnostics: '' },
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

test('merge: L3 is recorded as blocked, never as a pass', () => {
  const merged = mergeExecution(staticReport(), execution());
  const l3 = (merged.dimensions as Record<string, Dimension>).L3_run;
  assert.equal(l3.status, 'blocked');
  assert.match(l3.summary, /not installable against dsh 0.2.0-rc.2/);
  // Because L3 cannot pass, `verified` is unreachable — the ladder is not softened.
  assert.notEqual(merged.verdict, 'verified');
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
