/**
 * redact.ts — nothing from a verification run reaches a published report
 * without passing through here.
 *
 * docs/security.md § 4 is the contract:
 *   never publish  full command output, absolute paths, environment variable
 *                  values, session content, anything from ~/.dsh
 *   always publish exit codes, durations, redacted excerpts (<=2 KiB),
 *                  capability findings with file:line, sampling data points
 *
 * Redaction is visible, never silent: every removal becomes
 * `[redacted:<reason>]` and is counted, so a reader can see that something was
 * removed and why.
 */

export interface RedactionRecord {
  reason: string;
  count: number;
}

const CREDENTIAL_SHAPES: Array<{ reason: string; re: RegExp }> = [
  { reason: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { reason: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { reason: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { reason: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { reason: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { reason: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  { reason: 'private-key-block', re: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g },
  { reason: 'bearer-header', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g },
];

/**
 * Environment-variable *values* are never published. Names are kept, because
 * "the plugin read API_KEY" is the finding; the value is not the finding.
 */
const SECRET_ENV_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g;

export interface RedactOptions {
  /** Absolute paths to rewrite, outermost first. */
  paths?: Array<{ from: string; to: string }>;
  /** Hard cap on the result, in bytes (UTF-8). Defaults to 2 KiB. */
  maxBytes?: number;
}

export interface RedactionResult {
  text: string;
  truncated: boolean;
  bytes: number;
  redactions: RedactionRecord[];
}

function countInto(records: Map<string, number>, reason: string, n = 1): void {
  records.set(reason, (records.get(reason) ?? 0) + n);
}

/** Rewrites host paths so a report never leaks the machine's layout. */
export function redactPaths(text: string, options: RedactOptions = {}): { text: string; redactions: RedactionRecord[] } {
  const counts = new Map<string, number>();
  let out = text;
  const paths = [...(options.paths ?? [])].sort((a, b) => b.from.length - a.from.length);
  for (const { from, to } of paths) {
    if (!from) continue;
    const parts = out.split(from);
    if (parts.length > 1) {
      countInto(counts, `path:${to}`, parts.length - 1);
      out = parts.join(to);
    }
  }
  return { text: out, redactions: [...counts].map(([reason, count]) => ({ reason, count })) };
}

/** Removes credential-shaped strings and secret environment values. */
export function redactSecrets(text: string): { text: string; redactions: RedactionRecord[] } {
  const counts = new Map<string, number>();
  let out = text;

  for (const { reason, re } of CREDENTIAL_SHAPES) {
    out = out.replace(re, () => {
      countInto(counts, reason);
      return `[redacted:${reason}]`;
    });
  }

  out = out.replace(SECRET_ENV_ASSIGNMENT, (_match, name: string) => {
    countInto(counts, 'env-value');
    return `${name}=[redacted:env-value]`;
  });

  return { text: out, redactions: [...counts].map(([reason, count]) => ({ reason, count })) };
}

/**
 * Full excerpt pipeline: paths, then secrets, then a hard byte cap.
 *
 * The cap is applied last and on a byte boundary so a multi-byte character is
 * never split into invalid UTF-8.
 */
export function makeExcerpt(text: string, options: RedactOptions = {}): RedactionResult {
  const maxBytes = options.maxBytes ?? 2048;

  const pathResult = redactPaths(text, options);
  const secretResult = redactSecrets(pathResult.text);

  const merged = new Map<string, number>();
  for (const r of [...pathResult.redactions, ...secretResult.redactions]) {
    merged.set(r.reason, (merged.get(r.reason) ?? 0) + r.count);
  }

  let out = secretResult.text;
  let truncated = false;
  if (Buffer.byteLength(out, 'utf8') > maxBytes) {
    truncated = true;
    // Slice on the encoded bytes, then drop a trailing partial character.
    out = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.from(out, 'utf8').subarray(0, maxBytes));
    out = out.replace(/\uFFFD+$/, '');
  }

  return {
    text: out,
    truncated,
    bytes: Buffer.byteLength(out, 'utf8'),
    redactions: [...merged].map(([reason, count]) => ({ reason, count })),
  };
}
