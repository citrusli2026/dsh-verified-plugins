/**
 * Tests for the correction loop: an amendment must be additive, and its
 * changelog must describe what actually changed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AmendmentError, amendReport, describeDiff, diffReports } from '../src/amend.ts';
import { DISCLAIMER, loadSchema, validateReport } from '../src/validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = loadSchema(join(HERE, '..', '..', '..', 'schemas', 'dsh.plugin.report.v1.schema.json'));

function report(overrides: Record<string, any> = {}): Record<string, any> {
  const base: Record<string, any> = {
    schema: 'dsh.plugin.report.v1',
    reportId: 'npm:example@1.0.0',
    generatedAt: '2026-10-01T00:00:00.000Z',
    verifier: { name: 'dsh-verified', version: '0.1.0' },
    subject: { spec: 'example@1.0.0', name: 'example', version: '1.0.0', integrity: 'sha512-AAAA' },
    runtime: { dshVersion: '0.2.0-rc.2', nodeVersion: 'v24.0.0' },
    verdict: 'partial',
    dimensions: {
      L0_qualification: { id: 'L0', status: 'pass', summary: 'ok', evidenceRefs: ['e1'] },
      L1_install: { id: 'L1', status: 'fail', summary: 'refused', evidenceRefs: ['e2'] },
      L2_load: { id: 'L2', status: 'skip', summary: 'not run', evidenceRefs: [] },
      L3_run: { id: 'L3', status: 'skip', summary: 'not run', evidenceRefs: [] },
      L4_capability: { id: 'L4', status: 'pass', summary: 'ok', evidenceRefs: ['e1'] },
      L5_overhead: { id: 'L5', status: 'skip', summary: 'not run', evidenceRefs: [] },
      L6_uninstall: { id: 'L6', status: 'skip', summary: 'not run', evidenceRefs: [] },
    },
    capabilities: [],
    evidence: [{ id: 'e1', kind: 'static' }, { id: 'e2', kind: 'command', exitCode: 1 }],
    disclaimers: [DISCLAIMER],
  };
  return { ...base, ...overrides };
}

test('amend: a correction records the change and the report it supersedes', () => {
  const previous = report();
  const next = report({
    reportId: 'npm:example@1.0.1',
    subject: { spec: 'example@1.0.1', name: 'example', version: '1.0.1', integrity: 'sha512-BBBB' },
    dimensions: {
      ...report().dimensions,
      L1_install: { id: 'L1', status: 'pass', summary: 'installed', evidenceRefs: ['e2'] },
      L2_load: { id: 'L2', status: 'pass', summary: 'booted', evidenceRefs: ['e2'] },
      L3_run: { id: 'L3', status: 'pass', summary: 'session completed', evidenceRefs: ['e2'] },
      L5_overhead: { id: 'L5', status: 'pass', summary: 'no delta', evidenceRefs: ['e2'] },
      L6_uninstall: { id: 'L6', status: 'pass', summary: 'clean', evidenceRefs: ['e2'] },
    },
    verdict: 'verified',
  });

  const { report: amended, diff } = amendReport(previous, next, {
    change: 'the plugin declared peers matching the runtime; re-verified at 1.0.1',
    date: '2026-10-04',
  });

  assert.equal(amended.supersedes, 'npm:example@1.0.0');
  assert.equal(amended.changelog.length, 1);
  assert.equal(amended.changelog[0].date, '2026-10-04');
  assert.equal(amended.changelog[0].supersedesVerdict, 'partial');
  assert.match(amended.changelog[0].changeDescription, /verdict partial → verified/);
  assert.match(amended.changelog[0].changeDescription, /L1_install fail → pass/);

  assert.equal(diff.verdict.after, 'verified');
  assert.ok(diff.dimensions.some((d) => d.key === 'L2_load' && d.before === 'skip' && d.after === 'pass'));

  assert.deepEqual(validateReport(amended, SCHEMA), []);
});

test('amend: the changelog describes the diff, not what the author claimed', () => {
  // A correction cannot be published with a changelog that misdescribes it.
  const previous = report();
  const next = report({ reportId: 'npm:example@1.0.1', verdict: 'partial', dimensions: report().dimensions });
  const { report: amended } = amendReport(previous, next, { change: 'everything changed' });
  assert.match(amended.changelog[0].changeDescription, /no dimension status changed/);
});

test('amend: dropping evidence is refused — that is a retraction, not a correction', () => {
  const previous = report();
  const next = report({
    reportId: 'npm:example@1.0.1',
    evidence: [{ id: 'e1', kind: 'static' }],
  });
  assert.throws(
    () => amendReport(previous, next, { change: 'tidied up' }),
    (error: unknown) => error instanceof AmendmentError && error.reason === 'evidence-removed',
  );
});

test('amend: a reason is required', () => {
  assert.throws(
    () => amendReport(report(), report({ reportId: 'npm:example@1.0.1' }), { change: '   ' }),
    (error: unknown) => error instanceof AmendmentError && error.reason === 'no-reason',
  );
});

test('amend: a report cannot supersede itself', () => {
  const same = report();
  assert.throws(
    () => amendReport(same, report(), { change: 'x' }),
    (error: unknown) => error instanceof AmendmentError && error.reason === 'same-report',
  );
});

test('amend: a correction must cover the same package', () => {
  const next = report({ reportId: 'npm:other@1.0.0', subject: { name: 'other', version: '1.0.0' } });
  assert.throws(
    () => amendReport(report(), next, { change: 'x' }),
    (error: unknown) => error instanceof AmendmentError && error.reason === 'different-subject',
  );
});

test('amend: keepers are preserved and the changelog accumulates', () => {
  const once = amendReport(report(), report({ reportId: 'npm:example@1.0.1' }), { change: 'first' });
  const twice = amendReport(once.report, report({ reportId: 'npm:example@1.0.2' }), { change: 'second' });
  assert.equal(twice.report.changelog.length, 2);
  assert.equal(twice.report.changelog[0].change, 'first');
  assert.equal(twice.report.changelog[1].change, 'second');
  assert.equal(twice.report.supersedes, 'npm:example@1.0.1');
});

test('describeDiff: a no-op amendment reads as one', () => {
  const same = report();
  assert.equal(describeDiff(diffReports(same, JSON.parse(JSON.stringify(same)))), 'no dimension status changed');
});
