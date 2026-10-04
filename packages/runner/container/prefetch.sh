#!/usr/bin/env bash
# Registry-only fetch phase. This container may use the network, so it must
# never install, load, or run the subject or any dependency build script.
set -euo pipefail

spec="${1:?subject spec required}"
runtime="${2:?DSH runtime version required}"
cd /work/cache
printf '{"name":"dsh-verifier-fetch","version":"0.0.0","private":true}\n' > package.json

# Lockfile resolution and pnpm fetch download packages without running their
# install scripts. The execution container later uses the same store offline.
pnpm add --lockfile-only --ignore-scripts --store-dir /work/cache/store \
  "$spec" "@deepseek-ai/dsh-llm-replay@$runtime"

# Git/file/link dependencies can require a preparation step. Refuse them in
# the networked phase instead of assuming --ignore-scripts covers every path.
if grep -Eq 'git\+|git:|github:|file:|link:|workspace:|tarball:' pnpm-lock.yaml; then
  echo 'prefetch: non-registry dependency requires manual review' >&2
  exit 4
fi

pnpm fetch --prod --store-dir /work/cache/store
