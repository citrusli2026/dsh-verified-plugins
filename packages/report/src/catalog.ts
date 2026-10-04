/**
 * catalog.ts — the published product shape.
 *
 * `catalog/` holds one report per reported subject plus a generated
 * `index.json`. The index is *derived* and never hand-edited: a stale index is
 * a lie about coverage, so it is rebuilt and validated in the same step.
 *
 * Note on layout: the specification proposed `catalog/<owner>/<repo>.json`.
 * The subject here is an npm package, not a git repository — one repository can
 * publish several packages, and one package can be published from anywhere — so
 * the path is keyed by registry and package name instead. Reports carry the
 * repository URL when the package declares one, which is what a reader actually
 * wants to follow.
 */

export interface CatalogEntrySummary {
  reportId: string;
  name: string;
  version: string;
  verdict: string;
  path: string;
  generatedAt: string;
  integrity: string | null;
  dshVersion: string;
  dimensions: Record<string, string>;
  presentCapabilities: string[];
  repoPath: string;
}

export interface CatalogIndex {
  schema: 'dsh.plugin.catalog.v1';
  generatedAt: string;
  counts: {
    total: number;
    byVerdict: Record<string, number>;
  };
  /** Deliberately stated: coverage is a small slice, not the ecosystem. */
  coverage: {
    note: string;
    curatedPoolTarget: number;
  };
  entries: CatalogEntrySummary[];
}

export const INDEX_SCHEMA = 'dsh.plugin.catalog.v1';

export function summariseReport(path: string, report: Record<string, any>): CatalogEntrySummary {
  const dimensions = (report.dimensions ?? {}) as Record<string, { status?: string }>;
  const capabilities = (report.capabilities ?? []) as Array<{ id: string; present: boolean }>;

  return {
    reportId: String(report.reportId ?? ''),
    name: String(report.subject?.name ?? ''),
    version: String(report.subject?.version ?? ''),
    verdict: String(report.verdict ?? ''),
    path,
    generatedAt: String(report.generatedAt ?? ''),
    integrity: report.subject?.integrity ?? null,
    dshVersion: String(report.runtime?.dshVersion ?? ''),
    dimensions: Object.fromEntries(Object.entries(dimensions).map(([k, v]) => [k, String(v?.status ?? '')])),
    presentCapabilities: capabilities.filter((c) => c.present).map((c) => c.id).sort(),
    repoPath: String(report.subject?.name ?? '').replace(/^@/, '').replace(/\//g, '__'),
  };
}

export function buildCatalogIndex(
  summaries: CatalogEntrySummary[],
  options: { now?: Date; curatedPoolTarget?: number } = {},
): CatalogIndex {
  const byVerdict: Record<string, number> = {};
  for (const entry of summaries) {
    byVerdict[entry.verdict] = (byVerdict[entry.verdict] ?? 0) + 1;
  }

  return {
    schema: INDEX_SCHEMA,
    generatedAt: (options.now ?? new Date()).toISOString(),
    counts: { total: summaries.length, byVerdict },
    coverage: {
      note:
        'This catalogue is a verified slice, not a census. An unreported plugin is unreported, not suspicious, and no ranking is published.',
      curatedPoolTarget: options.curatedPoolTarget ?? 600,
    },
    entries: [...summaries].sort((a, b) => a.reportId.localeCompare(b.reportId)),
  };
}
