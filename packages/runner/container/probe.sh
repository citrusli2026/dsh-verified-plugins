#!/usr/bin/env bash
# probe.sh — reconnaissance inside the verification container.
#
# This is NOT the verifier. It answers the questions the execution dimensions
# (L1/L2/L5/L6) depend on, by running the real CLI in the real container and
# dumping what actually happens. Writing the runner against assumptions about a
# pre-1.0 internal boot API would be guesswork; this replaces guessing with logs.
#
# It runs third-party code (it installs a subject), so it lives in the
# maintainer-triggered verify workflow only. See docs/security.md.
#
# Usage: probe.sh <spec> [out-dir]

set -uo pipefail

SPEC="${1:-dsh-find-plugin@0.4.0}"
OUT="${2:-/work/out/probe}"
BOOT_BOUND_S=25

mkdir -p "$OUT"
export DSH_HOME="${DSH_HOME:-/tmp/probe-home}"
mkdir -p "$DSH_HOME"

# Never inherit CI tokens into a step that runs third-party code.
unset GITHUB_TOKEN GH_TOKEN ACTIONS_RUNTIME_TOKEN \
      ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL 2>/dev/null || true

run() { # run <label> <seconds> <cmd...>
  local label="$1" bound="$2"; shift 2
  {
    echo "### cwd=$(pwd)"
    echo "### cmd: $*"
    echo "### bound: ${bound}s"
  } > "$OUT/$label.txt"
  timeout --signal=KILL "$bound" "$@" >> "$OUT/$label.txt" 2>&1
  echo "### exit=$?" >> "$OUT/$label.txt"
}

echo "== environment ==" | tee "$OUT/summary.txt"
node --version | tee -a "$OUT/summary.txt"
run version 30 dsh --version
cat "$OUT/version.txt" | tail -3 | tee -a "$OUT/summary.txt"

# 1. What commands does this CLI version actually expose?
run help 30 dsh --help

# 2. L1 shape: install a subject into a throwaway profile.
run l1-add 240 dsh plugin --profile probe add "$SPEC"
echo "-- l1-add tail --" | tee -a "$OUT/summary.txt"
tail -25 "$OUT/l1-add.txt" | tee -a "$OUT/summary.txt"

# 3. What did the profile end up looking like?
{
  echo "### profile dir listing"
  ls -la "$DSH_HOME/profiles/probe" 2>&1
  echo "### package.json"
  cat "$DSH_HOME/profiles/probe/package.json" 2>&1
  echo "### cordis.patch.yml"
  cat "$DSH_HOME/profiles/probe/cordis.patch.yml" 2>&1
} > "$OUT/l1-profile.txt" 2>&1

# 4. L2 shape (a): what does the composed configuration contain?
run l2-dump-config 120 dsh --profile probe --dump-config

# 5. L2 shape (b): a bounded real boot. A plugin that fails to load exits before
#    the runner mounts; a successful boot has nothing to say and waits, so the
#    bound is the observation.
run l2-boot 25 dsh --profile probe
echo "-- l2-boot tail --" | tee -a "$OUT/summary.txt"
tail -20 "$OUT/l2-boot.txt" | tee -a "$OUT/summary.txt"

# 6. L6 shape: removal, then residue.
run l6-remove 180 dsh plugin --profile probe remove dsh-find-plugin
{
  echo "### profile dir after removal"
  ls -la "$DSH_HOME/profiles/probe" 2>&1
  echo "### package.json after removal"
  cat "$DSH_HOME/profiles/probe/package.json" 2>&1
  echo "### node_modules present?"
  ls "$DSH_HOME/profiles/probe/node_modules" 2>&1 | head -20
} > "$OUT/l6-residue.txt" 2>&1

# 7. L3 feasibility: can the official keyless replay plugin be installed at all?
#    Its declared peers cannot be satisfied (see docs/evidence/V0.md F2), so this
#    records the actual resolver behaviour rather than restating the analysis.
run l3-replay-view 60 npm view @deepseek-ai/dsh-llm-replay peerDependencies version
run l3-replay-add 180 dsh plugin --profile replay add @deepseek-ai/dsh-llm-replay

echo "== probe complete ==" | tee -a "$OUT/summary.txt"
ls -la "$OUT" | tee -a "$OUT/summary.txt"
