/**
 * amend.ts — how a published conclusion changes.
 *
 * The rule this project states is that corrections are **additive**: a wrong
 * finding is superseded by a new dated entry and a bumped verdict, never quietly
 * edited. Until now nothing enforced that; `changelog` and `supersedes` sat in
 * the schema unused.
 *
 * Two guards make the rule real rather than advisory:
 *
 *   - **a correction may not drop evidence.** A report with fewer evidence
 *     entries than the one it supersedes is not a correction, it is a
 *     retraction of the record. That is refused.
 *   - **the diff is computed, not trusted.** The changelog entry describes the
 *     verdict and dimension changes by reading both reports, so a correction
 *     cannot be published with a changelog that misdescribes it.
 *
 * The human still supplies the reason, because "why" is the one thing a diff
 * cannot know.
 */

import { DIMENSION_KEYS } from './validate.ts';
import type { Dimension } from './validate.ts';

export class AmendmentError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = 'AmendmentError';
    this.reason = reason;
  }
}

export interface DimensionChange {
  key: string;
  before: string;
  after: string;
}

export interface AmendmentDiff {
  reportId: string;
  supersedes: string;
  verdict: { before: string; after: string };
  dimensions: DimensionChange[];
}

export interface AmendmentResult {
  report: Record<string, any>;
  diff: AmendmentDiff;
  change: string;
}

export interface AmendmentOptions {
  /** Why the conclusion changed. Required: a diff cannot know this. */
  change: string;
  /** ISO date for the changelog entry. Defaults to today (UTC). */
  date?: string;
}

function dimensionStatus(report: Record<string, any>, key: string): string {
  return String(report?.dimensions?.[key]?.status ?? 'absent');
}

export function diffReports(previous: Record<string, any>, next: Record<string, any>): AmendmentDiff {
  const dimensions: DimensionChange[] = [];
  for (const key of DIMENSION_KEYS) {
    const before = dimensionStatus(previous, key);
    const after = dimensionStatus(next, key);
    if (before !== after) dimensions.push({ key, before, after });
  }

  return {
    reportId: String(next.reportId ?? ''),
    supersedes: String(previous.reportId ?? ''),
    verdict: { before: String(previous.verdict ?? ''), after: String(next.verdict ?? '') },
    dimensions,
  };
}

/** A one-line, human-readable description of what actually changed. */
export function describeDiff(diff: AmendmentDiff): string {
  const parts: string[] = [];
  if (diff.verdict.before !== diff.verdict.after) {
    parts.push(`verdict ${diff.verdict.before} → ${diff.verdict.after}`);
  }
  for (const change of diff.dimensions) {
    parts.push(`${change.key} ${change.before} → ${change.after}`);
  }
  return parts.length > 0 ? parts.join('; ') : 'no dimension status changed';
}

/**
 * Produces the corrected report. Throws {@link AmendmentError} when the change
 * is not an amendment.
 */
export function amendReport(
  previous: Record<string, any>,
  next: Record<string, any>,
  options: AmendmentOptions,
): AmendmentResult {
  const change = (options.change ?? '').trim();
  if (change === '') {
    throw new AmendmentError('a correction must state why the conclusion changed', 'no-reason');
  }
  if (!previous.reportId || !next.reportId) {
    throw new AmendmentError('both reports must carry a reportId', 'missing-identity');
  }
  if (previous.reportId === next.reportId) {
    throw new AmendmentError(
      `report ${previous.reportId} cannot supersede itself`,
      'same-report',
    );
  }
  if (previous.subject?.name !== next.subject?.name) {
    throw new AmendmentError(
      `a correction must cover the same package (${previous.subject?.name} vs ${next.subject?.name})`,
      'different-subject',
    );
  }

  const before = (previous.evidence ?? []) as unknown[];
  const after = (next.evidence ?? []) as unknown[];
  if (after.length < before.length) {
    throw new AmendmentError(
      `the amendment drops evidence: ${before.length} entries become ${after.length}. ` +
        'A correction is additive; removing evidence is not a correction.',
      'evidence-removed',
    );
  }

  const diff = diffReports(previous, next);
  const date = options.date ?? new Date().toISOString().slice(0, 10);

  const report = JSON.parse(JSON.stringify(next)) as Record<string, any>;
  report.supersedes = previous.reportId;

  // The history accumulates. A reader of the newest report should see the whole
  // trail of conclusions about the package, not just the most recent step —
  // otherwise the second correction silently erases the first.
  const inherited = [...((previous.changelog ?? []) as Array<Record<string, unknown>>), ...((report.changelog ?? []) as Array<Record<string, unknown>>)];
  const seen = new Set<string>();
  const history = inherited.filter((entry) => {
    const key = `${String(entry.date)}|${String(entry.change)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  report.changelog = [
    ...history,
    {
      date,
      change,
      changeDescription: describeDiff(diff),
      supersedesVerdict: diff.verdict.before,
    },
  ];

  return { report, diff, change };
}
