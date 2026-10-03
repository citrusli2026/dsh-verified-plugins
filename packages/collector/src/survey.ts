/**
 * survey.ts — the L0 pre-filter applied at scale, without a container.
 *
 * The specification asks for a by-product of the batch work: publish how many
 * of the packages that claim to be DSH plugins actually are installable
 * bundles. Declaring `dsh.bundle.patch` is what makes a package composable, and
 * that is readable from the registry, so the figure costs metadata and no
 * execution at all.
 *
 * Two things this deliberately does NOT do:
 *   - it does not download tarballs, so it cannot confirm that the declared
 *     patch files exist. That needs L0 proper and is stated as a limit;
 *   - it does not use npm's abbreviated metadata format, which strips the
 *     custom `dsh` field entirely and would report every package as not a
 *     plugin. That trap cost this project a wrong survey once already.
 */

import { defaultRegistry } from './registry.ts';
import { evaluateDshPeers, type PeerVerdict } from './semver.ts';

export interface SurveyRow {
  name: string;
  /** The `latest` dist-tag version, or null when it could not be read. */
  version: string | null;
  declaresBundle: boolean;
  bundlePatch: string[] | null;
  clientPlatform: string | null;
  enginesDsh: string | null;
  dshPeers: Record<string, string> | null;
  /** Evaluated against the runtime the survey was run for; null when not asked. */
  peerVerdict: PeerVerdict | null;
  reachable: boolean;
  error: string | null;
}

export interface SurveySummary {
  schema: 'dsh.verifier.survey.v1';
  generatedAt: string;
  source: { kind: 'search' | 'list'; query: string | null; requested: number };
  registry: string;
  runtimeVersion: string | null;
  counts: {
    scanned: number;
    reachable: number;
    unreachable: number;
    declaresBundle: number;
    declaresClientOnly: number;
    declaresNoBundle: number;
    /** Of those declaring a bundle: peers satisfied by the runtime. */
    peerCompatible: number;
    peerIncompatible: number;
    /** Of those: peer-compatible AND no dsh peers declared at all. */
    installableNow: number;
  };
  limits: string[];
  rows: SurveyRow[];
}

/** Names from the registry's search API, paged. */
export async function searchPackageNames(
  query: string,
  limit: number,
  registry = defaultRegistry(),
): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<string>();
  const pageSize = Math.min(250, limit);

  for (let from = 0; from < limit; from += pageSize) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${pageSize}&from=${from}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`search returned HTTP ${response.status}`);
    const body = (await response.json()) as { objects?: Array<{ package?: { name?: string } }> };
    const page = body.objects ?? [];
    if (page.length === 0) break;
    for (const entry of page) {
      const name = entry.package?.name;
      if (typeof name === 'string' && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    if (names.length >= limit) break;
  }

  void registry;
  return names.slice(0, limit);
}

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Build a row from one version's manifest. Pure, so the parsing is
 * unit-testable without the network.
 *
 * Note what this must NOT be fed: npm's abbreviated metadata
 * (`application/vnd.npm.install-v1+json`) strips the custom `dsh` field, so
 * every package would come out as "declares no bundle". That trap produced a
 * wrong survey in this project once already. The per-version
 * `/{name}/latest` manifest is the cheap endpoint that keeps the field: 3.7 KB
 * where the full packument was 85 KB for one subject, and the gap grows with
 * the number of published versions.
 */
export function rowFromManifest(name: string, manifest: Record<string, any>): SurveyRow {
  const base: SurveyRow = {
    name,
    version: null,
    declaresBundle: false,
    bundlePatch: null,
    clientPlatform: null,
    enginesDsh: null,
    dshPeers: null,
    peerVerdict: null,
    reachable: false,
    error: null,
  };

  const version = manifest?.version;
  if (typeof version !== 'string') return { ...base, error: 'manifest carries no version' };

  const dsh = (manifest.dsh ?? {}) as Record<string, any>;
  const rawPatch = dsh.bundle?.patch;

  let bundlePatch: string[] | null = null;
  if (typeof rawPatch === 'string') bundlePatch = [rawPatch];
  else if (Array.isArray(rawPatch)) bundlePatch = rawPatch.filter((p: unknown): p is string => typeof p === 'string');

  const peers = Object.fromEntries(
    Object.entries((manifest.peerDependencies ?? {}) as Record<string, string>).filter(
      ([k]) => k === '@deepseek-ai/dsh' || k.startsWith('@deepseek-ai/dsh-'),
    ),
  );

  return {
    ...base,
    version,
    declaresBundle: (bundlePatch?.length ?? 0) > 0,
    bundlePatch,
    clientPlatform: typeof dsh.client?.platform === 'string' ? dsh.client.platform : null,
    enginesDsh: typeof manifest.engines?.dsh === 'string' ? manifest.engines.dsh : null,
    dshPeers: Object.keys(peers).length > 0 ? peers : null,
    peerVerdict: null,
    reachable: true,
  };
}

/** Full packument per package. Abbreviated metadata would hide `dsh`. */
async function readRow(name: string, registry: string, timeoutMs: number): Promise<SurveyRow> {
  const base: SurveyRow = {
    name,
    version: null,
    declaresBundle: false,
    bundlePatch: null,
    clientPlatform: null,
    enginesDsh: null,
    dshPeers: null,
    reachable: false,
    error: null,
  };

  try {
    const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2F')}/latest`;
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) return { ...base, error: 'not found' };
    if (!response.ok) return { ...base, error: `HTTP ${response.status}` };

    const manifest = (await response.json()) as Record<string, any>;
    return rowFromManifest(name, manifest);
  } catch (error) {
    const name_ = (error as Error)?.name;
    return { ...base, error: name_ === 'TimeoutError' ? 'timed out' : String(error).slice(0, 120) };
  }
}

export async function survey(
  names: string[],
  options: {
    registry?: string;
    concurrency?: number;
    timeoutMs?: number;
    query?: string | null;
    runtimeVersion?: string | null;
    now?: Date;
  } = {},
): Promise<SurveySummary> {
  const registry = options.registry ?? defaultRegistry();
  const runtimeVersion = options.runtimeVersion ?? null;

  const rows = await mapWithLimit(names, options.concurrency ?? 8, async (name) => {
    const row = await readRow(name, registry, options.timeoutMs ?? 20_000);
    if (!runtimeVersion || !row.reachable) return row;
    return { ...row, peerVerdict: evaluateDshPeers(row.dshPeers, runtimeVersion) };
  });

  const reachable = rows.filter((r) => r.reachable).length;
  const bundling = rows.filter((r) => r.declaresBundle);
  const declaresBundle = bundling.length;
  const declaresClientOnly = bundling.filter((r) => r.clientPlatform !== null).length;
  const peerCompatible = bundling.filter((r) => r.peerVerdict?.compatible === true).length;
  const peerIncompatible = bundling.filter((r) => r.peerVerdict && !r.peerVerdict.compatible).length;
  const installableNow = bundling.filter((r) => r.peerVerdict?.compatible === true).length;

  return {
    schema: 'dsh.verifier.survey.v1',
    generatedAt: (options.now ?? new Date()).toISOString(),
    source: { kind: options.query ? 'search' : 'list', query: options.query ?? null, requested: names.length },
    registry,
    runtimeVersion,
    counts: {
      scanned: rows.length,
      reachable,
      unreachable: rows.length - reachable,
      declaresBundle,
      declaresClientOnly,
      declaresNoBundle: reachable - declaresBundle,
      peerCompatible,
      peerIncompatible,
      installableNow,
    },
    limits: [
      'this reads registry metadata only: it confirms that a package DECLARES dsh.bundle.patch, not that the declared patch files exist in the published tarball',
      'a package with no declared bundle may still be a legitimate DSH plugin shipped as a plain loader entry; the figure is about the bundle declaration, which is what makes a package composable',
      'the search API ranks by its own relevance, not by popularity or quality, and the sample is the first page rather than the whole ecosystem',
      ...(runtimeVersion
        ? [
            `peer verdicts are evaluated against DSH ${runtimeVersion} using this repository's own SemVer evaluator, which reproduces the install decisions DSH made on the verified subjects; a range outside its supported grammar is reported as unsupported rather than assumed compatible`,
          ]
        : []),
    ],
    rows,
  };
}
