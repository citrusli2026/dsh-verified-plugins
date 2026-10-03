/**
 * capability.ts — L4: what can this plugin reach for, statically?
 *
 * Capability is not intent. This module reports *presence* with a file:line and
 * never characterises a finding as malicious — docs/security.md § "Explicit
 * non-goals".
 *
 * The hard requirement from the specification is attribution: distinguishing
 * author-written code from build output. A bundler inlines its dependencies, so
 * an `eval` inside a webpack chunk is usually *not* the plugin author's code.
 * Conflating the two is a published failure mode of this class of tool
 * (observed deviation ~1/7), and this module refuses to guess: when a file is
 * build output, the attribution says so and the confidence is capped.
 */

import type { TarEntry } from './tar.ts';

export type CapabilityId =
  | 'runtime_patch'
  | 'spawns_process'
  | 'listens_on_port'
  | 'reads_secret_env'
  | 'hooks_system_prompt'
  | 'hooks_api_gate'
  | 'writes_outside_workspace'
  | 'watches_filesystem'
  | 'network_egress'
  | 'eval_or_dynamic_code';

export type Attribution = 'author-source' | 'build-output' | 'dependency' | 'unknown';

export interface CapabilityEvidence {
  file: string;
  line: number;
  snippet: string;
}

export interface CapabilityFinding {
  id: CapabilityId;
  present: boolean;
  confidence: 'high' | 'medium' | 'low';
  attribution: Attribution;
  notes: string;
  evidence: CapabilityEvidence[];
}

interface Detector {
  id: CapabilityId;
  /** Base confidence when matched in author-written source. */
  confidence: 'high' | 'medium' | 'low';
  re: RegExp;
  note: string;
}

export const DETECTORS: Detector[] = [
  {
    id: 'spawns_process',
    confidence: 'high',
    re: /\bchild_process\b|\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/,
    note: 'spawns or would spawn an operating-system process',
  },
  {
    id: 'listens_on_port',
    confidence: 'high',
    re: /\.listen\s*\(|\bcreateServer\s*\(|\bnew\s+Server\s*\(/,
    note: 'opens a listening socket',
  },
  {
    id: 'reads_secret_env',
    confidence: 'high',
    re: /process\.env(?:\.|\s*\[\s*['"`])[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*/,
    note: 'reads an environment variable whose name looks credential-shaped',
  },
  {
    id: 'watches_filesystem',
    confidence: 'high',
    re: /\bfs\.watch\s*\(|\bwatchFile\s*\(|\bwatch\s*\(|\bchokidar\b/,
    note: 'watches the filesystem; a recursive workspace watch is the documented cause of host stalls',
  },
  {
    id: 'network_egress',
    confidence: 'medium',
    re: /\bfetch\s*\(|https?\.(?:request|get)\s*\(|\baxios\b|\bundici\b|\bgot\s*\(/,
    note: 'can make outbound network requests',
  },
  {
    id: 'eval_or_dynamic_code',
    confidence: 'medium',
    re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn|\bvm\.createContext\b/,
    note: 'eval or synthesised code; common and often benign, and frequently bundler output',
  },
  {
    id: 'hooks_system_prompt',
    confidence: 'medium',
    re: /['"`]system-prompt['"`]|['"`]systemPrompt['"`]|system-prompt\/assemble/,
    note: 'hooks system-prompt assembly, so it can influence what the model is told',
  },
  {
    id: 'hooks_api_gate',
    confidence: 'medium',
    re: /['"`]api\/gate['"`]|['"`]llm\/stream['"`]|['"`]api\/[a-z-]+['"`]\s*,|\bapiGate\b/,
    note: 'hooks the API/LLM path, so it can observe or alter provider traffic',
  },
  {
    id: 'runtime_patch',
    confidence: 'medium',
    re: /\.patch\s*\(|\bpatchRuntime\b|\bmonkeyPatch\b|Object\.defineProperty\s*\(\s*(?:global|globalThis|process)\b/,
    note: 'patches runtime objects rather than only registering its own services',
  },
  {
    id: 'writes_outside_workspace',
    confidence: 'low',
    re: /\bos\.homedir\s*\(|['"`](?:\/etc\/|\/usr\/|~\/\.)|process\.env\.HOME\b/,
    note: 'writes or resolves paths that can fall outside the workspace; heuristic, expect false positives',
  },
];

const BUNDLE_MARKERS =
  /__webpack_require__|\besbuild\b|\brollup\b|browserify|parcelRequire|System\.register|__d\(function|\bwebpackChunk/;

const SOURCE_DIR = /(^|\/)(src|source)\//;
const BUILD_DIR = /(^|\/)(dist|build|out|lib|bundled|esm|cjs)\//;
const DEP_DIR = /(^|\/)node_modules\//;
const SCANNABLE = /\.(?:[cm]?js|ts|mts|cts|jsx|tsx|mjs|cjs)$/;

/**
 * Classifies where a file's code came from. Order matters: vendored code is a
 * dependency first, and a bundler's flattened output is build output before it
 * is ever "source".
 */
export function classifyAttribution(path: string, content: string): { attribution: Attribution; isMinified: boolean; isBundle: boolean } {
  if (DEP_DIR.test(path)) return { attribution: 'dependency', isMinified: false, isBundle: false };

  const lines = content.split('\n');
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0);
  const average = content.length / Math.max(lines.length, 1);
  const isMinified = longest > 2000 || average > 300;
  const isBundle = BUNDLE_MARKERS.test(content);

  if (isBundle || isMinified) return { attribution: 'build-output', isMinified, isBundle };
  if (SOURCE_DIR.test(path)) return { attribution: 'author-source', isMinified, isBundle };
  if (BUILD_DIR.test(path)) return { attribution: 'unknown', isMinified, isBundle };
  return { attribution: 'unknown', isMinified, isBundle };
}

function snippetAt(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * Standalone comment lines are skipped before matching.
 *
 * This is a measured false-positive fix, not a stylistic choice: the first real
 * run flagged `writes_outside_workspace` in `dsh-find-plugin` because a *doc
 * comment* explaining `DSH_HOME` mentioned `~/.dsh`. A capability claim that a
 * reader opens and finds in prose is worse than no claim.
 *
 * Only lines whose first non-space characters are a comment marker are skipped,
 * so line numbers stay exact. A trailing comment on a line of code is left
 * alone: the code on that line is real either way.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

interface EvidenceCandidate extends CapabilityEvidence {
  attribution: Attribution;
}

export interface CapabilityScanResult {
  findings: CapabilityFinding[];
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  limits: string[];
}

/**
 * Scans the published tarball. Only files the package actually ships are
 * considered — which is the point: what ships is what runs.
 *
 * A per-file size cap keeps a giant bundle from dominating; skipped files are
 * counted and disclosed rather than silently dropped.
 */
export function scanCapabilities(entries: TarEntry[], options: { maxFileBytes?: number; maxEvidencePerCapability?: number } = {}): CapabilityScanResult {
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
  const maxEvidence = options.maxEvidencePerCapability ?? 5;

  const byId = new Map<CapabilityId, CapabilityFinding>();
  for (const detector of DETECTORS) {
    byId.set(detector.id, {
      id: detector.id,
      present: false,
      confidence: detector.confidence,
      attribution: 'unknown',
      notes: detector.note,
      evidence: [],
    });
  }

  let scannedFiles = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  const limits: string[] = [];
  const attributionsSeen = new Map<CapabilityId, Set<Attribution>>();
  const candidates = new Map<CapabilityId, EvidenceCandidate[]>();
  let sawBuildOutput = false;

  for (const entry of entries) {
    if (entry.type !== 'file' || !SCANNABLE.test(entry.path)) continue;
    if (entry.size > maxFileBytes) {
      skippedFiles += 1;
      continue;
    }

    const content = entry.content.toString('utf8');
    scannedFiles += 1;
    scannedBytes += entry.size;

    const { attribution, isMinified, isBundle } = classifyAttribution(entry.path, content);
    if (attribution === 'build-output') sawBuildOutput = true;

    const lines = content.split('\n');
    // Comments are blanked (newlines preserved) for the whole-content test, so
    // a multi-line construct is still found while prose mentioning `~/.dsh`
    // cannot produce a finding. Line numbers stay valid because the array
    // shape is unchanged.
    const codeContent = lines.map(isCommentLine).some(Boolean)
      ? lines.map((line) => (isCommentLine(line) ? '' : line)).join('\n')
      : content;

    for (const detector of DETECTORS) {
      const finding = byId.get(detector.id) as CapabilityFinding;
      const list = candidates.get(detector.id) ?? [];
      candidates.set(detector.id, list);

      let matchedHere = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (isCommentLine(line)) continue;
        if (!detector.re.test(line)) continue;
        matchedHere = true;
        finding.present = true;
        if (!attributionsSeen.has(detector.id)) attributionsSeen.set(detector.id, new Set());
        (attributionsSeen.get(detector.id) as Set<Attribution>).add(attribution);
        if (list.length < 50) list.push({ file: entry.path, line: i + 1, snippet: snippetAt(line), attribution });
        if (isMinified || isBundle) {
          finding.notes = `${finding.notes} (found in build output${isMinified ? ', minified' : ''})`;
        }
        break; // one sample per file is enough; more adds no information
      }

      if (!matchedHere && detector.re.test(codeContent)) {
        // A construct split across lines (`new\nFunction(`) can miss the
        // per-line scan. Record presence, and locate it by finding the first
        // line that participates, so the evidence still points somewhere real.
        finding.present = true;
        const located = lines.findIndex((line) => !isCommentLine(line) && detector.re.test(line));
        const list2 = candidates.get(detector.id) as EvidenceCandidate[];
        if (list2.length < 50) {
          list2.push({
            file: entry.path,
            line: located >= 0 ? located + 1 : 1,
            snippet: located >= 0 ? snippetAt(lines[located] as string) : '(matched across lines)',
            attribution,
          });
        }
        if (!attributionsSeen.has(detector.id)) attributionsSeen.set(detector.id, new Set());
        (attributionsSeen.get(detector.id) as Set<Attribution>).add(attribution);
      }
    }
  }

  if (skippedFiles > 0) {
    limits.push(`${skippedFiles} file(s) larger than ${maxFileBytes} bytes were not scanned`);
  }
  if (sawBuildOutput) {
    limits.push(
      'the package ships build output; code inside a bundle cannot be reliably attributed to the author or to an inlined dependency',
    );
  }
  limits.push('static analysis cannot see dynamically constructed code or prove intent');

  // Evidence selection: a reader should be shown the author's own code first.
  // Several subjects ship both `src/*.ts` and compiled `lib/*.js`, and showing
  // a compiled sample under an "author-source" attribution invites exactly the
  // confusion this module exists to avoid.
  const ATTRIBUTION_PRIORITY: Record<Attribution, number> = {
    'author-source': 0,
    unknown: 1,
    'build-output': 2,
    dependency: 3,
  };
  for (const finding of byId.values()) {
    const list = candidates.get(finding.id) ?? [];
    list.sort((a, b) => ATTRIBUTION_PRIORITY[a.attribution] - ATTRIBUTION_PRIORITY[b.attribution]);
    finding.evidence = list.slice(0, maxEvidence).map(({ file, line, snippet }) => ({ file, line, snippet }));
  }

  // Confidence: a capability whose only sightings are in build output cannot be
  // reported as confidently as one in author-written source.
  for (const finding of byId.values()) {
    if (!finding.present) continue;
    const kinds = attributionsSeen.get(finding.id) ?? new Set<Attribution>();
    const onlyBuildOutput = kinds.size > 0 && [...kinds].every((k) => k === 'build-output' || k === 'dependency');
    if (onlyBuildOutput) {
      finding.attribution = kinds.has('dependency') ? 'dependency' : 'build-output';
      finding.confidence = finding.confidence === 'high' ? 'medium' : 'low';
    } else if (kinds.has('author-source')) {
      finding.attribution = 'author-source';
    } else {
      finding.attribution = 'unknown';
      finding.confidence = finding.confidence === 'high' ? 'medium' : finding.confidence;
    }
  }

  for (const finding of byId.values()) {
    finding.notes = finding.notes.replace(/\s*\(found in build output.*?\)\s*$/, '').trim();
  }

  return {
    findings: [...byId.values()].sort((a, b) => Number(b.present) - Number(a.present) || a.id.localeCompare(b.id)),
    scannedFiles,
    scannedBytes,
    skippedFiles,
    limits,
  };
}
