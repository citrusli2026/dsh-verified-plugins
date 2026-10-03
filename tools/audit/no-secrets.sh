#!/usr/bin/env bash
# no-secrets.sh — audits that a repository in this project configures ZERO
# secrets, which is the property that makes its reports reproducible by anyone.
#
# This is run from outside CI, on purpose: a workflow cannot read repository
# secrets with GITHUB_TOKEN, so "we have no secrets" is not provable from
# inside a workflow. It is provable from here.
#
# Usage:   tools/audit/no-secrets.sh [owner/repo]
# Default: citrusli2026/dsh-verified-plugins
# Exit:    0 = zero secrets/variables everywhere, 1 = something is configured,
#          2 = could not complete the audit (treat as failure).

set -uo pipefail

REPO="${1:-citrusli2026/dsh-verified-plugins}"

if ! command -v gh >/dev/null 2>&1; then
  echo "fatal: gh CLI not found" >&2
  exit 2
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "fatal: gh is not authenticated" >&2
  exit 2
fi

failures=0
checked=0

count_of() {
  # count_of <endpoint> <jq-expr> <label>
  local endpoint="$1" expr="$2" label="$3" value
  if ! value="$(gh api "$endpoint" --jq "$expr" 2>/dev/null)"; then
    echo "  ??   $label: could not read ($endpoint)"
    failures=$((failures + 1))
    return
  fi
  checked=$((checked + 1))
  if [ "$value" = "0" ]; then
    echo "  ok   $label: 0"
  else
    echo "  FAIL $label: $value configured"
    failures=$((failures + 1))
  fi
}

echo "Auditing $REPO for configured secrets and variables"
echo
echo "Repository:"
count_of "repos/$REPO/actions/secrets"   '.total_count' 'actions secrets'
count_of "repos/$REPO/actions/variables" '.total_count' 'actions variables'
count_of "repos/$REPO/dependabot/secrets" '.total_count' 'Dependabot secrets'

echo
echo "Environments:"
if envs="$(gh api "repos/$REPO/environments" --jq '.environments[].name' 2>/dev/null)"; then
  if [ -z "$envs" ]; then
    echo "  ok   no environments defined"
    checked=$((checked + 1))
  else
    while IFS= read -r env; do
      [ -z "$env" ] && continue
      count_of "repos/$REPO/environments/$env/secrets"   ".total_count" "env '$env' secrets"
      count_of "repos/$REPO/environments/$env/variables" ".total_count" "env '$env' variables"
    done <<< "$envs"
  fi
else
  echo "  ??   could not list environments"
  failures=$((failures + 1))
fi

# As a second, independent signal: the repository's own workflow policy forbids
# referencing secrets at all. A repo with zero secrets and a clean policy has no
# path for a credential to enter CI.
echo
echo "Workflow policy:"
if node "$(dirname "$0")/../policy/check-workflows.mjs" >/dev/null 2>&1; then
  echo "  ok   no workflow references secrets.* and P0 rules hold"
  checked=$((checked + 1))
else
  echo "  FAIL workflow policy violated (run: node tools/policy/check-workflows.mjs)"
  failures=$((failures + 1))
fi

echo
echo "Not covered by this audit: organisation-level secrets, GitHub Apps, and"
echo "self-hosted runner credentials. Those are outside the repository and must"
echo "be reviewed separately."

echo
if [ "$failures" -gt 0 ]; then
  echo "FAIL: $failures problem(s) across $checked check(s)."
  exit 1
fi
echo "OK: $checked check(s) passed — zero secrets configured."
