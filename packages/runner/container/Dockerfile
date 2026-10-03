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
    PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:/usr/local/bin:/usr/bin:/bin \
    npm_config_cache=/tmp/npm-cache \
    DSH_HOME=/work/dsh-home \
    CI=1

# Fetch phase. No plugin code executes here.
RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
 && npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force \
 && rm -rf /tmp/npm-cache

# Unprivileged execution. Nothing below runs as root.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin verifier \
 && mkdir -p /work /work/out \
 && chown -R verifier:verifier /work

COPY --chown=verifier:verifier baseline.ts /work/baseline.ts

USER verifier
WORKDIR /work

# Default to the offline baseline: it must succeed with no network at all,
# which proves the image is self-contained.
ENTRYPOINT ["node"]
CMD ["/work/baseline.ts", "--offline"]
