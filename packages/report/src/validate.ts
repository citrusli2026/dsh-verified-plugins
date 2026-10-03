/**
 * validate.ts — schema validation plus the semantic rules from docs/method.md.
 *
 * Schema validation alone is not enough. The rule that gives this project its
 * credibility is that a verdict may not exceed the dimensions that actually
 * executed, and that is not expressible in JSON Schema.
 */

import { readFileSync } from 'node:fs';
import { validateAgainst, findUnsupportedKeywords, type ValidationIssue } from './schema.ts';

export const DISCLAIMER =
  'Verification is not a security audit and not an endorsement. It records what was executed and observed on one machine at one time. Absence of a finding is not a finding of absence.';

export const DIMENSION_KEYS = [
  'L0_qualification',
  'L1_install',
  'L2_load',
  'L3_run',
  'L4_capability',
  'L5_overhead',
  'L6_uninstall',
] as const;

export type DimensionKey = (typeof DIMENSION_KEYS)[number];

export type DimensionStatus = 'pass' | 'fail' | 'skip' | 'blocked' | 'inconclusive' | 'timeout';

export interface Dimension {
  id: string;
  status: DimensionStatus;
  summary: string;
  metrics?: Record<string, unknown>;
  evidenceRefs: string[];
  notes?: string[];
}

export interface EvidenceEntry {
  id: string;
  kind: 'command' | 'log' | 'sample' | 'static' | 'artifact';
  command?: string;
  exitCode?: number;
  durationMs?: number;
  excerpt?: string;
  excerptBytes?: number;
  truncated?: boolean;
  sha256?: string;
}

export const MAX_EXCERPT_BYTES = 2048;

export function loadSchema(schemaPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
}

/**
 * The verdict ladder. A verdict names the highest rung reached, and is capped
 * by the weakest link: one blocked dimension is enough to lose `verified`.
 */
export function deriveVerdict(dimensions: Record<DimensionKey, Dimension>): string {
  const statuses = DIMENSION_KEYS.map((k) => dimensions[k]?.status);
  if (dimensions.L0_qualification?.status === 'fail') return 'not-installable';
  if (statuses.every((s) => s === 'pass')) return 'verified';
  if (statuses.some((s) => s === 'pass')) return 'partial';
  return 'inconclusive';
}

export function validateReport(report: unknown, schema: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // The schema itself must stay inside the validator's supported subset, so it
  // cannot quietly grow past what is actually checked.
  issues.push(...findUnsupportedKeywords(schema));
  if (issues.length > 0) return issues;

  issues.push(...validateAgainst(report, schema));

  const r = report as Record<string, any>;
  const dimensions = (r.dimensions ?? {}) as Record<string, Dimension>;
  const evidence = (r.evidence ?? []) as EvidenceEntry[];

  // Evidence integrity.
  const ids = new Set<string>();
  for (const [i, entry] of evidence.entries()) {
    if (ids.has(entry.id)) issues.push({ path: `$.evidence[${i}]`, message: `duplicate evidence id "${entry.id}"` });
    ids.add(entry.id);
    if (typeof entry.excerpt === 'string') {
      const bytes = Buffer.byteLength(entry.excerpt, 'utf8');
      if (bytes > MAX_EXCERPT_BYTES) {
        issues.push({
          path: `$.evidence[${i}].excerpt`,
          message: `excerpt is ${bytes} bytes, over the ${MAX_EXCERPT_BYTES}-byte limit`,
        });
      }
      if (entry.excerptBytes !== undefined && entry.excerptBytes !== bytes) {
        issues.push({
          path: `$.evidence[${i}].excerptBytes`,
          message: `declared ${entry.excerptBytes} bytes but the excerpt is ${bytes}`,
        });
      }
    }
    if (/\[redacted:(?![\w-]+\])/.test(entry.excerpt ?? '')) {
      issues.push({ path: `$.evidence[${i}].excerpt`, message: 'malformed redaction marker' });
    }
  }

  // Every dimension reference must resolve, and a decisive status must cite
  // evidence — a claim with nothing behind it is not publishable.
  for (const key of DIMENSION_KEYS) {
    const dimension = dimensions[key];
    if (!dimension) continue;
    if (dimension.id !== key.slice(0, 2)) {
      issues.push({ path: `$.dimensions.${key}.id`, message: `id "${dimension.id}" does not match key "${key}"` });
    }
    for (const ref of dimension.evidenceRefs ?? []) {
      if (!ids.has(ref)) {
        issues.push({ path: `$.dimensions.${key}.evidenceRefs`, message: `references unknown evidence "${ref}"` });
      }
    }
    if ((dimension.status === 'pass' || dimension.status === 'fail') && (dimension.evidenceRefs ?? []).length === 0) {
      issues.push({
        path: `$.dimensions.${key}`,
        message: `status "${dimension.status}" must cite at least one piece of evidence`,
      });
    }
    if (!dimension.summary || dimension.summary.trim() === '') {
      issues.push({ path: `$.dimensions.${key}.summary`, message: 'summary is empty' });
    }
  }

  // The headline rule: the verdict cannot exceed what executed.
  if (DIMENSION_KEYS.every((k) => dimensions[k])) {
    const derived = deriveVerdict(dimensions as Record<DimensionKey, Dimension>);
    if (r.verdict && r.verdict !== derived) {
      issues.push({
        path: '$.verdict',
        message: `declared verdict "${r.verdict}" but the dimensions add up to "${derived}"`,
      });
    }
  }

  // The disclaimer is not optional.
  const disclaimers = (r.disclaimers ?? []) as string[];
  if (!disclaimers.includes(DISCLAIMER)) {
    issues.push({ path: '$.disclaimers', message: 'the canonical not-an-endorsement disclaimer is missing' });
  }

  // A measured overhead result must be reflected in the L5 dimension.
  if (r.overhead?.status && r.overhead.status !== 'inconclusive' && dimensions.L5_overhead) {
    if (dimensions.L5_overhead.status === 'skip') {
      issues.push({
        path: '$.dimensions.L5_overhead.status',
        message: `overhead.status is "${r.overhead.status}" but the dimension is skipped`,
      });
    }
  }

  return issues;
}
