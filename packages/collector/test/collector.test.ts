/**
 * Tests for the collectors: tar reading, capability attribution, comment
 * handling, bundle-patch analysis, and qualification.
 *
 * The comment-handling and attribution tests are regressions from the first
 * real run: `dsh-find-plugin` produced a `writes_outside_workspace` finding
 * from a *doc comment* mentioning `~/.dsh`, and showed compiled `lib/` evidence
 * under an `author-source` attribution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { readTarGz, findRootManifest, isSafeEntryPath } from '../src/tar.ts';
import { scanCapabilities, classifyAttribution } from '../src/capability.ts';
import { analyseBundlePatch } from '../src/bundle-patch.ts';
import { qualify, readDeclaredManifest } from '../src/qualify.ts';
import { parseSpec, selectVersion, RegistryError } from '../src/registry.ts';

/* --------------------------------------------------------------- tar helper */

function tarHeader(name: string, size: number, typeFlag = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8');
  header.write(typeFlag, 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  return header;
}

function tarFile(name: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length), padded]);
}

function makeTar(entries: Array<{ path: string; content: string }>): Buffer {
  return gzipSync(Buffer.concat([...entries.map((e) => tarFile(e.path, e.content)), Buffer.alloc(1024)]));
}

/* --------------------------------------------------------------------- tar */

test('tar: reads entries and the root manifest', () => {
  const tgz = makeTar([
    { path: 'package/package.json', content: '{"name":"x","version":"1.0.0"}' },
    { path: 'package/lib/a.js', content: 'console.log(1)' },
  ]);
  const entries = readTarGz(tgz);
  assert.equal(entries.length, 2);
  const manifest = findRootManifest(entries);
  assert.ok(manifest);
  assert.equal(manifest!.json.name, 'x');
});

test('tar: rejects paths that escape the archive root', () => {
  assert.equal(isSafeEntryPath('package/lib/a.js'), true);
  assert.equal(isSafeEntryPath('../etc/passwd'), false);
  assert.equal(isSafeEntryPath('/etc/passwd'), false);
  assert.equal(isSafeEntryPath('C:/Windows'), false);

  const tgz = makeTar([
    { path: '../evil.js', content: 'x' },
    { path: 'package/ok.js', content: 'y' },
  ]);
  const paths = readTarGz(tgz).map((e) => e.path);
  assert.ok(!paths.includes('../evil.js'), 'traversal entry must be dropped');
  assert.ok(paths.includes('package/ok.js'));
});

/* -------------------------------------------------------------- attribution */

test('attribution: minified and bundled files are build output', () => {
  assert.equal(classifyAttribution('package/lib/a.js', 'var x=1;'.repeat(500)).attribution, 'build-output');
  assert.equal(classifyAttribution('package/lib/a.js', 'const __webpack_require__ = 1;').attribution, 'build-output');
  assert.equal(classifyAttribution('package/node_modules/dep/index.js', 'x').attribution, 'dependency');
  assert.equal(classifyAttribution('package/src/a.ts', 'const a = 1;').attribution, 'author-source');
});

test('attribution: output directories are build output, even unminified', () => {
  // Locks in a real inconsistency: this branch used to fall through to
  // "unknown", which made the documented dist/build/out handling dead code.
  assert.equal(classifyAttribution('package/dist/a.js', 'const a = 1;').attribution, 'build-output');
  assert.equal(classifyAttribution('package/out/a.js', 'const a = 1;').attribution, 'build-output');
});

test('attribution: lib/ is ambiguous and reported as unknown, not guessed at', () => {
  // `lib/` holds compiled output in some packages and hand-written JavaScript
  // in others. Claiming either would misattribute real code.
  assert.equal(classifyAttribution('package/lib/a.js', 'const a = 1;').attribution, 'unknown');
});

/* ------------------------------------------- the commented-path regression */

test('capability: a path mentioned only in a comment produces no finding', () => {
  const source = [
    '/**',
    ' * `$DSH_HOME`, blank treated as unset -> `~/.dsh`) inlined here.',
    ' */',
    'export const value = 1;',
  ].join('\n');

  const result = scanCapabilities([
    { path: 'package/src/a.ts', size: source.length, type: 'file', content: Buffer.from(source) },
  ]);

  const finding = result.findings.find((f) => f.id === 'writes_outside_workspace');
  assert.equal(finding?.present, false, 'a comment must not create a capability finding');
});

test('capability: real code on a non-comment line still reports', () => {
  const source = ['// ~/.dsh is mentioned here', 'const p = os.homedir();'].join('\n');
  const result = scanCapabilities([
    { path: 'package/src/a.ts', size: source.length, type: 'file', content: Buffer.from(source) },
  ]);
  const finding = result.findings.find((f) => f.id === 'writes_outside_workspace');
  assert.equal(finding?.present, true);
  assert.equal(finding?.evidence[0]?.line, 2, 'the evidence must point at the code, not the comment');
});

test('capability: evidence prefers author source over build output', () => {
  const src = 'const r = await fetch(url);';
  const lib = 'const r = await fetch(url);';
  const result = scanCapabilities([
    { path: 'package/lib/a.js', size: lib.length, type: 'file', content: Buffer.from(lib) },
    { path: 'package/src/a.ts', size: src.length, type: 'file', content: Buffer.from(src) },
  ]);
  const finding = result.findings.find((f) => f.id === 'network_egress');
  assert.equal(finding?.present, true);
  assert.equal(finding?.attribution, 'author-source');
  assert.match(finding!.evidence[0]!.file, /^package\/src\//, 'author source must be shown first');
});

test('capability: build-output-only sightings are downgraded and disclosed', () => {
  const minified = `var a=${'1'.repeat(3000)};eval(a)`;
  const result = scanCapabilities([
    { path: 'package/dist/bundle.js', size: minified.length, type: 'file', content: Buffer.from(minified) },
  ]);
  const finding = result.findings.find((f) => f.id === 'eval_or_dynamic_code');
  assert.equal(finding?.present, true);
  assert.equal(finding?.attribution, 'build-output');
  assert.equal(finding?.confidence, 'low');
  assert.ok(result.limits.some((l) => /cannot be reliably attributed/.test(l)));
});

test('capability: oversize files are skipped and counted, not silently dropped', () => {
  const big = 'x'.repeat(100);
  const result = scanCapabilities(
    [{ path: 'package/lib/big.js', size: 5000, type: 'file', content: Buffer.from(big) }],
    { maxFileBytes: 1000 },
  );
  assert.equal(result.skippedFiles, 1);
  assert.ok(result.limits.some((l) => /were not scanned/.test(l)));
});

/* ------------------------------------------------------------ bundle patch */

test('bundle-patch: detects disables, config overrides and !!js with line numbers', () => {
  const patch = [
    '- id: some-entry',
    '  disabled: true',
    '- id: other-entry',
    '  config:',
    '    value: !!js ctx.something()',
  ].join('\n');

  const analysis = analyseBundlePatch('cordis.patch.yml', patch);
  assert.equal(analysis.present, true);
  assert.equal(analysis.disablesHostEntries, true);
  assert.equal(analysis.overridesConfig, true);
  assert.equal(analysis.usesJsExpressions, true);
  assert.equal(analysis.entryCount, 2);

  const js = analysis.findings.find((f) => f.kind === 'js-expression');
  assert.equal(js?.line, 5, 'the finding must point at the line it came from');
  assert.ok(analysis.notes.some((n) => /code carried in a configuration file/.test(n)));
});

/* ------------------------------------------------------------ qualification */

test('qualification: a manifest without dsh.bundle.patch is not installable', () => {
  const tgz = makeTar([{ path: 'package/package.json', content: '{"name":"x","version":"1.0.0"}' }]);
  const entries = readTarGz(tgz);
  const manifest = findRootManifest(entries)!;
  const result = qualify(entries, manifest.json, manifest.path);
  assert.equal(result.status, 'fail');
  assert.match(result.reasons[0]!, /no dsh\.bundle\.patch/);
});

test('qualification: a declared patch missing from the tarball fails', () => {
  const tgz = makeTar([
    {
      path: 'package/package.json',
      content: JSON.stringify({ name: 'x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    },
  ]);
  const entries = readTarGz(tgz);
  const manifest = findRootManifest(entries)!;
  const result = qualify(entries, manifest.json, manifest.path);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.missingPatchPaths, ['./cordis.patch.yml']);
});

test('qualification: a bundle with a present patch and source passes', () => {
  const tgz = makeTar([
    {
      path: 'package/package.json',
      content: JSON.stringify({
        name: 'x',
        version: '1.0.0',
        engines: { dsh: '^0.2.0' },
        dsh: { manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } },
      }),
    },
    { path: 'package/cordis.patch.yml', content: '[]' },
    { path: 'package/src/index.ts', content: 'export const a = 1;' },
  ]);
  const entries = readTarGz(tgz);
  const manifest = findRootManifest(entries)!;
  const result = qualify(entries, manifest.json, manifest.path);
  assert.equal(result.status, 'pass');
  assert.equal(result.shipsSource, true);
  assert.equal(result.declared.enginesDsh, '^0.2.0');
});

test('checking a report never trusts a declared engines.dsh as compatibility', () => {
  const declared = readDeclaredManifest({ engines: { dsh: '^0.2.0' }, dsh: { bundle: { patch: 'p.yml' } } });
  assert.equal(declared.enginesDsh, '^0.2.0');
  // The value is carried for display only; nothing in the pipeline treats an
  // author's declared range as evidence that the plugin works.
});

/* ------------------------------------------------------------------ registry */

test('spec parsing handles scoped names and bare names', () => {
  assert.deepEqual(parseSpec('@scope/name@1.2.3'), { name: '@scope/name', range: '1.2.3' });
  assert.deepEqual(parseSpec('name@1.2.3'), { name: 'name', range: '1.2.3' });
  assert.deepEqual(parseSpec('name'), { name: 'name', range: 'latest' });
  assert.throws(() => parseSpec(''), RegistryError);
});

test('version selection picks the newest match and refuses an impossible range', () => {
  const versions = { '0.1.0': {}, '0.2.0': {}, '0.2.0-rc.2': {}, '0.3.0': {} };
  assert.equal(selectVersion(versions, 'latest'), '0.3.0');
  assert.equal(selectVersion(versions, '0.2.0'), '0.2.0');
  assert.equal(selectVersion(versions, '^0.2.0'), '0.2.0');
  assert.throws(() => selectVersion(versions, '9.9.9'), RegistryError);
});
