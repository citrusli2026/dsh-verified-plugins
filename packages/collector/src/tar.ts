/**
 * tar.ts — a minimal, dependency-free reader for the gzipped tar files npm
 * publishes.
 *
 * Why hand-roll it: this project exists to argue about supply chains, and
 * pulling in a tarball library to read a tarball undercuts the argument. The
 * format slice needed here is small and stable (POSIX ustar headers).
 *
 * Safety: entries whose path escapes the archive root are rejected, so a
 * malicious tarball cannot write outside the extraction directory. Nothing is
 * written to disk by this module anyway — it returns an in-memory listing.
 */

import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

export interface TarEntry {
  path: string;
  size: number;
  type: 'file' | 'directory' | 'other';
  content: Buffer;
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim();
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const raw = readString(buf, start, length);
  if (raw === '') return 0;
  const value = Number.parseInt(raw, 8);
  return Number.isFinite(value) ? value : 0;
}

/** Rejects absolute paths and `..` escapes. */
export function isSafeEntryPath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const parts = path.split('/');
  return !parts.includes('..');
}

export function readTarGz(data: Buffer): TarEntry[] {
  const tar = gunzipSync(data);
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two consecutive zero blocks terminate the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 0);

    offset += BLOCK;
    const content = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    if (path === '' || !isSafeEntryPath(path)) continue;

    const type: TarEntry['type'] =
      typeFlag === '5' || path.endsWith('/') ? 'directory' : typeFlag === '0' || typeFlag === '\0' ? 'file' : 'other';

    entries.push({ path: path.replace(/\/$/, ''), size, type, content: Buffer.from(content) });
  }

  return entries;
}

/** The package.json at the archive root, which npm guarantees is `package/`. */
export function findRootManifest(entries: TarEntry[]): { path: string; json: Record<string, unknown> } | null {
  const candidates = entries
    .filter((e) => e.type === 'file' && /^(?:[^/]+\/)?package\.json$/.test(e.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);

  for (const entry of candidates) {
    try {
      return { path: entry.path, json: JSON.parse(entry.content.toString('utf8')) as Record<string, unknown> };
    } catch {
      // Keep looking: an unparseable nested manifest is not the root one.
    }
  }
  return null;
}
