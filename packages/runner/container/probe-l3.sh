#!/usr/bin/env bash
# probe-l3.sh — reconnaissance for L3 (a keyless session).
#
# Earlier the project concluded L3 was blocked because the official replay
# plugin could not be installed. That conclusion was reached against the version
# npm's `latest` tag points at (0.0.1-rc.1), which belongs to a much older
# runtime generation. The version matching the pinned runtime is published under
# `next`. This probe tests the correct version, by exact version, and dumps what
# actually happens.
#
# Runs third-party code (it installs a subject), so it lives in the
# maintainer-triggered workflow only.

set -uo pipefail

OUT="${1:-/work/out/l3}"
mkdir -p "$OUT"
export DSH_HOME="${DSH_HOME:-/tmp/l3-home}"
mkdir -p "$DSH_HOME"

unset GITHUB_TOKEN GH_TOKEN ACTIONS_RUNTIME_TOKEN \
      ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL 2>/dev/null || true

run() { # run <label> <seconds> <cmd...>
  local label="$1" bound="$2"; shift 2
  { echo "### cmd: $*"; echo "### bound: ${bound}s"; } > "$OUT/$label.txt"
  timeout --signal=KILL "$bound" "$@" >> "$OUT/$label.txt" 2>&1
  echo "### exit=$?" >> "$OUT/$label.txt"
}

echo "== L3 reconnaissance ==" | tee "$OUT/summary.txt"
run version 30 dsh --version
tail -3 "$OUT/version.txt" | tee -a "$OUT/summary.txt"

# 1. Install the correctly-versioned replay plugin.
run l3-add-replay 240 dsh plugin --profile l3 add "@deepseek-ai/dsh-llm-replay@0.2.0-rc.2"
echo "-- l3-add-replay tail --" | tee -a "$OUT/summary.txt"
tail -20 "$OUT/l3-add-replay.txt" | tee -a "$OUT/summary.txt"

# 2. Did its peers pass, and what did the profile end up selecting?
{
  echo "### package.json"
  cat "$DSH_HOME/profiles/l3/package.json" 2>&1
  echo "### compatibility.json (exemptions; should be absent — none was granted)"
  cat "$DSH_HOME/profiles/l3/compatibility.json" 2>&1
} > "$OUT/l3-profile.txt" 2>&1

# 3. Does the composed configuration contain the replay plugin?
run l3-dump-config 120 dsh --profile l3 --dump-config
grep -n "llm-replay" "$OUT/l3-dump-config.txt" | head -5 | tee -a "$OUT/summary.txt"

# 4. Can a headless profile be created from the shipped template, and what
#    bundles does it select? L3 needs an agent loop, not just an adapter.
run l3-headless-template 120 dsh --profile l3h --from-default-profile headless
{
  echo "### l3h package.json"
  cat "$DSH_HOME/profiles/l3h/package.json" 2>&1
} > "$OUT/l3-headless.txt" 2>&1
tail -20 "$OUT/l3-headless.txt" | tee -a "$OUT/summary.txt"

# 5. What CLI flags does this version actually accept for profile boot?
run l3-help 30 dsh --help
grep -nE "profile|from-default|dump-config|json|patch" "$OUT/l3-help.txt" | head -20 | tee -a "$OUT/summary.txt"

ls -la "$OUT" | tee -a "$OUT/summary.txt"
echo "== done ==" | tee -a "$OUT/summary.txt"
