/**
 * watcher-acceptance.mjs — V3's acceptance test.
 *
 * The specification's acceptance criterion is: reproduce a recursive-watcher
 * plugin and catch the watcher anomaly reliably. This does that with two
 * controlled hosts rather than a real plugin — a fixture, because a real
 * recursive watcher is third-party code and this workspace holds credentials
 * (docs/security.md § 5).
 *
 *   1. baseline   — an idle host
 *   2. activated  — a host holding many filesystem watchers, the shape of the
 *                   failure the specification cites (a plugin watching the
 *                   workspace recursively)
 *
 * It asserts that the detector *fires*, which is the property that matters. A
 * metric that reads zero because the handle was spelled wrong would pass a
 * "did it run" check and fail this one.
 *
 * Usage: node tools/acceptance/watcher.mjs
 * Exit:  0 when the anomaly is caught, 1 when it is not.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Lives under tools/ rather than packages/runner/ on purpose: the workflow policy
// treats the runner package as plugin-executing code, and this test executes
// nothing but a fixture this repository authored.
const SAMPLER = join(HERE, '..', '..', 'packages', 'runner', 'src', 'host-sampler.mjs');
const RUNS = 3;
const WATCHER_DIRS = 60;

const work = mkdtempSync(join(tmpdir(), 'watcher-acceptance-'));
const tree = join(work, 'tree');
for (let i = 0; i < WATCHER_DIRS; i++) mkdirSync(join(tree, `d${i}`), { recursive: true });

/** One sampled run of an arbitrary node program. */
function sample(label, run, script) {
  const out = join(work, `${label}-${run}.json`);
  const t0 = Date.now();
  spawnSync(process.execPath, ['--import', SAMPLER, '-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      SAMPLE_OUT: out,
      SAMPLER_T0: String(t0),
      SAMPLE_SETTLE_MS: '600',
      SAMPLE_COUNT: '4',
      SAMPLE_INTERVAL_MS: '250',
      WATCHER_TREE: tree,
      WATCHER_DIRS: String(WATCHER_DIRS),
    },
  });
  if (!existsSync(out)) return null;
  const parsed = JSON.parse(readFileSync(out, 'utf8'));
  const values = parsed.samples.map((s) => s.watchers).filter((v) => typeof v === 'number');
  values.sort((a, b) => a - b);
  return values.length === 0 ? null : values[Math.floor(values.length / 2)];
}

const IDLE = 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 4000);';

const WATCHING = `
  const fs = require('node:fs');
  const path = require('node:path');
  const tree = process.env.WATCHER_TREE;
  const n = Number(process.env.WATCHER_DIRS);
  const handles = [];
  for (let i = 0; i < n; i++) handles.push(fs.watch(path.join(tree, 'd' + i), () => {}));
  setTimeout(() => { for (const h of handles) h.close(); process.exit(0); }, 4000);
`;

function median(values) {
  const ok = values.filter((v) => typeof v === 'number');
  if (ok.length === 0) return null;
  const sorted = [...ok].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const baseline = median(Array.from({ length: RUNS }, (_, i) => sample('baseline', i, IDLE)));
const activated = median(Array.from({ length: RUNS }, (_, i) => sample('activated', i, WATCHING)));

rmSync(work, { recursive: true, force: true });

// The same rule the probe applies: at least doubled and up by 5 or more, or up
// by 10 or more outright.
const fired =
  baseline !== null &&
  activated !== null &&
  ((activated >= baseline * 2 && activated - baseline >= 5) || activated - baseline >= 10);

process.stdout.write(
  [
    `watcher-acceptance: baseline median=${baseline} activated median=${activated} (${RUNS} runs, ${WATCHER_DIRS} watched dirs)`,
    `rule fired: ${fired}`,
    fired ? 'OK: the watcher anomaly is caught' : 'FAIL: the watcher anomaly was NOT caught',
    '',
  ].join('\n'),
);

process.exit(fired ? 0 : 1);
