/**
 * Tests for the publish surface: badges and the static site.
 *
 * The property under test is not "does it render" but two safety properties:
 * every conclusion links to the evidence it rests on, and nothing from a
 * third-party package's metadata reaches the page as markup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BADGE_COLORS, BADGE_VOCABULARY, escapeXml, isBadgeVerdict, renderBadge } from '../src/badge.ts';
import { escapeHtml, renderIndexPage, renderReportPage, slugFor } from '../src/site.ts';
import { DISCLAIMER } from '../src/validate.ts';
import type { CatalogIndex } from '../src/catalog.ts';

/* ------------------------------------------------------------------- badge */

/** Visible text only: attributes legitimately contain percentages and digits. */
function visibleText(markup: string): string {
  return markup
    .replace(/<title>[\s\S]*?<\/title>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('badge: the vocabulary is exactly four states and the message is a state, not a score', () => {
  assert.deepEqual([...BADGE_VOCABULARY], ['verified', 'partial', 'inconclusive', 'not-installable']);
  const svg = renderBadge('verified', { subject: 'x@1.0.0' });
  // A score, percentage or grade would be a ranking, and a ranking is what made
  // the existing ecosystem signal untrustworthy. The message must be the state.
  const text = visibleText(svg);
  assert.ok(text.includes('verified'), 'the state is visible');
  // The doubled label/message are the shadow copies; what matters is that
  // nothing numeric leaks into what a reader sees.
  assert.ok(!/\d|%|score|rating/i.test(text), `badge text must be a state, not a number: ${JSON.stringify(text)}`);
});

test('badge: an unknown verdict is rendered as inconclusive, not invented', () => {
  assert.equal(isBadgeVerdict('excellent'), false);
  const svg = renderBadge('excellent');
  assert.match(svg, />inconclusive</);
  assert.ok(!svg.includes('>excellent<'), 'the unknown value is not published as a state');
  assert.match(svg, /unknown verdict/);
});

test('badge: each verdict has its own colour and the disclaimer travels in the tooltip', () => {
  const seen = new Set<string>();
  for (const verdict of BADGE_VOCABULARY) {
    const svg = renderBadge(verdict, { subject: 'x@1.0.0' });
    assert.match(svg, new RegExp(`fill="${BADGE_COLORS[verdict]}"`));
    seen.add(BADGE_COLORS[verdict]);
    assert.ok(svg.includes(DISCLAIMER.slice(0, 40)), `${verdict} badge must carry the disclaimer`);
  }
  assert.equal(seen.size, BADGE_VOCABULARY.length, 'the four states must be visually distinct');
});

test('badge: interpolated values are escaped', () => {
  const svg = renderBadge('verified', { subject: '<script>alert(1)</script>' });
  assert.ok(!svg.includes('<script>'), 'a package name must not become markup');
  assert.ok(svg.includes('&lt;script&gt;'));
});

/* -------------------------------------------------------------- escaping */

test('escapeHtml neutralises the five markup-significant characters', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(escapeXml('&'), '&amp;');
});

test('slugFor flattens scopes the way the catalogue paths do', () => {
  assert.equal(slugFor('@scope/name'), 'scope__name');
  assert.equal(slugFor('plain'), 'plain');
});

/* ------------------------------------------------------------- site pages */

function report(): Record<string, any> {
  return {
    schema: 'dsh.plugin.report.v1',
    reportId: 'npm:example@1.0.0',
    generatedAt: '2026-10-04T00:00:00.000Z',
    verifier: { name: 'dsh-verified', version: '0.1.0', commit: 'a'.repeat(40) },
    subject: {
      name: 'example',
      version: '1.0.0',
      integrity: 'sha512-AAAA',
      // Hostile on purpose: this is third-party metadata.
      repository: 'https://example.test/<script>alert(1)</script>',
    },
    runtime: { dshVersion: '0.2.0-rc.2', nodeVersion: 'v24.0.0', os: 'linux', arch: 'x64' },
    verdict: 'partial',
    dimensions: {
      L0_qualification: { id: 'L0', status: 'pass', summary: 'ok', evidenceRefs: ['e-l0'] },
      L1_install: { id: 'L1', status: 'fail', summary: 'refused', evidenceRefs: ['e-l1'] },
      L2_load: { id: 'L2', status: 'skip', summary: 'not run', evidenceRefs: [] },
      L3_run: { id: 'L3', status: 'skip', summary: 'not run', evidenceRefs: [] },
      L4_capability: { id: 'L4', status: 'pass', summary: '1 signal', evidenceRefs: ['e-l4'] },
      L5_overhead: { id: 'L5', status: 'skip', summary: 'not run', evidenceRefs: [] },
      L6_uninstall: { id: 'L6', status: 'skip', summary: 'not run', evidenceRefs: [] },
    },
    capabilities: [{ id: 'network_egress', present: true, confidence: 'medium', attribution: 'author-source', evidence: [{ file: 'src/a.ts', line: 3 }] }],
    evidence: [
      { id: 'e-l0', kind: 'static', excerpt: 'a < b & c' },
      { id: 'e-l1', kind: 'command', command: 'dsh plugin add', exitCode: 1, excerpt: 'refused' },
      { id: 'e-l4', kind: 'static', excerpt: 'scan' },
    ],
    limits: ['nothing about behaviour'],
    disclaimers: [DISCLAIMER],
  };
}

test('report page: every dimension links to evidence that exists on the page', () => {
  const html = renderReportPage(report(), 'example');
  const links = new Set([...html.matchAll(/href="#(e-[a-z0-9-]+)"/g)].map((m) => m[1] as string));
  const anchors = new Set([...html.matchAll(/id="(e-[a-z0-9-]+)"/g)].map((m) => m[1] as string));
  assert.ok(links.size >= 3, 'decisive dimensions must link to evidence');
  for (const link of links) assert.ok(anchors.has(link), `${link} links nowhere`);
  for (const anchor of anchors) assert.ok(links.has(anchor), `${anchor} is unreachable`);
});

test('report page: a dimension with no evidence says so rather than looking bare', () => {
  const html = renderReportPage(report(), 'example');
  assert.match(html, /no evidence cited/);
});

test('report page: third-party metadata cannot inject markup', () => {
  const html = renderReportPage(report(), 'example');
  assert.ok(!html.includes('<script>'), 'a repository URL must not become a script tag');
  assert.ok(html.includes('&lt;script&gt;'));
  // Excerpts come from command output and are escaped the same way.
  assert.ok(html.includes('a &lt; b &amp; c'));
});

test('report page: the verdict is rendered and no score appears in the visible text', () => {
  const html = renderReportPage(report(), 'example');
  assert.match(html, /partial/);
  const text = visibleText(html.replace(/<style>[\s\S]*?<\/style>/g, ' '));
  assert.ok(!/\bscore\b|\brating\b|\d+\s*\/\s*10|\d+\s*%/.test(text), `visible text implies a score: ${text.slice(0, 200)}`);
});

test('index page: every entry is listed with a link and an inline badge', () => {
  const index = {
    schema: 'dsh.plugin.catalog.v1',
    generatedAt: '2026-10-04T00:00:00.000Z',
    counts: { total: 1, byVerdict: { partial: 1 } },
    coverage: { note: 'a slice, not a census', curatedPoolTarget: 600 },
    entries: [
      {
        reportId: 'npm:example@1.0.0',
        name: 'example',
        version: '1.0.0',
        verdict: 'partial',
        path: 'catalog/npm/example.json',
        generatedAt: '2026-10-04T00:00:00.000Z',
        integrity: 'sha512-AAAA',
        dshVersion: '0.2.0-rc.2',
        dimensions: { L0: 'pass', L1: 'fail' },
        presentCapabilities: ['network_egress'],
        repoPath: 'example',
      },
    ],
  } as unknown as CatalogIndex;
  const html = renderIndexPage(index);
  assert.ok(html.includes('href="./example.html"'));
  assert.ok(html.includes('npm:example@1.0.0'));
  assert.ok(html.includes('<svg'), 'the badge is inlined so the page needs no image host');
  assert.ok(html.includes('a slice, not a census'));
});

test('report page: a reader who disagrees can find the appeal process', () => {
  // The page most likely to be disputed is the one that should say how.
  const html = renderReportPage(report(), 'example');
  assert.match(html, /dispute this report/);
  assert.match(html, /docs\/appeals\.md/);
});
