# Verification container — V0 baseline.
#
# One container, one subject, discarded afterwards. Nothing here runs as root,
# nothing mounts the user's home or credentials, and the only network use is at
# BUILD time (fetching pnpm and the pinned DSH runtime). Plugin code never runs
# during the build.
#
# The DSH version is an ARG on purpose: a report must record the exact runtime
# it ran against, and DSH is pre-1.0 with observable behaviour changes between
# release candidates.

FROM node:24-bookworm-slim

ARG DSH_VERSION=0.2.0-rc.2
ARG PNPM_VERSION=10.33.2

ENV DEBIAN_FRONTEND=noninteractive \
    npm_config_cache=/tmp/npm-cache \
    DSH_HOME=/work/dsh-home \
    CI=1

# `passwd` is not in bookworm-slim and provides useradd; without it the
# unprivileged-user step fails with exit 127.
RUN apt-get update \
 && apt-get install -y --no-install-recommends passwd \
 && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# First-party runtime fetch. No plugin code executes here.
#
# FINDING (recorded in docs/evidence/V0.md): npm's install-script gating blocks
# install scripts by default. A plain `npm install -g @deepseek-ai/dsh` reports
# five packages whose scripts did not run, two of them native modules
# (node-pty, koffi). `dsh --version` still answers, so the gap is invisible
# until a feature needing those natives is exercised.
#
# We allow them explicitly rather than silently: this is the FIRST-PARTY DSH
# runtime, and a half-built runtime would make every later measurement wrong.
# The decision is recorded, not absorbed. Third-party subject plugins never get
# this treatment — their pending build scripts are a reportable finding.
# ---------------------------------------------------------------------------
RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate

RUN mkdir -p /opt/dsh-runtime-facts
COPY runtime-facts.mjs /opt/dsh-runtime-facts/runtime-facts.mjs

RUN npm install --global \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      "@deepseek-ai/dsh@${DSH_VERSION}" > /opt/dsh-runtime-facts/npm-install.log 2>&1 \
 && node /opt/dsh-runtime-facts/runtime-facts.mjs \
 && npm cache clean --force \
 && rm -rf /tmp/npm-cache

# Unprivileged execution. Nothing below runs as root.
RUN useradd --create-home --uid 10001 --shell /bin/false verifier \
 && mkdir -p /work /work/out \
 && chown -R verifier:verifier /work \
 && chmod -R a+rX /opt/dsh-runtime-facts

COPY --chown=verifier:verifier baseline.ts /work/baseline.ts

USER verifier
WORKDIR /work

# Default to the offline baseline: it must succeed with no network at all,
# which proves the image is self-contained.
ENTRYPOINT ["node"]
CMD ["/work/baseline.ts", "--offline"]
