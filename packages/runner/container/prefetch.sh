#!/usr/bin/env bash
# Registry-only fetch phase. This container may use the network, so it must
# never install, load, or run the subject or any dependency build script.
set -euo pipefail

spec="${1:?subject spec required}"
runtime="${2:?DSH runtime version required}"
cd /work/cache
printf '{"name":"dsh-verifier-fetch","version":"0.0.0","private":true,"packageManager":"pnpm@10.33.2"}\n' > package.json

# Lockfile resolution and pnpm fetch download packages without running their
# install scripts. The execution container later uses the same store offline.
pnpm add --lockfile-only --ignore-scripts --store-dir /work/cache/store \
  "$spec" "@deepseek-ai/dsh-llm-replay@$runtime"

# Git/file/link dependencies can require a preparation step. Registry tarballs
# are expected; reject URLs whose host is not the configured registry.
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const lock = readFileSync('pnpm-lock.yaml', 'utf8');
const registryHost = new URL(process.env.npm_config_registry ?? 'https://registry.npmjs.org').host;
const unsupported = /(^|[\s'"({])(?:git\+|git:|github:|file:|link:|workspace:)/m.test(lock);
const urls = [...lock.matchAll(/https?:\/\/[^\s,'"}\]]+/g)].map((match) => match[0]);
const external = urls.filter((value) => {
  try { return new URL(value).host !== registryHost; }
  catch { return true; }
});
if (unsupported || external.length > 0) {
  let source = 'local/git reference';
  if (!unsupported) {
    try { source = `external host: ${new URL(external[0]).host}`; }
    catch { source = 'invalid URL'; }
  }
  console.error(`prefetch: non-registry dependency requires manual review (${source})`);
  process.exit(4);
}
NODE

pnpm fetch --prod --store-dir /work/cache/store
