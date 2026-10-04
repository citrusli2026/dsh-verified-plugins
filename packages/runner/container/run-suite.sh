#!/usr/bin/env bash
# run-suite.sh — verify a batch of subjects.
#
# For each spec: static (L0+L4) on the host, execution (L1+L2+L3+L5+L6) in a
# one-off container, then the merge that produces the published report.
#
# Cost control, which is V4's subject:
#   * one networked fetch container and one offline execution container per
#     subject, both discarded, with a store used by no other subject;
#   * a per-subject wall-clock ceiling, so one pathological subject cannot hold
#     the batch;
#   * a failure on one subject does not abort the others — it is recorded and
#     the batch continues;
#   * per-subject wall time is emitted, so the cost of a batch is measured
#     rather than assumed.
#
# No credential is used or passed to any container. Subjects are installed only
# inside the container, which is discarded afterwards.
#
# Runs on a Docker-capable host (the GitHub runner).
#
# Usage: run-suite.sh <spec,spec,...> [out-root]

set -uo pipefail

SPECS="${1:?usage: run-suite.sh <spec,spec,...> [out-root]}"
OUTROOT="${2:-.verify/reports}"
IMAGE="${IMAGE:-dsh-verifier:local}"
PER_SUBJECT_TIMEOUT_S="${PER_SUBJECT_TIMEOUT_S:-420}"

mkdir -p "$OUTROOT"
: > "$OUTROOT/timings.tsv"

IFS=',' read -ra LIST <<< "$SPECS"
TOTAL=0
for raw in "${LIST[@]}"; do
  [ -n "$(printf '%s' "$raw" | tr -d '[:space:]')" ] && TOTAL=$((TOTAL + 1))
done

echo "suite: $TOTAL subject(s), image=$IMAGE, per-subject ceiling ${PER_SUBJECT_TIMEOUT_S}s"
IMAGE_ID=$(docker image inspect "$IMAGE" --format '{{.Id}}') || exit 1
FAILED=0
DONE=0

print_excerpt() {
  node --input-type=module - "$1" <<'NODE'
import { readFileSync } from 'node:fs';
import { makeExcerpt } from './packages/report/src/redact.ts';
const bytes = readFileSync(process.argv[2]);
const tail = new TextDecoder().decode(bytes.subarray(-2048));
const excerpt = makeExcerpt(tail, {
  paths: [
    { from: process.cwd(), to: '<work>' },
    { from: '/work', to: '<work>' },
    { from: '/home/verifier', to: '<home>' },
  ],
  maxBytes: 2048,
});
process.stdout.write(`${excerpt.text}\n`);
NODE
}

for raw in "${LIST[@]}"; do
  spec="$(printf '%s' "$raw" | tr -d '[:space:]')"
  [ -z "$spec" ] && continue
  DONE=$((DONE + 1))
  slug="$(printf '%s' "$spec" | tr '@/' '__')"
  dir="$OUTROOT/$slug"
  mkdir -p "$dir"

  started=$(date +%s)
  echo "── [$DONE/$TOTAL] $spec"

  if ! node packages/cli/src/main.ts static "$spec" --out "$dir/static.json" >"$dir/static.log" 2>&1; then
    echo "   static FAILED — see $dir/static.log"
    FAILED=$((FAILED + 1))
    printf '%s\tstatic-failed\t%s\n' "$spec" "$(( $(date +%s) - started ))" >> "$OUTROOT/timings.tsv"
    continue
  fi

  # L0 pre-filter: an absent bundle or missing patch cannot be composed.
  # Installing it would measure the absence of the subject, not its behaviour.
  l0_status=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).dimensions.L0_qualification.status" "$dir/static.json" 2>/dev/null || echo inconclusive)
  if [ "$l0_status" != "pass" ]; then
    cp "$dir/static.json" "$dir/report.json"
    secs=$(( $(date +%s) - started ))
    echo "   -> L0 $l0_status; no container started (${secs}s)"
    printf '%s\tL0-%s\t%s\n' "$spec" "$l0_status" "$secs" >> "$OUTROOT/timings.tsv"
    continue
  fi

  # Never pass a tag or range into either phase. The static fetch resolved and
  # hashed an exact artifact; execution must target that same name@version.
  exact_spec=$(node -p "const s=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).subject; s.name+'@'+s.version" "$dir/static.json")

  # Resolve and download without executing the subject. The cache belongs to
  # this subject only and is removed before artifacts are uploaded.
  cachevol="dsh-verify-cache-${GITHUB_RUN_ID:-local}-$$-$DONE"
  docker volume create "$cachevol" >/dev/null
  docker run --rm --network none --user root --entrypoint /bin/chown \
    -v "$cachevol:/work/cache" "$IMAGE" 10001:10001 /work/cache >/dev/null
  deadline=$((started + PER_SUBJECT_TIMEOUT_S))
  remaining=$((deadline - $(date +%s)))
  if [ "$remaining" -le 0 ] || ! timeout --signal=KILL "$remaining" docker run --rm \
    --entrypoint /bin/bash \
    -e XDG_CACHE_HOME=/work/cache/xdg \
    -v "$PWD/packages/runner/container/prefetch.sh:/work/prefetch.sh:ro" \
    -v "$cachevol:/work/cache" \
    "$IMAGE" /work/prefetch.sh "$exact_spec" "${DSH_VERSION:-0.2.0-rc.2}" \
    >"$dir/prefetch.log" 2>&1; then
    echo "   prefetch BLOCKED — see $dir/prefetch.log"
    print_excerpt "$dir/prefetch.log"
    docker volume rm -f "$cachevol" >/dev/null
    FAILED=$((FAILED + 1))
    printf '%s\tprefetch-blocked\t%s\n' "$spec" "$(( $(date +%s) - started ))" >> "$OUTROOT/timings.tsv"
    continue
  fi

  remaining=$((deadline - $(date +%s)))
  if [ "$remaining" -le 0 ]; then
    echo "   subject ceiling reached before execution"
    docker volume rm -f "$cachevol" >/dev/null
    FAILED=$((FAILED + 1))
    printf '%s\ttimeout\t%s\n' "$spec" "$(( $(date +%s) - started ))" >> "$OUTROOT/timings.tsv"
    continue
  fi

  # The subject can execute only here, with Docker's network namespace absent.
  cname="suite-$DONE"
  docker rm -f "$cname" >/dev/null 2>&1 || true
  timeout --signal=KILL "$remaining" docker run --name "$cname" --network none --entrypoint node \
    -e npm_config_offline=true \
    -e npm_config_store_dir=/work/cache/store \
    -e XDG_CACHE_HOME=/work/cache/xdg \
    -e COREPACK_DEFAULT_TO_LATEST=0 \
    -e COREPACK_ENABLE_NETWORK=0 \
    -e "PROBE_SPEC=$exact_spec" \
    -e "OUT_DIR=/work/out/exec" \
    -e "SAMPLER_PATH=/work/host-sampler.mjs" \
    -e "L3_OVERLAY=/work/fixtures/replay/l3-overlay.yml" \
    -v "$PWD/packages/runner/src/execution-probe.ts:/work/execution-probe.ts:ro" \
    -v "$PWD/packages/runner/src/host-sampler.mjs:/work/host-sampler.mjs:ro" \
    -v "$PWD/packages/runner/fixtures:/work/fixtures:ro" \
    -v "$cachevol:/work/cache" \
    "$IMAGE" /work/execution-probe.ts "$exact_spec" >"$dir/execution.log" 2>&1
  docker cp "$cname:/work/out/exec/execution.json" "$dir/execution.json" >/dev/null 2>&1
  docker rm -f "$cname" >/dev/null 2>&1 || true
  docker volume rm -f "$cachevol" >/dev/null

  if [ ! -f "$dir/execution.json" ]; then
    echo "   execution produced no result — see $dir/execution.log"
    print_excerpt "$dir/execution.log"
    FAILED=$((FAILED + 1))
    printf '%s\texecution-failed\t%s\n' "$spec" "$(( $(date +%s) - started ))" >> "$OUTROOT/timings.tsv"
    continue
  fi

  if ! VERIFIER_IMAGE="$IMAGE" VERIFIER_IMAGE_DIGEST="$IMAGE_ID" \
        node packages/cli/src/main.ts merge "$dir/static.json" "$dir/execution.json" \
        --out "$dir/report.json" >>"$dir/merge.log" 2>&1; then
    echo "   merge FAILED — see $dir/merge.log"
    FAILED=$((FAILED + 1))
    printf '%s\tmerge-failed\t%s\n' "$spec" "$(( $(date +%s) - started ))" >> "$OUTROOT/timings.tsv"
    continue
  fi

  if ! node packages/cli/src/main.ts validate "$dir/report.json" >>"$dir/merge.log" 2>&1; then
    echo "   the merged report failed its own schema — see $dir/merge.log"
    FAILED=$((FAILED + 1))
  fi

  secs=$(( $(date +%s) - started ))
  verdict=$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).verdict" "$dir/report.json" 2>/dev/null || echo unknown)
  echo "   -> $verdict in ${secs}s"
  printf '%s\t%s\t%s\n' "$spec" "$verdict" "$secs" >> "$OUTROOT/timings.tsv"
done

echo
echo "suite complete: $((TOTAL - FAILED))/$TOTAL succeeded"
echo "cost, slowest first (spec, verdict, seconds):"
sort -t$'\t' -k3 -nr "$OUTROOT/timings.tsv" | head -20

[ "$FAILED" -eq 0 ]
