#!/usr/bin/env bash
# probe-l3-run.sh — attempt an actual keyless session.
#
# Creates a headless profile, installs the correctly-versioned official replay
# adapter, mounts it by overlay, and drives one task through it. Uses no
# credential of any kind.
#
# The recorded script is a fixture authored in this repository
# (packages/runner/fixtures/replay/session.replay.json), not a recording of
# anyone's session.
#
# Runs third-party-capable machinery, so it lives in the maintainer-triggered
# workflow only.

set -uo pipefail

OUT="${1:-/work/out/l3run}"
mkdir -p "$OUT"
export DSH_HOME="${DSH_HOME:-/tmp/l3run-home}"
mkdir -p "$DSH_HOME"

unset GITHUB_TOKEN GH_TOKEN ACTIONS_RUNTIME_TOKEN \
      ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL 2>/dev/null || true

FIXTURE=/work/fixtures/replay/session.replay.json
OVERLAY=/work/fixtures/replay/l3-overlay.yml
PROFILE=l3run

run() { # run <label> <seconds> <cmd...>
  local label="$1" bound="$2"; shift 2
  { echo "### cmd: $*"; echo "### bound: ${bound}s"; } > "$OUT/$label.txt"
  timeout --signal=KILL "$bound" "$@" >> "$OUT/$label.txt" 2>&1
  echo "### exit=$?" >> "$OUT/$label.txt"
}

echo "== L3 run attempt ==" | tee "$OUT/summary.txt"
run version 30 dsh --version

# 1. A headless profile: the agent loop is what has to be driven.
run profile 60 dsh --profile "$PROFILE" --from-default-profile headless
cat "$DSH_HOME/profiles/$PROFILE/package.json" > "$OUT/profile-package.txt" 2>&1

# 2. The official adapter, at the version matching the pinned runtime.
run install 240 dsh plugin --profile "$PROFILE" add "@deepseek-ai/dsh-llm-replay@0.2.0-rc.2"
tail -6 "$OUT/install.txt" | tee -a "$OUT/summary.txt"

# 3. Is the replay row actually composed? A dependency that is not a bundle does
#    not appear in the tree unless the overlay inserts it.
run dump 120 dsh --profile "$PROFILE" --patch "$OVERLAY" --dump-config
grep -n "llm-replay" "$OUT/dump.txt" | head -3 | tee -a "$OUT/summary.txt"

# 4. The session itself. --json projects a newline-delimited event stream; the
#    task is a positional argument to the headless app.
run session-json 120 dsh --profile "$PROFILE" --patch "$OVERLAY" --json "reply with any text"
echo "-- session-json tail --" | tee -a "$OUT/summary.txt"
tail -30 "$OUT/session-json.txt" | tee -a "$OUT/summary.txt"

# 5. The same without --json, in case the projection is what fails.
run session-plain 120 dsh --profile "$PROFILE" --patch "$OVERLAY" "reply with any text"
echo "-- session-plain tail --" | tee -a "$OUT/summary.txt"
tail -20 "$OUT/session-plain.txt" | tee -a "$OUT/summary.txt"

# 6. Whatever the session wrote to the log, if anything.
if [ -d "$DSH_HOME/sessions" ]; then
  find "$DSH_HOME/sessions" -name '*.jsonl' -exec cp {} "$OUT/" \; 2>/dev/null || true
fi
ls -la "$OUT" | tee -a "$OUT/summary.txt"
echo "== done ==" | tee -a "$OUT/summary.txt"
