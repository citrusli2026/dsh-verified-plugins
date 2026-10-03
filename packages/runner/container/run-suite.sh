#!/usr/bin/env bash
# run-suite.sh — verify a batch of subjects.
#
# For each spec: static (L0+L4) on the host, execution (L1+L2+L3+L5+L6) in a
# one-off container, then the merge that produces the published report.
#
# Cost control, which is V4's subject:
#   * one container per subject, always discarded, never reused;
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
FAILED=0
DONE=0

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

  # L0 pre-filter: a package with no bundle declaration is not a plugin. It
  # still installs — as a plain dependency that is never composed — so running
  # the execution dimensions would burn a container to measure the absence of
  # the subject, and report it as a pass. The static report is already a valid
  # final report for this case.
  declares=$(node -p "const r=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')); (r.dimensions.L0_qualification.metrics?.patchPaths ?? []).length" "$dir/static.json" 2>/dev/null || echo 1)
  if [ "$declares" = "0" ]; then
    cp "$dir/static.json" "$dir/report.json"
    secs=$(( $(date +%s) - started ))
    echo "   -> not a bundle; L0 pre-filtered, no container started (${secs}s)"
    printf '%s\tnot-a-bundle\t%s\n' "$spec" "$secs" >> "$OUTROOT/timings.tsv"
    continue
  fi

  # One container, one subject, discarded. Mounts are read-only.
  cname="suite-$DONE"
  docker rm -f "$cname" >/dev/null 2>&1 || true
  timeout --signal=KILL "$PER_SUBJECT_TIMEOUT_S" docker run --name "$cname" --entrypoint node \
    -e "PROBE_SPEC=$spec" \
    -e "OUT_DIR=/work/out/exec" \
    -e "SAMPLER_PATH=/work/host-sampler.mjs" \
    -e "L3_OVERLAY=/work/fixtures/replay/l3-overlay.yml" \
    -v "$PWD/packages/runner/src/execution-probe.ts:/work/execution-probe.ts:ro" \
    -v "$PWD/packages/runner/src/host-sampler.mjs:/work/host-sampler.mjs:ro" \
    -v "$PWD/packages/runner/fixtures:/work/fixtures:ro" \
    "$IMAGE" /work/execution-probe.ts "$spec" >"$dir/execution.log" 2>&1
  docker cp "$cname:/work/out/exec/execution.json" "$dir/execution.json" >/dev/null 2>&1
  docker rm -f "$cname" >/dev/null 2>&1 || true

  if [ ! -f "$dir/execution.json" ]; then
    echo "   execution produced no result — see $dir/execution.log"
    FAILED=$((FAILED + 1))
    printf '%s\texecution-failed\t%s\n' "$spec" "$(( $(date +%s) - started ))" >> "$OUTROOT/timings.tsv"
    continue
  fi

  if ! node packages/cli/src/main.ts merge "$dir/static.json" "$dir/execution.json" \
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
