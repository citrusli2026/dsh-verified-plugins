/** Record a container failure without claiming that any plugin phase completed. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { deriveVerdict, loadSchema, validateReport, type DimensionKey } from './validate.ts';

const EXECUTION_KEYS: DimensionKey[] = [
  'L1_install', 'L2_load', 'L3_run', 'L5_overhead', 'L6_uninstall',
];

export function orchestrationFailure(
  staticReport: Record<string, any>,
  phase: 'prefetch' | 'execution',
  exitCode: number,
  durationMs: number,
  image: string,
  imageDigest: string,
  dshVersion: string,
  attempts = 1,
): Record<string, any> {
  const report = structuredClone(staticReport);
  const timedOut = exitCode === 124;
  const summary = phase === 'prefetch'
    ? exitCode === 4 ? 'non-registry dependency requires manual review'
      : timedOut ? 'dependency prefetch reached the wall-clock ceiling' : 'dependency prefetch did not complete'
    : timedOut ? 'execution container reached the wall-clock ceiling before producing a result' : 'execution container produced no phase result';
  report.generatedAt = new Date().toISOString();
  report.runtime.dshVersion = dshVersion;
  report.container = {
    image, imageDigest,
    notes: `${attempts} ${phase} attempt(s); the failed attempt was isolated; no execution dimension is inferred from missing output`,
  };
  report.evidence.push({
    id: 'e-orchestration', kind: 'command',
    command: `packages/runner/container/run-suite.sh ${report.subject.name}@${report.subject.version}`,
    exitCode, durationMs,
    excerpt: summary, excerptBytes: Buffer.byteLength(summary, 'utf8'), truncated: false,
  });
  for (const key of EXECUTION_KEYS) {
    const attempted = phase === 'execution' || key === 'L1_install';
    report.dimensions[key] = {
      id: key.slice(0, 2),
      status: attempted ? (phase === 'prefetch' && exitCode === 4 ? 'blocked' : timedOut ? 'timeout' : 'inconclusive') : 'skip',
      summary: attempted ? summary : 'not run: dependency prefetch did not complete',
      evidenceRefs: ['e-orchestration'],
      notes: ['the container did not supply a phase result; no phase outcome is asserted'],
    };
  }
  report.limits = [...(report.limits ?? []), summary];
  report.verdict = deriveVerdict(report.dimensions);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [staticPath, outPath, phase, rc, duration, image, digest, dshVersion, attempts] = process.argv.slice(2);
  if (!staticPath || !outPath || !['prefetch', 'execution'].includes(phase) || !image || !digest || !dshVersion) {
    throw new Error('usage: orchestration-failure.ts <static> <out> <prefetch|execution> <rc> <ms> <image> <digest> <dsh-version> [attempts]');
  }
  const report = orchestrationFailure(
    JSON.parse(readFileSync(staticPath, 'utf8')),
    phase as 'prefetch' | 'execution', Number(rc), Number(duration), image, digest, dshVersion, Number(attempts ?? 1),
  );
  const issues = validateReport(report, loadSchema('schemas/dsh.plugin.report.v1.schema.json'));
  if (issues.length > 0) throw new Error(JSON.stringify(issues));
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}
