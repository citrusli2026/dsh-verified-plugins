/**
 * site.ts — the static publish surface.
 *
 * Renders `catalog/` into a set of plain HTML pages with no framework, no
 * client-side JavaScript and no build step. Two properties matter more than
 * looks:
 *
 *   1. **Every conclusion links to the evidence it rests on.** A dimension
 *      status that does not lead to an artifact is the thing this project
 *      exists to avoid, so each row anchors to the evidence entries it cites.
 *   2. **Everything is escaped.** Report content derives from third-party
 *      package metadata and from command output; none of it is trusted markup.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderBadge, BADGE_VOCABULARY, escapeXml } from './badge.ts';
import type { CatalogIndex } from './catalog.ts';

/** Freshness is read from its own artifact; a report itself is never rewritten. */
export interface StalenessView {
  entries: Array<{ reportId: string; status: 'current' | 'stale' | 'unknown'; reasons: string[]; currentVersion: string | null }>;
}

function staleFor(view: StalenessView | null | undefined, reportId: string) {
  return view?.entries.find((entry) => entry.reportId === reportId) ?? null;
}

export function escapeHtml(value: unknown): string {
  return escapeXml(String(value ?? ''));
}

export function slugFor(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '__');
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 60rem; padding: 1.5rem 1rem 4rem;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; text-transform: uppercase;
  letter-spacing: .06em; opacity: .65; }
a { color: inherit; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid rgba(128,128,128,.25);
  vertical-align: top; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
pre { background: rgba(128,128,128,.12); padding: .6rem .75rem; border-radius: 4px; overflow-x: auto; }
.status { font-weight: 600; }
.status-pass { color: #1f883d; } .status-fail { color: #cf222e; }
.status-skip, .status-blocked { color: #6e7781; }
.status-inconclusive, .status-timeout { color: #bf8700; }
.muted { opacity: .65; }
.note { font-size: .9em; opacity: .8; margin: .2rem 0 0; }
.tag { display: inline-block; border: 1px solid rgba(128,128,128,.45); border-radius: 3px;
  padding: 0 .35rem; font-size: .8em; margin-right: .25rem; }
`.trim();

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${body}
</html>
`;
}

function verdictBadge(verdict: string, subject: string, href: string): string {
  const svg = renderBadge(verdict, { subject });
  // Inline the SVG so the page needs no extra request and no image hosting.
  return `<a href="${escapeHtml(href)}" title="dsh-verified: ${escapeHtml(verdict)}">${svg}</a>`;
}

export function renderIndexPage(index: CatalogIndex, staleness?: StalenessView | null): string {
  const rows = index.entries
    .map((entry) => {
      const dims = Object.entries(entry.dimensions)
        .map(([key, status]) => `<span title="${escapeHtml(key)}" class="status status-${escapeHtml(status)}">${escapeHtml(key.slice(0, 2))}</span>`)
        .join(' ');
      const freshness = staleFor(staleness, entry.reportId);
      const freshnessCell =
        freshness === null
          ? '<span class="muted">—</span>'
          : freshness.status === 'current'
            ? '<span class="status status-pass">current</span>'
            : freshness.status === 'stale'
              ? `<span class="status status-inconclusive" title="${escapeHtml(freshness.reasons.join(' '))}">stale</span>`
              : '<span class="muted" title="the registry could not be read">unknown</span>';

      return `<tr>
  <td><a href="./${escapeHtml(entry.repoPath)}.html">${escapeHtml(entry.reportId)}</a></td>
  <td>${verdictBadge(entry.verdict, entry.reportId, `./${escapeHtml(entry.repoPath)}.html`)}</td>
  <td class="muted">${escapeHtml(entry.dshVersion)}</td>
  <td>${freshnessCell}</td>
  <td>${dims}</td>
</tr>`;
    })
    .join('\n');

  const counts = Object.entries(index.counts.byVerdict)
    .map(([verdict, count]) => `${count} × ${escapeHtml(verdict)}`)
    .join(', ');

  return page(
    'dsh-verified-plugins',
    `<h1>dsh-verified-plugins</h1>
<p class="muted">Execution-verified reports for DeepSeek Harness plugins. Every conclusion links to the artifact it rests on.</p>
<p><strong>${escapeHtml(String(index.counts.total))} reports</strong> — ${counts}</p>
<p class="note">${escapeHtml(index.coverage.note)}</p>
<p class="note">A <strong>stale</strong> report is not a wrong report: it describes a version that is no longer the latest, and its findings still hold for that version. See <a href="./staleness.json">staleness.json</a>.</p>

<h2>Reports</h2>
<table>
<thead><tr><th>subject</th><th>verdict</th><th>DSH</th><th>freshness</th><th>L0 L1 L2 L3 L4 L5 L6</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>

<h2>Badges</h2>
<p class="muted">Vocabulary: ${BADGE_VOCABULARY.map((v) => `<code>${escapeHtml(v)}</code>`).join(' · ')}. There is no score and no ranking.</p>
<pre>&lt;img src="badge/&lt;subject&gt;.svg" alt="dsh verified"&gt;</pre>

<h2>Reproduce any report</h2>
<pre>node packages/cli/src/main.ts static &lt;name&gt;@&lt;version&gt;</pre>
<p class="note">Also: <a href="./index.json">index.json</a> · <a href="./survey/">the subject survey</a>. Generated ${escapeHtml(index.generatedAt)}.</p>`,
  );
}

export function renderReportPage(
  report: Record<string, any>,
  slug: string,
  staleness?: StalenessView | null,
): string {
  const freshness = staleFor(staleness, String(report.reportId ?? ''));
  const freshnessBanner =
    freshness && freshness.status !== 'current'
      ? `<p><strong>${escapeHtml(freshness.status === 'stale' ? 'Stale' : 'Freshness unknown')}.</strong> ${escapeHtml(freshness.reasons.join(' '))}</p>`
      : '';
  const dims = report.dimensions as Record<string, any>;
  const evidence = (report.evidence ?? []) as Array<Record<string, any>>;

  const dimensionRows = Object.entries(dims)
    .map(([key, dimension]) => {
      const refs = (dimension.evidenceRefs ?? []) as string[];
      const links = refs.length
        ? refs.map((ref) => `<a href="#e-${escapeHtml(ref)}"><code>${escapeHtml(ref)}</code></a>`).join(', ')
        : '<span class="muted">no evidence cited</span>';
      const notes = (dimension.notes ?? []) as string[];
      return `<tr>
  <td><code>${escapeHtml(dimension.id ?? key.slice(0, 2))}</code></td>
  <td class="status status-${escapeHtml(dimension.status)}">${escapeHtml(dimension.status)}</td>
  <td>${escapeHtml(dimension.summary)}
    ${notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('')}
    ${dimension.metrics ? `<details><summary class="muted">metrics</summary><pre>${escapeHtml(JSON.stringify(dimension.metrics, null, 2))}</pre></details>` : ''}
  </td>
  <td>${links}</td>
</tr>`;
    })
    .join('\n');

  const evidenceRows = evidence
    .map(
      (entry) => `<tr id="e-${escapeHtml(entry.id)}">
  <td><code>${escapeHtml(entry.id)}</code></td>
  <td>${escapeHtml(entry.kind)}${entry.exitCode !== undefined ? ` <span class="muted">exit ${escapeHtml(entry.exitCode)}</span>` : ''}${
    entry.durationMs !== undefined ? ` <span class="muted">${escapeHtml(entry.durationMs)} ms</span>` : ''
  }</td>
  <td>${entry.command ? `<code>${escapeHtml(entry.command)}</code>` : ''}
    ${entry.excerpt ? `<pre>${escapeHtml(entry.excerpt)}</pre>` : ''}
    ${entry.truncated ? '<p class="note">excerpt truncated at 2048 bytes</p>' : ''}
  </td>
</tr>`,
    )
    .join('\n');

  const capabilities = ((report.capabilities ?? []) as Array<Record<string, any>>).filter((c) => c.present);
  const capabilityBlock = capabilities.length
    ? `<table><thead><tr><th>capability</th><th>confidence</th><th>attribution</th><th>first evidence</th></tr></thead><tbody>
${capabilities
  .map((c) => {
    const first = (c.evidence ?? [])[0];
    return `<tr><td><code>${escapeHtml(c.id)}</code></td><td>${escapeHtml(c.confidence)}</td><td>${escapeHtml(c.attribution ?? 'unknown')}</td><td>${
      first ? `<code>${escapeHtml(first.file)}:${escapeHtml(first.line)}</code>` : ''
    }</td></tr>`;
  })
  .join('\n')}
</tbody></table>`
    : '<p class="muted">No capability signature was found in the shipped files.</p>';

  const measured = report.overhead as Record<string, any> | undefined;
  const overhead = measured
    ? `<pre>${escapeHtml(
        JSON.stringify(
          {
            status: measured.status,
            samples: measured.samples,
            baseline: measured.baseline,
            activated: measured.activated,
            delta: measured.delta,
            significant: measured.significant,
          },
          null,
          2,
        ),
      )}</pre>`
    : '<p class="muted">No overhead measurement was published for this report.</p>';

  const subject = report.subject ?? {};
  const limits = (report.limits ?? []) as string[];
  const disclaimers = (report.disclaimers ?? []) as string[];

  return page(
    report.reportId,
    `<p><a href="./index.html">← all reports</a></p>
<h1>${escapeHtml(report.reportId)}</h1>
<p>${verdictBadge(report.verdict, report.reportId, '#top')}</p>
${freshnessBanner}
<p class="muted">${escapeHtml(subject.integrity ?? '')}</p>

<h2>Subject</h2>
<table>
<tr><th>name</th><td><code>${escapeHtml(subject.name)}</code></td></tr>
<tr><th>version</th><td><code>${escapeHtml(subject.version)}</code></td></tr>
<tr><th>integrity</th><td><code>${escapeHtml(subject.integrity ?? 'not recorded')}</code></td></tr>
<tr><th>repository</th><td>${subject.repository ? `<a href="${escapeHtml(subject.repository)}">${escapeHtml(subject.repository)}</a>` : '<span class="muted">not declared</span>'}</td></tr>
<tr><th>declared bundle patch</th><td><code>${escapeHtml(JSON.stringify(subject.dshBundlePatch ?? null))}</code></td></tr>
<tr><th>declared engines.dsh</th><td><code>${escapeHtml(subject.declaredEnginesDsh ?? 'not declared')}</code> <span class="muted">— declarative and unenforced</span></td></tr>
</table>

<h2>Environment</h2>
<table>
<tr><th>DSH</th><td><code>${escapeHtml(report.runtime?.dshVersion)}</code></td></tr>
<tr><th>Node</th><td><code>${escapeHtml(report.runtime?.nodeVersion)}</code></td></tr>
<tr><th>OS / arch</th><td><code>${escapeHtml(`${report.runtime?.os ?? ''} ${report.runtime?.arch ?? ''}`.trim())}</code></td></tr>
<tr><th>verifier</th><td><code>${escapeHtml(report.verifier?.name)} ${escapeHtml(report.verifier?.version)}</code>${report.verifier?.commit ? ` <code>${escapeHtml(String(report.verifier.commit).slice(0, 12))}</code>` : ''}</td></tr>
<tr><th>generated</th><td><code>${escapeHtml(report.generatedAt)}</code></td></tr>
</table>

<h2>Dimensions</h2>
<table>
<thead><tr><th></th><th>status</th><th>summary</th><th>evidence</th></tr></thead>
<tbody>
${dimensionRows}
</tbody>
</table>

<h2>Capability (L4, static)</h2>
${capabilityBlock}
<p class="note">Capability is not intent. A signature records what the code can reach for, not what it does.</p>

<h2>Overhead (L5, dynamic)</h2>
${overhead}

<h2>Evidence</h2>
<table>
<thead><tr><th>id</th><th>kind</th><th>artifact</th></tr></thead>
<tbody>
${evidenceRows}
</tbody>
</table>

<h2>Limits</h2>
<ul>${limits.map((l) => `<li>${escapeHtml(l)}</li>`).join('') || '<li class="muted">none recorded</li>'}</ul>

<h2>Disclaimers</h2>
<ul>${disclaimers.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>

<p class="note"><a href="./${escapeHtml(slug)}.json">raw report JSON</a> · <a href="./badge/${escapeHtml(slug)}.svg">badge</a></p>`,
  );
}

export function renderSurveyPage(summary: Record<string, any>): string {
  const c = summary.counts ?? {};
  const rows = ((summary.rows ?? []) as Array<Record<string, any>>)
    .map((row) => {
      const verdict = row.peerVerdict
        ? row.peerVerdict.compatible
          ? '<span class="status status-pass">peer-compatible</span>'
          : '<span class="status status-fail">would be refused</span>'
        : '<span class="muted">not evaluated</span>';
      const detail = row.peerVerdict && !row.peerVerdict.compatible && row.peerVerdict.unsatisfied?.length
        ? `<p class="note">${row.peerVerdict.unsatisfied
            .slice(0, 2)
            .map((u: Record<string, string>) => `${escapeHtml(u.name)} wants <code>${escapeHtml(u.range)}</code>`)
            .join('; ')}</p>`
        : '';
      return `<tr>
  <td><code>${escapeHtml(row.name)}</code></td>
  <td><code>${escapeHtml(row.version ?? '')}</code></td>
  <td>${row.declaresBundle ? '<span class="status status-pass">declares a bundle</span>' : '<span class="muted">no bundle</span>'}${detail}</td>
  <td>${verdict}</td>
</tr>`;
    })
    .join('\n');

  return page(
    'dsh-plugin subject survey',
    `<p><a href="./index.html">← all reports</a></p>
<h1>Survey: how many "DSH plugins" are installable?</h1>
<p class="muted">Registry metadata only. No container, no plugin execution, no credential.</p>
<table>
<tr><th>scanned</th><td>${escapeHtml(c.scanned)}</td></tr>
<tr><th>declares an installable bundle</th><td>${escapeHtml(c.declaresBundle)}</td></tr>
<tr><th>peer-compatible with ${escapeHtml(summary.runtimeVersion ?? '—')}</th><td>${escapeHtml(c.peerCompatible)}</td></tr>
<tr><th>would be refused at install</th><td>${escapeHtml(c.peerIncompatible)}</td></tr>
</table>
<p><strong>Declaring a bundle is not being installable.</strong></p>
<h2>Subjects</h2>
<table><thead><tr><th>package</th><th>version</th><th>bundle</th><th>peers</th></tr></thead><tbody>
${rows}
</tbody></table>
<h2>Limits</h2>
<ul>${((summary.limits ?? []) as string[]).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
  );
}

export interface SiteInput {
  index: CatalogIndex;
  reports: Array<{ slug: string; report: Record<string, any> }>;
  staleness?: StalenessView | null;
}

export interface SiteBuild {
  outDir: string;
  pages: number;
  badges: number;
}

export interface SiteOptions {
  outDir: string;
  surveyDir?: string;
  now?: Date;
}

/** Writes the whole site. No framework, no client JavaScript, no network. */
export function buildSite(input: SiteInput, options: SiteOptions): SiteBuild {
  const out = options.outDir;
  mkdirSync(join(out, 'badge'), { recursive: true });

  writeFileSync(join(out, 'index.html'), renderIndexPage(input.index, input.staleness));
  if (input.staleness) {
    writeFileSync(join(out, 'staleness.json'), `${JSON.stringify(input.staleness, null, 2)}\n`);
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(input.index, null, 2)}\n`);

  let badges = 0;
  for (const { slug, report } of input.reports) {
    writeFileSync(join(out, `${slug}.html`), renderReportPage(report, slug, input.staleness));
    writeFileSync(join(out, `${slug}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
      join(out, 'badge', `${slug}.svg`),
      renderBadge(report.verdict, { subject: report.reportId }),
    );
    badges += 1;
  }

  if (options.surveyDir) {
    // The survey page is rendered by the CLI, which owns the HTML for it.
    void options.surveyDir;
  }

  return { outDir: out, pages: input.reports.length + 1, badges };
}
