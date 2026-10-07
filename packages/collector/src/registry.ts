/**
 * registry.ts — resolve a spec to an exact artifact, and fetch it.
 *
 * This is the "fetch phase" from docs/security.md § 3: it touches the network
 * and runs **no** plugin code. Downloading and reading a tarball is not
 * executing it, which is why L0 and L4 can run without a container while L1-L6
 * cannot.
 */

import { createHash } from 'node:crypto';

export interface ResolvedSubject {
  spec: string;
  name: string;
  version: string;
  registry: string;
  tarball: string;
  integrity: string | null;
  shasum: string | null;
  repository: string | null;
  license: string | null;
  publishedAt: string | null;
  description: string | null;
}

export type RegistryErrorKind = 'invalid-spec' | 'not-found' | 'network' | 'unknown';

export class RegistryError extends Error {
  // Declared and assigned explicitly: Node's strip-only TypeScript mode does
  // not support parameter properties, and this project has no build step.
  readonly kind: RegistryErrorKind;

  constructor(message: string, kind: RegistryErrorKind) {
    super(message);
    this.name = 'RegistryError';
    this.kind = kind;
  }
}

export function defaultRegistry(): string {
  return process.env.DSH_VERIFY_REGISTRY ?? 'https://registry.npmjs.org';
}

/** Splits an exact `@scope/name@1.2.3` spec. Tags and ranges are not evidence. */
export function parseSpec(spec: string): { name: string; range: string } {
  const trimmed = spec.trim();
  if (trimmed === '') throw new RegistryError('empty spec', 'invalid-spec');

  const at = trimmed.lastIndexOf('@');
  if (at <= 0) throw new RegistryError(`an exact name@version is required: "${spec}"`, 'invalid-spec');

  const name = trimmed.slice(0, at);
  const range = trimmed.slice(at + 1);
  if (name === '' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(range)) {
    throw new RegistryError(`an exact name@version is required: "${spec}"`, 'invalid-spec');
  }
  return { name, range };
}

/** Select only a version explicitly present in the full registry packument. */
export function selectVersion(versions: Record<string, unknown>, range: string): string {
  if (Object.hasOwn(versions, range)) return range;
  throw new RegistryError(`exact version "${range}" is not published`, 'not-found');
}

export async function resolveSubject(spec: string, registry = defaultRegistry()): Promise<ResolvedSubject> {
  const { name, range } = parseSpec(spec);
  const url = `${registry.replace(/\/$/, '')}/${name.replace('/', '%2F')}`;

  let packument: Record<string, any>;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.status === 404) throw new RegistryError(`package "${name}" not found in ${registry}`, 'not-found');
    if (!response.ok) throw new RegistryError(`registry returned HTTP ${response.status} for ${name}`, 'network');
    packument = (await response.json()) as Record<string, any>;
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(`could not reach ${registry}: ${String(error)}`, 'network');
  }

  const versions = (packument.versions ?? {}) as Record<string, any>;
  const version = selectVersion(versions, range);
  const manifest = versions[version] ?? {};
  const dist = (manifest.dist ?? {}) as Record<string, string>;

  return {
    spec,
    name,
    version,
    registry,
    tarball: dist.tarball ?? '',
    integrity: dist.integrity ?? null,
    shasum: dist.shasum ?? null,
    repository:
      typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? null),
    license: manifest.license ?? null,
    publishedAt: packument.time?.[version] ?? null,
    description: manifest.description ?? null,
  };
}

/** Raised when an artifact exceeds a hard resource ceiling (docs/security.md § S4). */
export class BudgetExceededError extends Error {
  readonly budget: string;
  readonly detail: string;

  constructor(budget: string, detail: string) {
    super(`${budget} budget exceeded: ${detail}`);
    this.name = 'BudgetExceededError';
    this.budget = budget;
    this.detail = detail;
  }
}

export interface FetchBudget {
  /** Wall-clock ceiling for the artifact download. */
  timeoutMs: number;
  /** Hard byte ceiling, enforced while streaming and not merely trusted from Content-Length. */
  maxBytes: number;
}

/**
 * Exceeding a ceiling yields a `timeout`/`inconclusive` conclusion, never a
 * failure verdict. A plugin that is merely large is not a broken plugin.
 */
export const DEFAULT_FETCH_BUDGET: FetchBudget = {
  timeoutMs: Number(process.env.DSH_VERIFY_FETCH_TIMEOUT_MS ?? 120_000),
  maxBytes: Number(process.env.DSH_VERIFY_FETCH_MAX_BYTES ?? 128 * 1024 * 1024),
};

/**
 * Verifies the fetched bytes against the integrity the registry advertised,
 * while enforcing the fetch budget.
 */
export async function fetchTarball(
  subject: ResolvedSubject,
  budget: FetchBudget = DEFAULT_FETCH_BUDGET,
): Promise<{ bytes: Buffer; integrity: string; verified: boolean }> {
  if (!subject.tarball) throw new RegistryError('resolved subject has no tarball URL', 'unknown');

  let response: Response;
  try {
    response = await fetch(subject.tarball, { signal: AbortSignal.timeout(budget.timeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new BudgetExceededError('wall-clock', `no response within ${budget.timeoutMs} ms`);
    }
    throw new RegistryError(`could not fetch tarball: ${String(error)}`, 'network');
  }

  if (!response.ok) throw new RegistryError(`tarball fetch returned HTTP ${response.status}`, 'network');

  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > budget.maxBytes) {
    throw new BudgetExceededError(
      'artifact-size',
      `Content-Length ${declaredLength} exceeds ${budget.maxBytes} bytes`,
    );
  }

  // Content-Length is a claim. Count the bytes actually received.
  const body = response.body;
  if (!body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > budget.maxBytes) {
      throw new BudgetExceededError('artifact-size', `${bytes.byteLength} bytes exceeds ${budget.maxBytes}`);
    }
    return { bytes, integrity: sha512Of(bytes), verified: integrityMatches(subject, bytes) };
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > budget.maxBytes) {
        await reader.cancel();
        throw new BudgetExceededError('artifact-size', `streamed past ${budget.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new BudgetExceededError('wall-clock', `download did not finish within ${budget.timeoutMs} ms`);
    }
    throw new RegistryError(`tarball download failed after ${total} bytes: ${String(error)}`, 'network');
  }

  const bytes = Buffer.concat(chunks);
  return { bytes, integrity: sha512Of(bytes), verified: integrityMatches(subject, bytes) };
}

function sha512Of(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function integrityMatches(subject: ResolvedSubject, bytes: Buffer): boolean {
  if (!subject.integrity) return false;
  return subject.integrity === `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
