/**
 * qualify.ts — L0: is this actually an installable DSH plugin?
 *
 * The specification's definition is deliberately narrow: a real plugin declares
 * `dsh.bundle.patch`, and every path it names exists in the published tarball.
 * Everything else is a note, not a disqualification.
 *
 * This is the filter that makes the ecosystem numbers meaningful: a GitHub
 * topic is not a plugin list, and `dsh-xray`'s published finding is that most
 * high-star repositories are not installable plugins at all.
 */

import type { TarEntry } from './tar.ts';

export interface DeclaredManifest {
  manifestVersion: number | null;
  bundlePatch: string[] | null;
  clientPlatform: string | null;
  enginesDsh: string | null;
  enginesNode: string | null;
}

export interface QualificationResult {
  status: 'pass' | 'fail';
  reasons: string[];
  notes: string[];
  declared: DeclaredManifest;
  patchPaths: string[];
  missingPatchPaths: string[];
  fileCount: number;
  unpackedBytes: number;
  /** True when the tarball ships source paths, false when it is bundle-only. */
  shipsSource: boolean;
}

const SOURCE_DIR = /(^|\/)(src|source)\//;

export function readDeclaredManifest(manifest: Record<string, any>): DeclaredManifest {
  const dsh = (manifest.dsh ?? {}) as Record<string, any>;
  const bundle = (dsh.bundle ?? {}) as Record<string, any>;
  const rawPatch = bundle.patch;

  let bundlePatch: string[] | null = null;
  if (typeof rawPatch === 'string') bundlePatch = [rawPatch];
  else if (Array.isArray(rawPatch)) bundlePatch = rawPatch.filter((p): p is string => typeof p === 'string');

  return {
    manifestVersion: typeof dsh.manifestVersion === 'number' ? dsh.manifestVersion : null,
    bundlePatch,
    clientPlatform: typeof dsh.client?.platform === 'string' ? dsh.client.platform : null,
    enginesDsh: typeof manifest.engines?.dsh === 'string' ? manifest.engines.dsh : null,
    enginesNode: typeof manifest.engines?.node === 'string' ? manifest.engines.node : null,
  };
}

/** Normalises a patch path for lookup: strip a leading `./` and the `package/` prefix. */
function toArchivePath(patchPath: string): string {
  return patchPath.replace(/^\.\//, '');
}

export function qualify(
  entries: TarEntry[],
  manifest: Record<string, any>,
  manifestPath: string,
): QualificationResult {
  const reasons: string[] = [];
  const notes: string[] = [];
  const declared = readDeclaredManifest(manifest);

  const files = entries.filter((entry) => entry.type === 'file');
  const manifestDir = manifestPath.includes('/') ? `${manifestPath.split('/').slice(0, -1).join('/')}/` : '';
  const relativePaths = new Set(files.map((f) => (manifestDir && f.path.startsWith(manifestDir) ? f.path.slice(manifestDir.length) : f.path)));

  const shipsSource = files.some((f) => SOURCE_DIR.test(f.path));

  // The qualification test.
  if (!declared.bundlePatch || declared.bundlePatch.length === 0) {
    reasons.push(
      'package.json declares no dsh.bundle.patch, so this is not an installable DSH plugin bundle',
    );
  }

  const missingPatchPaths: string[] = [];
  for (const patchPath of declared.bundlePatch ?? []) {
    if (!relativePaths.has(toArchivePath(patchPath))) missingPatchPaths.push(patchPath);
  }
  if (missingPatchPaths.length > 0) {
    reasons.push(
      `declared bundle patch path(s) not present in the published tarball: ${missingPatchPaths.join(', ')}`,
    );
  }

  if (declared.manifestVersion === null) {
    notes.push('dsh.manifestVersion is not declared; the reader does not infer a default');
  } else if (declared.manifestVersion !== 1) {
    notes.push(`dsh.manifestVersion is ${declared.manifestVersion}, not the declared format 1`);
  }

  if (!shipsSource) {
    notes.push('tarball ships no src/ paths, so capability findings are limited to build output');
  }

  return {
    status: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    notes,
    declared,
    patchPaths: declared.bundlePatch ?? [],
    missingPatchPaths,
    fileCount: files.length,
    unpackedBytes: files.reduce((sum, f) => sum + f.size, 0),
    shipsSource,
  };
}
