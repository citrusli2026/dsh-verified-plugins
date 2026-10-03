/**
 * staleness.ts — a report is a snapshot, and snapshots go out of date.
 *
 * Nothing in this project previously noticed that a verified subject had since
 * been republished. A report saying `verified` about `foo@1.2.3` is not wrong
 * when `foo@1.4.0` appears — but a reader who takes it for a statement about
 * "foo" is being misled by omission.
 *
 * The assessment lives in its own artefact (`catalog/staleness.json`) rather
 * than inside the reports or the index:
 *
 *   - a report is immutable evidence of what was run, so rewriting one to say
 *     "stale" would corrupt the record;
 *   - the index is derived from the reports alone and CI re-derives it offline.
 *     Folding a network check into it would make that check flaky and slow.
 *
 * Three states, because two would force a guess: `current`, `stale`, `unknown`.
 */

import { defaultRegistry } from './registry.ts';

export interface StalenessEntry {
  reportId: string;
  name: string;
  verifiedVersion: string;
  verifiedRuntime: string;
  /** What the registry publishes now, or null when it could not be read. */
  currentVersion: string | null;
  status: 'current' | 'stale' | 'unknown';
  reasons: string[];
}

export interface StalenessReport {
  schema: 'dsh.verifier.staleness.v1';
  generatedAt: string;
  registry: string;
  runtimeVersion: string | null;
  counts: { checked: number; current: number; stale: number; unknown: number };
  limits: string[];
  entries: StalenessEntry[];
}

/** One small request per package: the same endpoint the survey uses. */
export async function fetchLatestVersion(
  name: string,
  registry: string,
  timeoutMs = 20_000,
): Promise<{ version: string | null; error: string | null }> {
  try {
    const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2F')}/latest`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { version: null, error: 'no longer published' };
    if (!response.ok) return { version: null, error: `HTTP ${response.status}` };
    const manifest = (await response.json()) as Record<string, any>;
    return { version: typeof manifest.version === 'string' ? manifest.version : null, error: null };
  } catch (error) {
    const kind = (error as Error)?.name;
    return { version: null, error: kind === 'TimeoutError' ? 'timed out' : String(error).slice(0, 100) };
  }
}

export interface StalenessInput {
  reportId: string;
  name: string;
  version: string;
  runtimeVersion: string;
}

export interface AssessOptions {
  registry?: string;
  /** The runtime the project currently pins. Reports verified against another are stale. */
  runtimeVersion?: string | null;
  concurrency?: number;
  timeoutMs?: number;
  now?: Date;
}

export async function assessStaleness(
  reports: StalenessInput[],
  options: AssessOptions = {},
): Promise<StalenessReport> {
  const registry = options.registry ?? defaultRegistry();
  const runtime = options.runtimeVersion ?? null;
  const concurrency = options.concurrency ?? 8;

  const entries: StalenessEntry[] = new Array(reports.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= reports.length) return;
      const report = reports[index] as StalenessInput;
      const { version: current, error } = await fetchLatestVersion(report.name, registry, options.timeoutMs);
      const reasons: string[] = [];
      let status: StalenessEntry['status'];

      if (error !== null || current === null) {
        status = 'unknown';
        reasons.push(`the package could not be read (${error ?? 'no version published'}), so freshness cannot be confirmed`);
      } else {
        if (current !== report.version) {
          reasons.push(`a newer version is published: ${current}, while this report covers ${report.version}`);
        }
        if (runtime !== null && report.runtimeVersion !== runtime) {
          reasons.push(`verified against DSH ${report.runtimeVersion}, while this project now pins ${runtime}`);
        }
        status = reasons.length > 0 ? 'stale' : 'current';
      }

      entries[index] = {
        reportId: report.reportId,
        name: report.name,
        verifiedVersion: report.version,
        verifiedRuntime: report.runtimeVersion,
        currentVersion: current,
        status,
        reasons,
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(reports.length, 1)) }, worker));

  const counts = {
    checked: entries.length,
    current: entries.filter((e) => e.status === 'current').length,
    stale: entries.filter((e) => e.status === 'stale').length,
    unknown: entries.filter((e) => e.status === 'unknown').length,
  };

  return {
    schema: 'dsh.verifier.staleness.v1',
    generatedAt: (options.now ?? new Date()).toISOString(),
    registry,
    runtimeVersion: runtime,
    counts,
    limits: [
      'freshness is a property of the catalogue entry, not of the report: the report remains the record of what was run',
      'a stale report is not a wrong report — it describes a version that is no longer the latest, and its findings still hold for that version',
      'unknown means the registry could not be read, which is not the same as current',
    ],
    entries,
  };
}

export function stalenessFor(report: StalenessReport | null, reportId: string): StalenessEntry | null {
  if (!report) return null;
  return report.entries.find((entry) => entry.reportId === reportId) ?? null;
}
