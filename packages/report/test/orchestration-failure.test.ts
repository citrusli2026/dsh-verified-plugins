import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orchestrationFailure } from '../src/orchestration-failure.ts';
import { DISCLAIMER, loadSchema, validateReport } from '../src/validate.ts';

const schema = loadSchema('schemas/dsh.plugin.report.v1.schema.json');
const staticReport = {
  schema: 'dsh.plugin.report.v1', reportId: 'npm:example@1.0.0',
  generatedAt: '2026-10-04T00:00:00.000Z',
  verifier: { name: 'dsh-verified', version: '0.1.0' },
  subject: { spec: 'example@1.0.0', name: 'example', version: '1.0.0', integrity: 'sha512-AAAA' },
  runtime: { dshVersion: 'not-executed', nodeVersion: 'v24.0.0' },
  container: { image: 'none', imageDigest: null }, verdict: 'partial',
  dimensions: Object.fromEntries([
    'L0_qualification', 'L1_install', 'L2_load', 'L3_run',
    'L4_capability', 'L5_overhead', 'L6_uninstall',
  ].map((key) => [key, {
    id: key.slice(0, 2), status: key === 'L0_qualification' || key === 'L4_capability' ? 'pass' : 'skip',
    summary: 'static result',
    evidenceRefs: key === 'L0_qualification' ? ['e-l0'] : key === 'L4_capability' ? ['e-l4'] : [],
  }])),
  capabilities: [], evidence: [{ id: 'e-l0', kind: 'static' }, { id: 'e-l4', kind: 'static' }],
  disclaimers: [DISCLAIMER],
};

test('a prefetch failure produces a valid report without execution claims', () => {
  const report = orchestrationFailure(staticReport, 'prefetch', 4, 1000, 'image', 'sha256:abc', '0.2.0-rc.2');
  assert.deepEqual(validateReport(report, schema), []);
  assert.equal(report.dimensions.L1_install.status, 'blocked');
  assert.equal(report.dimensions.L2_load.status, 'skip');
  assert.equal(report.container.imageDigest, 'sha256:abc');
});

test('a killed execution produces timeout conclusions backed by its exit code', () => {
  const report = orchestrationFailure(staticReport, 'execution', 124, 420000, 'image', 'sha256:abc', '0.2.0-rc.2');
  assert.deepEqual(validateReport(report, schema), []);
  for (const key of ['L1_install', 'L2_load', 'L3_run', 'L5_overhead', 'L6_uninstall']) {
    assert.equal(report.dimensions[key].status, 'timeout');
    assert.deepEqual(report.dimensions[key].evidenceRefs, ['e-orchestration']);
  }
  assert.equal(report.evidence.at(-1).exitCode, 124);
  assert.equal(report.verdict, 'partial');
});
