/**
 * Tests for the report contract: schema validation, verdict aggregation, and
 * redaction. These run with `node --test` and need no dependencies.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateAgainst, findUnsupportedKeywords } from '../src/schema.ts';
import { DISCLAIMER, deriveVerdict, loadSchema, validateReport, type Dimension } from '../src/validate.ts';
import { makeExcerpt, redactPaths, redactSecrets } from '../src/redact.ts';
import { buildCatalogIndex, summariseReport } from '../src/catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = loadSchema(join(HERE, '..', '..', '..', 'schemas', 'dsh.plugin.report.v1.schema.json'));

function dimension(status: Dimension['status']): Dimension {
  return { id: 'L0', status, summary: 'x', evidenceRefs: ['e1'] };
}

const ALL_PASS = {
  L0_qualification: { ...dimension('pass'), id: 'L0' },
  L1_install: { ...dimension('pass'), id: 'L1' },
  L2_load: { ...dimension('pass'), id: 'L2' },
  L3_run: { ...dimension('pass'), id: 'L3' },
  L4_capability: { ...dimension('pass'), id: 'L4' },
  L5_overhead: { ...dimension('pass'), id: 'L5' },
  L6_uninstall: { ...dimension('pass'), id: 'L6' },
};

function validReport(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    schema: 'dsh.plugin.report.v1',
    reportId: 'npm:example@1.0.0',
    generatedAt: '2026-10-03T00:00:00.000Z',
    verifier: { name: 'dsh-verified', version: '0.1.0' },
    subject: { spec: 'example@1.0.0', name: 'example', version: '1.0.0', integrity: 'sha512-AAAA' },
    runtime: { dshVersion: '0.2.0-rc.2', nodeVersion: 'v24.0.0' },
    verdict: 'verified',
    dimensions: ALL_PASS,
    capabilities: [],
    evidence: [{ id: 'e1', kind: 'command' }],
    disclaimers: [DISCLAIMER],
    ...overrides,
  };
}

test('schema: the schema stays inside the validator subset', () => {
  assert.deepEqual(findUnsupportedKeywords(SCHEMA), []);
});

test('schema: a well-formed report passes', () => {
  assert.deepEqual(validateReport(validReport(), SCHEMA), []);
});

test('schema: rejects an unknown top-level property', () => {
  const issues = validateAgainst({ a: 1, b: 2 }, {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'number' } },
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.message, /unexpected property "b"/);
});

test('schema: enum and const are enforced', () => {
  const issues = validateAgainst({ v: 'nope' }, { type: 'object', properties: { v: { enum: ['yes'] } } });
  assert.match(issues[0]!.message, /not one of "yes"/);
});

test('verdict: L0 failure is not-installable regardless of the rest', () => {
  const dims = { ...ALL_PASS, L0_qualification: { ...dimension('fail'), id: 'L0' } } as Record<string, Dimension>;
  assert.equal(deriveVerdict(dims as never), 'not-installable');
});

test('verdict: all dimensions passing is verified', () => {
  assert.equal(deriveVerdict(ALL_PASS as never), 'verified');
});

test('verdict: one blocked dimension is enough to lose verified', () => {
  const dims = { ...ALL_PASS, L3_run: { ...dimension('blocked'), id: 'L3' } } as Record<string, Dimension>;
  assert.equal(deriveVerdict(dims as never), 'partial');
});

test('verdict: nothing decisive is inconclusive', () => {
  const dims = Object.fromEntries(
    Object.entries(ALL_PASS).map(([k, v]) => [k, { ...v, status: 'skip' }]),
  ) as Record<string, Dimension>;
  assert.equal(deriveVerdict(dims as never), 'inconclusive');
});

test('a verdict may not exceed the dimensions that executed', () => {
  const report = validReport({
    verdict: 'verified',
    dimensions: { ...ALL_PASS, L1_install: { ...dimension('blocked'), id: 'L1' } },
  });
  const issues = validateReport(report, SCHEMA);
  const verdictIssue = issues.find((i) => i.path === '$.verdict');
  assert.ok(verdictIssue, 'expected a verdict mismatch');
  assert.match(verdictIssue!.message, /add up to "partial"/);
});

test('a decisive dimension with no evidence is rejected', () => {
  const report = validReport({
    dimensions: { ...ALL_PASS, L2_load: { ...dimension('pass'), id: 'L2', evidenceRefs: [] } },
  });
  const issues = validateReport(report, SCHEMA);
  assert.ok(issues.some((i) => /must cite at least one piece of evidence/.test(i.message)));
});

test('dangling evidence references are rejected', () => {
  const report = validReport({
    dimensions: { ...ALL_PASS, L4_capability: { ...dimension('pass'), id: 'L4', evidenceRefs: ['nope'] } },
  });
  const issues = validateReport(report, SCHEMA);
  assert.ok(issues.some((i) => /unknown evidence "nope"/.test(i.message)));
});

test('the not-an-endorsement disclaimer is mandatory', () => {
  const issues = validateReport(validReport({ disclaimers: ['something else'] }), SCHEMA);
  assert.ok(issues.some((i) => /not-an-endorsement/.test(i.message)));
});

test('over-long excerpts are rejected', () => {
  const report = validReport({
    evidence: [{ id: 'e1', kind: 'command', excerpt: 'x'.repeat(3000) }],
  });
  const issues = validateReport(report, SCHEMA);
  assert.ok(issues.some((i) => /over the 2048-byte limit/.test(i.message)));
});

test('redaction: a planted secret never survives', () => {
  // Assembled at runtime so this file contains no token-shaped literal. The
  // repository's own hygiene scanner flags those — correctly — and a test
  // fixture is not a good reason to weaken it.
  const token = `ghp_${'A'.repeat(36)}`;
  const planted = `token=${token} done`;
  const { text, redactions } = redactSecrets(planted);
  assert.ok(!text.includes(token), 'the token must be gone');
  assert.match(text, /\[redacted:github-token\]/);
  assert.equal(redactions.find((r) => r.reason === 'github-token')?.count, 1);
});

test('redaction: environment values are removed but names are kept', () => {
  const { text } = redactSecrets('DSH_API_KEY=supersecretvalue other=1');
  assert.match(text, /DSH_API_KEY=\[redacted:env-value\]/);
  assert.ok(!text.includes('supersecretvalue'));
  assert.ok(text.includes('other=1'), 'non-secret names must survive');
});

test('redaction: home paths are rewritten', () => {
  const { text, redactions } = redactPaths('/Users/alice/.dsh/profiles', {
    paths: [{ from: '/Users/alice', to: '<home>' }],
  });
  assert.equal(text, '<home>/.dsh/profiles');
  assert.equal(redactions[0]?.count, 1);
});

test('redaction: excerpts are capped on a byte boundary without splitting UTF-8', () => {
  const result = makeExcerpt('é'.repeat(4000)); // 2 bytes each
  assert.equal(result.truncated, true);
  assert.ok(result.bytes <= 2048, `expected <= 2048 bytes, got ${result.bytes}`);
  assert.ok(!result.text.includes('\uFFFD'), 'no replacement character may survive');
  assert.deepEqual(Buffer.from(result.text, 'utf8'), Buffer.from(result.text, 'utf8'));
});

test('catalog: index counts are derived, and coverage is stated', () => {
  const reports = [
    summariseReport('catalog/npm/a.json', validReport({ reportId: 'npm:a@1.0.0' })),
    summariseReport('catalog/npm/b.json', validReport({ reportId: 'npm:b@1.0.0', verdict: 'not-installable' })),
  ];
  const index = buildCatalogIndex(reports, { now: new Date('2026-10-03T00:00:00Z') });
  assert.equal(index.counts.total, 2);
  assert.equal(index.counts.byVerdict.verified, 1);
  assert.equal(index.counts.byVerdict['not-installable'], 1);
  assert.match(index.coverage.note, /not a census/);
  assert.deepEqual(
    index.entries.map((e) => e.reportId),
    ['npm:a@1.0.0', 'npm:b@1.0.0'],
  );
});
