/**
 * host-sampler.mjs — injected into the process under test.
 *
 * `process.getActiveResourcesInfo()`, `process.report.getReport()` and
 * `process.memoryUsage()` describe *their own* process. Sampling the host from
 * outside would measure the wrong thing, so this module is loaded into the dsh
 * process itself through NODE_OPTIONS=--import.
 *
 * It is plain .mjs on purpose: the container has no build step, and this file
 * must load under whatever the host's module pipeline does with it.
 *
 * Deliverable is deliberately observable-hostile: it measures, writes one JSON
 * file, and exits. It never changes the host's behaviour beyond existing.
 */

import { closeSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';

const OUT = process.env.SAMPLE_OUT ?? '';
const T0 = Number(process.env.SAMPLER_T0 ?? Date.now());
const SETTLE_MS = Number(process.env.SAMPLE_SETTLE_MS ?? 6000);
const COUNT = Number(process.env.SAMPLE_COUNT ?? 5);
const INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS ?? 1000);

if (OUT === '') {
  // Nothing to do, but never break the host.
  process.exit(0);
}

// NODE_OPTIONS is inherited, so this module also loads in every Node child the
// host spawns. Only the first process to claim the lock samples; children exit
// quietly instead of overwriting the sample file.
const LOCK = `${OUT}.lock`;
try {
  closeSync(openSync(LOCK, 'wx'));
} catch {
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts open descriptors without a native dependency. */
function fdCount() {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null;
  }
}

/**
 * libuv's own view of the loop.
 *
 * The shape is an ARRAY of handle objects in the JSON report, not an object
 * with `.handle.count`. Assuming the latter silently produced null for every
 * run, which is how a metric can look "measured" while carrying no data; both
 * shapes are handled so a Node change cannot quietly reintroduce that.
 */
function libuv() {
  try {
    const report = process.report.getReport();
    const section = report.libuv;

    if (Array.isArray(section)) {
      const handleTypes = {};
      let activeHandles = 0;
      for (const handle of section) {
        const type = handle?.type ?? 'unknown';
        handleTypes[type] = (handleTypes[type] ?? 0) + 1;
        if (handle?.is_active) activeHandles += 1;
      }
      return { handles: section.length, activeHandles, handleTypes, requests: null };
    }

    const types = section?.handle?.types ?? {};
    return {
      handles: section?.handle?.count ?? null,
      activeHandles: null,
      handleTypes: Object.fromEntries(Object.entries(types).filter(([, count]) => count > 0)),
      requests: section?.request?.count ?? null,
    };
  } catch {
    return { handles: null, activeHandles: null, handleTypes: {}, requests: null };
  }
}

/** Active resources by kind, e.g. { Timeout: 3, TCPSocketWrap: 1 }. */
function activeResources() {
  try {
    const kinds = {};
    for (const kind of process.getActiveResourcesInfo()) {
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return { total: process.getActiveResourcesInfo().length, kinds };
  } catch {
    return { total: null, kinds: {} };
  }
}

function watcherCount(kinds) {
  // libuv filesystem watchers surface as FSEvent / StatWatcher depending on
  // platform; both mean "the process is watching the filesystem".
  return (kinds.FSEvent ?? 0) + (kinds.StatWatcher ?? 0);
}

function timerCount(kinds) {
  return kinds.Timeout ?? 0;
}

function sample() {
  const memory = process.memoryUsage();
  const resources = activeResources();
  const loop = libuv();
  return {
    atMs: Date.now() - T0,
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    activeTotal: resources.total,
    activeKinds: resources.kinds,
    watchers: watcherCount(resources.kinds),
    timers: timerCount(resources.kinds),
    libuvHandles: loop.handles,
    libuvActiveHandles: loop.activeHandles,
    libuvHandleTypes: loop.handleTypes,
    libuvRequests: loop.requests,
    fds: fdCount(),
  };
}

async function main() {
  const samples = [];
  await sleep(SETTLE_MS);
  for (let i = 0; i < COUNT; i++) {
    samples.push(sample());
    if (i < COUNT - 1) await sleep(INTERVAL_MS);
  }

  const payload = {
    schema: 'dsh.verifier.host-sample.v1',
    pid: process.pid,
    nodeVersion: process.version,
    settleMs: SETTLE_MS,
    count: COUNT,
    intervalMs: INTERVAL_MS,
    firstSampleAtMs: samples[0]?.atMs ?? null,
    samples,
  };

  try {
    writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // A failed write must not be reported as a host failure.
  }
  try {
    unlinkSync(LOCK);
  } catch {
    // Leaving the lock behind is harmless: every run uses its own output name.
  }
  // Exit deliberately so a sample run is bounded and comparable between the
  // baseline and the activated pass.
  process.exit(0);
}

main().catch(() => process.exit(0));
