#!/usr/bin/env bash
# run-baseline.sh — V0 acceptance harness. Runs on a Docker-capable host
# (GitHub Actions ubuntu runner), NOT in this workspace: there is no container
# runtime here, so the container is validated in CI.
#
# It measures exactly what V0 requires:
#   * container image size
#   * cold start (median of 3, network fully denied)
#   * the fixed overhead of the `dsh plugin add` path on an empty profile
#   * that the image is self-contained: `dsh --version` works with NO network
#
# It holds no credentials and passes none into the container.
#
# Usage: packages/runner/container/run-baseline.sh [out-dir]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CTX="$ROOT/packages/runner/container"
OUT="${1:-$ROOT/.verify/baseline}"
DSH_VERSION="${DSH_VERSION:-0.2.0-rc.2}"
IMAGE="dsh-verifier:${DSH_VERSION}"

mkdir -p "$OUT"
# Docker bind mounts want an absolute path; a relative one resolves against the
# daemon's cwd, not ours.
OUT="$(cd "$OUT" && pwd)"

now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

echo "== building $IMAGE (fetch phase: network on, no plugin code runs) =="
docker build --build-arg "DSH_VERSION=$DSH_VERSION" -t "$IMAGE" "$CTX" | tail -3

IMAGE_SIZE_BYTES="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
IMAGE_ID="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
IMAGE_DIGESTS="$(docker image inspect "$IMAGE" --format '{{join .RepoDigests ","}}' || true)"

echo "== cold start, network denied, median of 3 =="
: > "$OUT/cold-start-ms.txt"
for _ in 1 2 3; do
  start="$(now_ms)"
  docker run --rm --network none "$IMAGE" /dev/null >/dev/null 2>&1
  end="$(now_ms)"
  echo "$((end - start))" >> "$OUT/cold-start-ms.txt"
done
cat "$OUT/cold-start-ms.txt"

echo "== offline baseline (network denied; install MUST fail) =="
# Output travels on stdout rather than through a bind mount: the container runs
# as uid 10001 and a host-owned mount is not writable by it, so a mounted
# write would fail and suppress the very output we are collecting.
# Exit codes are captured rather than propagated: a failed phase must still
# leave evidence behind, not abort the run with nothing to show.
set +e
docker run --rm --network none \
  "$IMAGE" /work/baseline.ts --offline > "$OUT/offline.json" 2> "$OUT/offline.stderr.txt"
echo "$?" > "$OUT/offline-rc.txt"
set -e
echo "offline container rc=$(cat "$OUT/offline-rc.txt") stdout=$(wc -c < "$OUT/offline.json") bytes"

echo "== online baseline (registry reachable; install is timed) =="
set +e
docker run --rm \
  "$IMAGE" /work/baseline.ts --online > "$OUT/online.json" 2> "$OUT/online.stderr.txt"
echo "$?" > "$OUT/online-rc.txt"
set -e
echo "online container rc=$(cat "$OUT/online-rc.txt") stdout=$(wc -c < "$OUT/online.json") bytes"

echo "== assembling V0 report =="
node - "$OUT" "$IMAGE" "$DSH_VERSION" "$IMAGE_SIZE_BYTES" "$IMAGE_ID" "$IMAGE_DIGESTS" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [out, image, dshVersion, sizeBytes, imageId, imageDigests] = process.argv.slice(2);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); } catch { return null; } };
const cold = fs.readFileSync(path.join(out, 'cold-start-ms.txt'), 'utf8')
  .split('\n').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
const median = cold.length ? cold[Math.floor(cold.length / 2)] : null;

const offline = readJson('offline.json');
const online = readJson('online.json');
const readRc = (f) => { try { return Number(fs.readFileSync(path.join(out, f), 'utf8').trim()); } catch { return null; } };

const report = {
  schema: 'dsh.verifier.container-baseline.v1',
  generatedAt: new Date().toISOString(),
  image: {
    tag: image,
    dshVersion,
    sizeBytes: Number(sizeBytes),
    sizeMiB: Number((Number(sizeBytes) / 1048576).toFixed(1)),
    imageId,
    repoDigests: imageDigests ? imageDigests.split(',').filter(Boolean) : [],
  },
  coldStartMs: { samples: cold, median },
  // Exit codes of the container runs themselves. A non-zero rc with empty
  // stdout means the harness failed, which is distinct from a plugin failing.
  containerExitCodes: { offline: readRc('offline-rc.txt'), online: readRc('online-rc.txt') },
  offline,
  online,
  acceptance: {
    offlineHarnessRan: offline !== null,
    onlineHarnessRan: online !== null,
    offlineSelfContained: offline?.measurements?.['dsh-version']?.exitCode === 0,
    offlineInstallDenied: offline
      ? offline.measurements?.['plugin-add-must-be-denied']?.exitCode !== 0
      : false,
    onlineInstallOk: online?.measurements?.['plugin-add-baseline']?.exitCode === 0,
    coldStartUnder10s: median !== null && median < 10_000,
  },
};

fs.writeFileSync(path.join(out, 'v0-baseline.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.acceptance, null, 2));
console.log(`\nsize=${report.image.sizeMiB} MiB  coldStartMedian=${median} ms`);
console.log(`offline add exit=${offline?.measurements?.['plugin-add-must-be-denied']?.exitCode}  online add ms=${online?.measurements?.['plugin-add-baseline']?.ms}`);
NODE

echo "== wrote $OUT/v0-baseline.json =="
