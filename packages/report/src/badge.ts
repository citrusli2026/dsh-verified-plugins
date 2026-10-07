/**
 * badge.ts — the citation surface.
 *
 * A badge is the one artefact of this project most likely to be seen out of
 * context: pasted into someone's README, with no report attached. So it carries
 * two things the specification requires and one it implies:
 *
 *   - the vocabulary is exactly `verified | partial | inconclusive |
 *     not-installable`. There is no score, no percentage and no letter grade,
 *     because a ranking is what made the existing signal untrustworthy;
 *   - the SVG carries a `<title>` with the not-an-endorsement disclaimer, so
 *     the text travels even when the image is the only thing rendered;
 *   - it links to the report, which is where the evidence is.
 *
 * Everything interpolated is escaped. Report content derives from third-party
 * package metadata, and "it is only a badge" is not a reason to emit markup
 * unescaped.
 */

export const BADGE_VOCABULARY = ['verified', 'partial', 'inconclusive', 'not-installable'] as const;

export type BadgeVerdict = (typeof BADGE_VOCABULARY)[number];

export function hasHistoricalMethod(generatedAt: unknown): boolean {
  return typeof generatedAt === 'string' && generatedAt < '2026-10-04T00:00:00.000Z';
}

/**
 * Colour by verdict only. Deliberately not a gradient or a scale: four states,
 * four colours, no implication that `verified` is "better" than `partial` —
 * they say how much ran, not how good the plugin is.
 */
export const BADGE_COLORS: Record<BadgeVerdict, string> = {
  verified: '#1f883d',
  partial: '#bf8700',
  inconclusive: '#6e7781',
  'not-installable': '#cf222e',
};

const DISCLAIMER =
  'Verification is not a security audit and not an endorsement. It records what was executed and observed on one machine at one time.';

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Approximate advance width for 11px DejaVu Sans, the font badge renderers assume. */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += /[iIl1.,:;|' ]/.test(char) ? 4 : /[A-Z@%]/.test(char) ? 8.5 : 7;
  }
  return Math.ceil(width);
}

export function isBadgeVerdict(value: string): value is BadgeVerdict {
  return (BADGE_VOCABULARY as readonly string[]).includes(value);
}

export interface BadgeOptions {
  /** Left-hand label. Defaults to `dsh plugin`. */
  label?: string;
  /** Where the badge points. Omitted when the badge is embedded as an image. */
  href?: string;
  /** Extra context for the tooltip, e.g. the exact name@version. */
  subject?: string;
  /** The report predates the network-isolation correction. */
  historicalMethod?: boolean;
}

/**
 * A flat, dependency-free shields-style badge. The verdict is the only thing
 * that varies by colour, and an unknown verdict is rendered as `inconclusive`
 * rather than being invented.
 */
export function renderBadge(verdict: string, options: BadgeOptions = {}): string {
  const label = options.label ?? 'dsh plugin';
  const state: BadgeVerdict = isBadgeVerdict(verdict) ? verdict : 'inconclusive';
  const message = state;
  const colour = BADGE_COLORS[state];

  const labelWidth = textWidth(label) + 10;
  const messageWidth = textWidth(message) + 10;
  const totalWidth = labelWidth + messageWidth;

  const historicalNote = options.historicalMethod
    ? ' Historical method limitation: this execution had network access and published container paths and replay fixture text.'
    : '';
  const tooltip =
    state === 'inconclusive' && !isBadgeVerdict(verdict)
      ? `dsh-verified: unknown verdict ${JSON.stringify(verdict)}`
      : `dsh-verified: ${state}${options.subject ? ` — ${options.subject}` : ''}. ${DISCLAIMER}${historicalNote}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(`${label}: ${message}${options.historicalMethod ? '; historical method limitation' : ''}`)}">
  <title>${escapeXml(tooltip)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${colour}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="14">${escapeXml(label)}</text>
    <text x="${labelWidth + messageWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${escapeXml(message)}</text>
  </g>
</svg>
`;

  return options.href ? `<a href="${escapeXml(options.href)}">${svg}</a>` : svg;
}
