/**
 * static-report.ts — assemble a dsh.plugin.report.v1 from L0 + L4.
 *
 * This is the "fetch phase" end to end: it resolves an exact artifact, reads
 * it, and reports what it declares and what it can reach for. It runs **no**
 * plugin code, which is why it can execute in an ordinary process rather than
 * the verification container — and why its verdict is never better than
 * `partial`: nothing was installed, loaded or run.
 *
 * L1-L3, L5 and L6 are reported as `skip`, not omitted. A dimension that did
 * not execute must be visible as not having executed.
 */

import { createHash } from 'node:crypto';
import { arch, platform } from 'node:os';

import { analyseBundlePatch, type BundlePatchAnalysis } from './bundle-patch.ts';
import { scanCapabilities, type CapabilityScanResult } from './capability.ts';
import { qualify, type QualificationResult } from './qualify.ts';
import { fetchTarball, resolveSubject, BudgetExceededError, DEFAULT_FETCH_BUDGET, type FetchBudget, type ResolvedSubject } from './registry.ts';
import { findRootManifest, readTarGz, type TarEntry } from './tar.ts';
import { deriveVerdict, DISCLAIMER, type Dimension, type EvidenceEntry } from '../../report/src/validate.ts';
import { makeExcerpt } from '../../report/src/redact.ts';

export const VERIFIER_NAME = 'dsh-verified';
export const VERIFIER_VERSION = '0.1.0';

/** Value used when no DSH runtime was executed. Never guess a version. */
export const NOT_EXECUTED = 'not-executed';

export interface StaticReportOptions {
  registry?: string;
  /** Paths rewritten out of excerpts, e.g. the runner's home directory. */
  redactPaths?: Array<{ from: string; to: string }>;
  fetchBudget?: FetchBudget;
  now?: Date;
}

export interface StaticReportResult {
  report: Record<string, unknown>;
  subject: ResolvedSubject;
  qualification: QualificationResult | null;
  capabilities: CapabilityScanResult | null;
  bundlePatch: BundlePatchAnalysis | null;
  entries: TarEntry[];
  /** Set when a hard ceiling stopped the run; the verdict is then inconclusive. */
  budgetExceeded: { budget: string; detail: string } | null;
}

function skipped(id: string, reason: string): Dimension {
  return {
    id,
    status: 'skip',
    summary: reason,
    evidenceRefs: [],
    notes: ['skipped by design in a static-only run; requires the verification container'],
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * A report for the case where a hard ceiling stopped the run before anything
 * could be read. The verdict is `inconclusive` by construction: nothing was
 * established, and saying so is the whole point.
 */
function buildBudgetReport(
  subject: ResolvedSubject,
  error: BudgetExceededError,
  evidence: EvidenceEntry[],
  options: StaticReportOptions,
  budget: FetchBudget,
): Record<string, unknown> {
  evidence.push({
    id: 'e-budget',
    kind: 'log',
    command: `fetch ${subject.tarball}`,
    exitCode: 1,
    excerpt: makeExcerpt(
      JSON.stringify(
        {
          effectiveBudget: budget,
          exceeded: error.budget,
          detail: error.detail,
        },
        null,
        2,
      ),
      { paths: options.redactPaths ?? [] },
    ).text,
  });

  const dimensions: Record<string, Dimension> = {
    L0_qualification: {
      id: 'L0',
      status: 'timeout',
      summary: `the artifact could not be read: ${error.budget} ceiling exceeded (${error.detail})`,
      evidenceRefs: ['e-resolve', 'e-budget'],
      notes: ['a hard resource ceiling stopped the run; this is not a failure verdict (docs/security.md § S4)'],
    },
    L1_install: skipped('L1', 'not run: the artifact could not be fetched'),
    L2_load: skipped('L2', 'not run: the artifact could not be fetched'),
    L3_run: skipped('L3', 'not run: the artifact could not be fetched'),
    L4_capability: skipped('L4', 'not run: the artifact could not be fetched'),
    L5_overhead: skipped('L5', 'not run: the artifact could not be fetched'),
    L6_uninstall: skipped('L6', 'not run: the artifact could not be fetched'),
  };

  return {
    schema: 'dsh.plugin.report.v1',
    reportId: `npm:${subject.name}@${subject.version}`,
    generatedAt: (options.now ?? new Date()).toISOString(),
    verifier: {
      name: VERIFIER_NAME,
      version: VERIFIER_VERSION,
      ...(process.env.DSH_VERIFY_COMMIT ? { commit: process.env.DSH_VERIFY_COMMIT } : {}),
    },
    subject: {
      spec: subject.spec,
      name: subject.name,
      version: subject.version,
      registry: subject.registry,
      ...(subject.tarball ? { tarball: subject.tarball } : {}),
      ...(subject.integrity ? { integrity: subject.integrity } : {}),
    },
    runtime: {
      dshVersion: NOT_EXECUTED,
      nodeVersion: process.version,
      os: platform(),
      arch: arch(),
    },
    container: {
      image: 'none',
      imageDigest: null,
      notes: 'static-only run in the host process; no container was used',
    },
    verdict: deriveVerdict(dimensions as Record<keyof typeof dimensions, Dimension>),
    dimensions,
    capabilities: [],
    evidence,
    redactions: [],
    disclaimers: [DISCLAIMER],
    limits: [
      'a resource ceiling was hit before the artifact could be inspected; re-run with a larger budget to obtain findings',
    ],
  };
}

export async function buildStaticReport(spec: string, options: StaticReportOptions = {}): Promise<StaticReportResult> {
  const evidence: EvidenceEntry[] = [];
  const redactOptions = { paths: options.redactPaths ?? [] };

  // --- resolve -------------------------------------------------------------
  const resolveStart = Date.now();
  const subject = await resolveSubject(spec, options.registry);
  const resolveMs = Date.now() - resolveStart;
  evidence.push({
    id: 'e-resolve',
    kind: 'command',
    command: `resolve ${spec} -> ${subject.name}@${subject.version}`,
    exitCode: 0,
    durationMs: resolveMs,
    excerpt: makeExcerpt(
      JSON.stringify(
        {
          name: subject.name,
          version: subject.version,
          registry: subject.registry,
          tarball: subject.tarball,
          advertisedIntegrity: subject.integrity,
          publishedAt: subject.publishedAt,
        },
        null,
        2,
      ),
      redactOptions,
    ).text,
  });

  // --- fetch ---------------------------------------------------------------
  // Fetch runs under a hard ceiling (docs/security.md § S4), enforced while
  // streaming rather than trusted from Content-Length. Exceeding it is a
  // `timeout` conclusion, not a failure verdict: a plugin that is merely large
  // is not a broken plugin. Observed in practice — a 62 MB artifact took 174 s
  // at 358 KB/s from this network, which would have stalled the run forever
  // without a budget.
  const fetchStart = Date.now();
  // The effective budget is recorded in evidence either way, so a timeout
  // report is reproducible rather than dependent on an undocumented default.
  const budget = options.fetchBudget ?? DEFAULT_FETCH_BUDGET;
  let fetchedTarball: Awaited<ReturnType<typeof fetchTarball>>;
  try {
    fetchedTarball = await fetchTarball(subject, budget);
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    return {
      report: buildBudgetReport(subject, error, evidence, options, budget),
      subject,
      qualification: null,
      capabilities: null,
      bundlePatch: null,
      entries: [],
      budgetExceeded: { budget: error.budget, detail: error.detail },
    };
  }
  const { bytes, integrity, verified } = fetchedTarball;
  const fetchMs = Date.now() - fetchStart;

  const fetched = makeExcerpt(
    JSON.stringify(
      {
        bytes: bytes.byteLength,
        resolvedIntegrity: integrity,
        advertisedIntegrity: subject.integrity,
        integrityMatchesRegistry: verified,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      null,
      2,
    ),
    redactOptions,
  );
  evidence.push({
    id: 'e-tarball',
    kind: 'artifact',
    command: `fetch ${subject.tarball}`,
    exitCode: 0,
    durationMs: fetchMs,
    excerpt: fetched.text,
    excerptBytes: fetched.bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });

  const entries = readTarGz(bytes);
  const manifest = findRootManifest(entries);
  if (!manifest) throw new Error('published tarball contains no parseable root package.json');

  // --- L0 qualification ----------------------------------------------------
  const qualification = qualify(entries, manifest.json as Record<string, any>, manifest.path);
  const l0Excerpt = makeExcerpt(
    JSON.stringify(
      {
        status: qualification.status,
        reasons: qualification.reasons,
        declared: qualification.declared,
        missingPatchPaths: qualification.missingPatchPaths,
        fileCount: qualification.fileCount,
        unpackedBytes: qualification.unpackedBytes,
        shipsSource: qualification.shipsSource,
      },
      null,
      2,
    ),
    redactOptions,
  );
  evidence.push({
    id: 'e-l0',
    kind: 'static',
    command: 'read published package.json and verify declared dsh.bundle.patch paths exist',
    excerpt: l0Excerpt.text,
    excerptBytes: l0Excerpt.bytes,
  });

  // --- bundle patch --------------------------------------------------------
  let bundlePatch: BundlePatchAnalysis | null = null;
  const patchPath = qualification.patchPaths[0];
  if (patchPath) {
    const normalised = patchPath.replace(/^\.\//, '');
    const dir = manifest.path.includes('/') ? `${manifest.path.split('/').slice(0, -1).join('/')}/` : '';
    const entry = entries.find((e) => e.path === `${dir}${normalised}` || e.path.endsWith(`/${normalised}`));
    if (entry) {
      bundlePatch = analyseBundlePatch(normalised, entry.content.toString('utf8'));
      evidence.push({
        id: 'e-patch',
        kind: 'static',
        command: `read ${normalised}`,
        excerpt: makeExcerpt(entry.content.toString('utf8'), redactOptions).text,
        excerptBytes: makeExcerpt(entry.content.toString('utf8'), redactOptions).bytes,
        sha256: sha256(entry.content.toString('utf8')),
      });
    }
  }

  // --- L4 capability -------------------------------------------------------
  const capabilities = scanCapabilities(entries);
  const present = capabilities.findings.filter((f) => f.present);
  const l4Excerpt = makeExcerpt(
    JSON.stringify(
      {
        present: present.map((f) => ({
          id: f.id,
          confidence: f.confidence,
          attribution: f.attribution,
          firstEvidence: f.evidence[0] ?? null,
        })),
        scannedFiles: capabilities.scannedFiles,
        skippedFiles: capabilities.skippedFiles,
        limits: capabilities.limits,
      },
      null,
      2,
    ),
    redactOptions,
  );
  evidence.push({
    id: 'e-l4',
    kind: 'static',
    command: `scan ${capabilities.scannedFiles} shipped source file(s) for capability signatures`,
    excerpt: l4Excerpt.text,
    excerptBytes: l4Excerpt.bytes,
  });

  const dimensions: Record<string, Dimension> = {
    L0_qualification: {
      id: 'L0',
      status: qualification.status,
      summary:
        qualification.status === 'pass'
          ? `declares dsh.bundle.patch and every declared patch path exists (${qualification.fileCount} files, ${qualification.unpackedBytes} bytes unpacked)`
          : qualification.reasons.join('; '),
      metrics: {
        fileCount: qualification.fileCount,
        unpackedBytes: qualification.unpackedBytes,
        patchPaths: qualification.patchPaths,
        declaredEnginesDsh: qualification.declared.enginesDsh,
        shipsSource: qualification.shipsSource,
      },
      evidenceRefs: ['e-resolve', 'e-tarball', 'e-l0'],
      notes: qualification.notes,
    },
    L1_install: skipped('L1', 'not run: installing runs third-party code and requires the verification container'),
    L2_load: skipped('L2', 'not run: loading runs third-party code and requires the verification container'),
    L3_run: skipped('L3', 'not run: a session needs a model or a replay fixture'),
    L4_capability: {
      id: 'L4',
      status: 'pass',
      summary: `${present.length} capability signal(s) present across ${capabilities.scannedFiles} scanned file(s)`,
      metrics: {
        scannedFiles: capabilities.scannedFiles,
        scannedBytes: capabilities.scannedBytes,
        skippedFiles: capabilities.skippedFiles,
      },
      evidenceRefs: ['e-l4', ...(bundlePatch ? ['e-patch'] : [])],
      notes: capabilities.limits,
    },
    L5_overhead: skipped('L5', 'not run: needs a running host to sample against a baseline'),
    L6_uninstall: skipped('L6', 'not run: needs an installed profile to remove from'),
  };

  const verdict = deriveVerdict(dimensions as Record<keyof typeof dimensions, Dimension>);

  const report = {
    schema: 'dsh.plugin.report.v1',
    reportId: `npm:${subject.name}@${subject.version}`,
    generatedAt: (options.now ?? new Date()).toISOString(),
    verifier: {
      name: VERIFIER_NAME,
      version: VERIFIER_VERSION,
      ...(process.env.DSH_VERIFY_COMMIT ? { commit: process.env.DSH_VERIFY_COMMIT } : {}),
    },
    subject: {
      spec: subject.spec,
      name: subject.name,
      version: subject.version,
      registry: subject.registry,
      tarball: subject.tarball,
      ...(integrity ? { integrity } : {}),
      ...(subject.shasum ? { shasum: subject.shasum } : {}),
      ...(subject.repository ? { repository: subject.repository } : {}),
      ...(subject.license ? { license: subject.license } : {}),
      ...(subject.publishedAt ? { publishedAt: subject.publishedAt } : {}),
      ...(qualification.declared.bundlePatch && qualification.declared.bundlePatch.length === 1
        ? { dshBundlePatch: qualification.declared.bundlePatch[0] }
        : qualification.declared.bundlePatch
          ? { dshBundlePatch: qualification.declared.bundlePatch }
          : {}),
      ...(qualification.declared.enginesDsh ? { declaredEnginesDsh: qualification.declared.enginesDsh } : {}),
    },
    runtime: {
      // Nothing was executed, so no runtime version is claimed.
      dshVersion: NOT_EXECUTED,
      nodeVersion: process.version,
      os: platform(),
      arch: arch(),
    },
    container: {
      image: 'none',
      imageDigest: null,
      notes: 'static-only run in the host process; no container was used',
    },
    verdict,
    dimensions,
    capabilities: capabilities.findings,
    evidence,
    redactions: [],
    disclaimers: [DISCLAIMER],
    limits: [
      ...(qualification.shipsSource
        ? []
        : [
            'the artifact ships no source paths, so capability findings describe build output only; ' +
              'code-level attribution between the author and inlined dependencies is not resolvable from this artifact',
          ]),
      ...capabilities.limits,
    ],
    ...(bundlePatch ? { bundlePatch } : {}),
  };

  return { report, subject, qualification, capabilities, bundlePatch, entries, budgetExceeded: null };
}
