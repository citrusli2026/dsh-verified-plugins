/**
 * staleness.ts — a report is a snapshot, and snapshots go out of date.
 *
 * A report saying `verified` about `foo@1.2.3` is a snapshot. Check both the
 * latest tag and the registry integrity for that exact version; either can
 * change after publication. A registry integrity mismatch needs investigation
 * because the report records the bytes actually fetched at verification time.
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
  /** Registry integrity for the exact reported version, not for latest. */
  currentIntegrity: string | null;
  integrityStatus: 'match' | 'mismatch' | 'unknown';
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

/** Read a registry manifest without executing the package. */
async function fetchManifest(
  name: string,
  version: string,
  registry: string,
  timeoutMs = 20_000,
): Promise<{ manifest: Record<string, unknown> | null; error: string | null }> {
  try {
    const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { manifest: null, error: 'no longer published' };
    if (!response.ok) return { manifest: null, error: `HTTP ${response.status}` };
    const manifest = (await response.json()) as unknown;
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { manifest: null, error: 'invalid registry manifest' };
    }
    return { manifest: manifest as Record<string, unknown>, error: null };
  } catch (error) {
    const kind = (error as Error)?.name;
    return { manifest: null, error: kind === 'TimeoutError' ? 'timed out' : String(error).slice(0, 100) };
  }
}

export async function fetchLatestVersion(name: string, registry: string, timeoutMs = 20_000) {
  const { manifest, error } = await fetchManifest(name, 'latest', registry, timeoutMs);
  return { version: typeof manifest?.version === 'string' ? manifest.version : null, error };
}

export interface StalenessInput {
  reportId: string;
  name: string;
  version: string;
  runtimeVersion: string;
  integrity: string | null;
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
      const [{ version: current, error }, exact] = await Promise.all([
        fetchLatestVersion(report.name, registry, options.timeoutMs),
        fetchManifest(report.name, report.version, registry, options.timeoutMs),
      ]);
      const dist = exact.manifest?.dist;
      const currentIntegrity = dist && typeof dist === 'object' && !Array.isArray(dist) &&
        typeof (dist as Record<string, unknown>).integrity === 'string'
        ? (dist as Record<string, string>).integrity : null;
      const integrityStatus = !report.integrity || !currentIntegrity
        ? 'unknown'
        : report.integrity === currentIntegrity ? 'match' : 'mismatch';
      const reasons: string[] = [];
      let status: StalenessEntry['status'];

      if (error !== null || current === null) {
        reasons.push(`the latest version could not be read (${error ?? 'no version published'})`);
      } else {
        if (current !== report.version) {
          reasons.push(`the latest tag points at ${current}, while this report covers ${report.version}`);
        }
      }
      if (runtime !== null && report.runtimeVersion !== runtime) {
        reasons.push(`verified against DSH ${report.runtimeVersion}, while this project now pins ${runtime}`);
      }
      if (integrityStatus === 'mismatch') {
        reasons.push(`the registry integrity for ${report.name}@${report.version} differs from the artifact recorded in the report`);
      } else if (integrityStatus === 'unknown') {
        reasons.push(`the exact-version integrity could not be compared (${exact.error ?? 'integrity missing'}); freshness cannot be confirmed`);
      }
      const versionChanged = current !== null && current !== report.version;
      const runtimeChanged = runtime !== null && report.runtimeVersion !== runtime;
      status = versionChanged || runtimeChanged || integrityStatus === 'mismatch'
        ? 'stale'
        : error !== null || current === null || integrityStatus === 'unknown'
          ? 'unknown'
          : 'current';

      entries[index] = {
        reportId: report.reportId,
        name: report.name,
        verifiedVersion: report.version,
        verifiedRuntime: report.runtimeVersion,
        currentVersion: current,
        currentIntegrity,
        integrityStatus,
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
      'a stale report is not automatically wrong: it may describe a version that is no longer latest, a different runtime, or a changed registry integrity',
      'unknown means the registry or exact-version integrity could not be checked, which is not the same as current',
      'the exact reported version is checked against the registry integrity; a mismatch can also mean the registry metadata changed, so it requires investigation',
    ],
    entries,
  };
}

export function stalenessFor(report: StalenessReport | null, reportId: string): StalenessEntry | null {
  if (!report) return null;
  return report.entries.find((entry) => entry.reportId === reportId) ?? null;
}
