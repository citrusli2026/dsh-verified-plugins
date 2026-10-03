/**
 * bundle-patch.ts — analyse a DSH `cordis.patch.yml`.
 *
 * This is the most DSH-specific surface in the whole project, and it deserves
 * its own treatment: a bundle patch is not just configuration. Per the
 * manifest contract it is "a top-level YAML array of loader patch entries
 * (id-targeted config overrides, disables, and insert lists; `!!js` expressions
 * allowed)".
 *
 * So a plugin's patch can (a) disable host entries it does not own, (b) rewrite
 * their configuration, and (c) carry `!!js` expressions, which are code
 * evaluated from a configuration file. None of that shows up in a `lib/**` scan.
 *
 * The analysis is deliberately textual rather than a YAML parse: the goal is a
 * location a reader can open, and a line number is worth more here than a
 * faithful object model. Anything ambiguous is reported as such.
 */

export interface PatchFinding {
  kind: 'disables-entry' | 'overrides-config' | 'js-expression' | 'inserts-entry';
  line: number;
  snippet: string;
}

export interface BundlePatchAnalysis {
  path: string;
  present: boolean;
  bytes: number;
  /** Top-level `- ` entries, the patch's unit of change. */
  entryCount: number;
  disablesHostEntries: boolean;
  overridesConfig: boolean;
  usesJsExpressions: boolean;
  findings: PatchFinding[];
  notes: string[];
}

function snippet(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

export function analyseBundlePatch(path: string, content: string): BundlePatchAnalysis {
  const lines = content.split('\n');
  const findings: PatchFinding[] = [];
  const notes: string[] = [];

  let entryCount = 0;
  let disablesHostEntries = false;
  let overridesConfig = false;
  let usesJsExpressions = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNumber = i + 1;
    const trimmed = line.trim();

    if (/^-\s+\S/.test(trimmed) || /^-\s*$/.test(trimmed)) entryCount += 1;

    if (/^disabled\s*:/.test(trimmed) || /\bdisabled\s*:/.test(trimmed)) {
      disablesHostEntries = true;
      findings.push({ kind: 'disables-entry', line: lineNumber, snippet: snippet(line) });
    }

    if (/^config\s*:/.test(trimmed)) {
      overridesConfig = true;
      findings.push({ kind: 'overrides-config', line: lineNumber, snippet: snippet(line) });
    }

    if (trimmed.includes('!!js')) {
      usesJsExpressions = true;
      findings.push({ kind: 'js-expression', line: lineNumber, snippet: snippet(line) });
    }

    if (/\binsert\s*:/.test(trimmed) || /^-\s*id\s*:/.test(trimmed)) {
      findings.push({ kind: 'inserts-entry', line: lineNumber, snippet: snippet(line) });
    }
  }

  if (entryCount === 0 && content.trim() !== '' && content.trim() !== '[]') {
    notes.push('the patch has no top-level "- " entries; it may not be a loader patch array');
  }
  if (usesJsExpressions) {
    notes.push(
      '!!js expressions are code carried in a configuration file, evaluated when the patch is applied',
    );
  }
  notes.push('textual analysis: a line number is provided for review, not a YAML object model');

  return {
    path,
    present: true,
    bytes: Buffer.byteLength(content, 'utf8'),
    entryCount,
    disablesHostEntries,
    overridesConfig,
    usesJsExpressions,
    findings: findings.slice(0, 25),
    notes,
  };
}
