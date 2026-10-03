/**
 * semver.ts — a focused SemVer range evaluator.
 *
 * DSH enforces `peerDependencies` on `@deepseek-ai/dsh*` and refuses an
 * incompatible install (observed, docs/evidence/V1.md). Predicting that without
 * executing anything turns "declares a bundle" into "installs on *your*
 * runtime", which is the question a user actually has.
 *
 * Zero dependencies, like everything else here. The supported grammar is what
 * the ecosystem actually publishes, plus a refusal:
 *
 *   1.2.3    =1.2.3   >1.2.3   >=1.2.3   <1.2.3   <=1.2.3
 *   ^1.2.3   ~1.2.3   1.2.x    1.x      *        (space = AND, || = OR)
 *
 * Anything outside that throws rather than guessing, and the caller records it.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  raw: string;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text: string): Version | null {
  const match = VERSION_RE.exec(text.trim());
  if (!match) return null;
  const prerelease = (match[4] ?? '')
    .split('.')
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: text.trim(),
  };
}

/** SemVer precedence: a release outranks any prerelease of the same tuple. */
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = typeof left === 'number';
    const rightNumeric = typeof right === 'number';
    if (leftNumeric && rightNumeric) return (left as number) < (right as number) ? -1 : 1;
    if (leftNumeric) return -1; // numeric identifiers sort below alphanumeric
    if (rightNumeric) return 1;
    return (left as string) < (right as string) ? -1 : 1;
  }
  return 0;
}

interface Comparator {
  op: '>' | '>=' | '<' | '<=' | '=';
  version: Version;
  /** Set when the comparator came from ^ or ~, which expand to two bounds. */
  upper?: { op: '<' | '<='; version: Version };
}

function bump(version: Version, part: 'major' | 'minor' | 'patch'): Version {
  const next = { ...version, prerelease: [] as Array<string | number> };
  if (part === 'major') return { ...next, major: version.major + 1, minor: 0, patch: 0 };
  if (part === 'minor') return { ...next, minor: version.minor + 1, patch: 0 };
  return { ...next, patch: version.patch + 1 };
}

function parseComparator(text: string): Comparator {
  const raw = text.trim();
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') {
    return { op: '>=', version: { major: 0, minor: 0, patch: 0, prerelease: [], raw: '0.0.0' } };
  }

  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(raw);
  if (!match) throw new Error(`unsupported range token ${JSON.stringify(raw)}`);
  const op = (match[1] ?? '=') as Comparator['op'];
  const versionText = (match[2] as string).trim();

  // Partial versions: `1` and `1.2` mean ranges, not versions.
  const partial = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(versionText);
  if (partial && (partial[3] === undefined || /x|X|\*/.test(partial[3]))) {
    const major = Number(partial[1]);
    const minor = partial[2] !== undefined && !/x|X|\*/.test(partial[2]) ? Number(partial[2]) : undefined;
    const lower: Version = {
      major,
      minor: minor ?? 0,
      patch: 0,
      prerelease: [],
      raw: versionText,
    };
    if (op === '^') {
      const upper = major > 0 ? bump(lower, 'major') : minor !== undefined ? bump(lower, 'minor') : bump(lower, 'minor');
      return { op: '>=', version: lower, upper: { op: '<', version: upper } };
    }
    if (op === '~') return { op: '>=', version: lower, upper: { op: '<', version: bump(lower, 'minor') } };
    if (minor === undefined) return { op: '>=', version: lower, upper: { op: '<', version: bump(lower, 'major') } };
    return { op: '>=', version: lower, upper: { op: '<', version: bump(lower, 'minor') } };
  }

  const version = parseVersion(versionText);
  if (!version) throw new Error(`unsupported version ${JSON.stringify(versionText)} in range ${JSON.stringify(raw)}`);

  if (op === '^') {
    // Caret on 0.x pins the minor: ^0.0.1 is >=0.0.1 <0.0.2.
    const upper =
      version.major > 0
        ? bump(version, 'major')
        : version.minor > 0
          ? bump(version, 'minor')
          : bump(version, 'patch');
    return { op: '>=', version, upper: { op: '<', version: upper } };
  }
  if (op === '~') return { op: '>=', version, upper: { op: '<', version: bump(version, 'minor') } };
  if (op === '>') {
    // `>1.2.3` excludes prereleases of 1.2.3, matching npm.
    return { op: '>', version, ...(version.prerelease.length > 0 ? { upper: undefined } : {}) };
  }
  return { op, version };
}

function testComparator(comparator: Comparator, candidate: Version): boolean {
  const cmp = compareVersions(candidate, comparator.version);
  let ok: boolean;
  switch (comparator.op) {
    case '>':
      ok = cmp > 0;
      break;
    case '>=':
      ok = cmp >= 0;
      break;
    case '<':
      ok = cmp < 0;
      break;
    case '<=':
      ok = cmp <= 0;
      break;
    default:
      ok = cmp === 0;
  }
  if (ok && comparator.upper) {
    const up = compareVersions(candidate, comparator.upper.version);
    ok = comparator.upper.op === '<' ? up < 0 : up <= 0;
  }
  return ok;
}

/**
 * npm's prerelease rule: a prerelease candidate may only satisfy a range when
 * some comparator in the set carries a prerelease on the same [major,minor,patch].
 * Without this, `0.2.0-rc.2` would wrongly match `>=0.1.0` while sitting inside
 * a range nobody intended it to enter.
 */
function prereleaseAllowed(comparators: Comparator[], candidate: Version): boolean {
  if (candidate.prerelease.length === 0) return true;
  return comparators.some(
    (c) =>
      c.version.prerelease.length > 0 &&
      c.version.major === candidate.major &&
      c.version.minor === candidate.minor &&
      c.version.patch === candidate.patch,
  );
}

/** True when `version` satisfies `range`. Throws on grammar outside the subset. */
export function satisfies(version: string, range: string): boolean {
  const candidate = parseVersion(version);
  if (!candidate) throw new Error(`not a version: ${JSON.stringify(version)}`);

  const alternatives = range.split('||');
  for (const alternative of alternatives) {
    const tokens = alternative.trim().split(/\s+/).filter((t) => t !== '');
    if (tokens.length === 0) continue;
    const comparators = tokens.map(parseComparator);
    if (!prereleaseAllowed(comparators, candidate)) continue;
    if (comparators.every((c) => testComparator(c, candidate))) return true;
  }
  return false;
}

export interface PeerVerdict {
  compatible: boolean;
  /** Peers whose declared range the runtime does not satisfy. */
  unsatisfied: Array<{ name: string; range: string }>;
  /** Peers whose range this evaluator does not support; the verdict is unsure. */
  unsupported: Array<{ name: string; range: string }>;
}

/**
 * Evaluates every `@deepseek-ai/dsh*` peer against one runtime version, which is
 * the rule DSH itself applies before allowing an install.
 */
export function evaluateDshPeers(
  peers: Record<string, string> | null,
  runtimeVersion: string,
): PeerVerdict {
  const unsatisfied: PeerVerdict['unsatisfied'] = [];
  const unsupported: PeerVerdict['unsupported'] = [];

  for (const [name, range] of Object.entries(peers ?? {})) {
    try {
      if (!satisfies(runtimeVersion, range)) unsatisfied.push({ name, range });
    } catch {
      unsupported.push({ name, range });
    }
  }

  return {
    compatible: unsatisfied.length === 0 && unsupported.length === 0,
    unsatisfied,
    unsupported,
  };
}
