# The control plane's image.
#
# Separate from the golden image on purpose. That one carries three AI harnesses and weighs
# 1.5 GB uncompressed because a *run* needs them; this one serves HTTP and talks to Postgres,
# and pulling a harness toolchain to do it would make every deploy slower for nothing.
#
# Runs from source through `tsx`, exactly as `pnpm ui` does. A bundling step would be a second
# way the code can be wrong — one that only manifests in the deployed artefact — and the startup
# cost it saves is paid once per deploy, on a service that stays up.

# ---------------------------------------------------------------------------
# Stage 1: dependencies. Cached until a lockfile changes.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS deps

RUN corepack enable

WORKDIR /app

# Only the manifests, so this layer survives every change that is not a dependency change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/adapter/package.json packages/adapter/
COPY packages/control-plane/package.json packages/control-plane/

# `--frozen-lockfile` so a drifted lockfile fails the build rather than being silently resolved
# into something nobody tested.
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2: the runtime image.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim

# git is not optional. Dispatch runs `git ls-remote` to refuse a bad repository or branch before
# spending a container, and without it every dispatch fails at the preflight with a message
# about a missing binary rather than about the repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Never root. The control plane holds the GitHub App key and every decrypted credential in
# memory; a process that also owns its own filesystem is a larger blast radius than it needs.
RUN useradd --create-home --uid 10001 control
WORKDIR /app

COPY --from=deps --chown=control:control /app/node_modules ./node_modules
COPY --from=deps --chown=control:control /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps --chown=control:control /app/packages/adapter/node_modules ./packages/adapter/node_modules
COPY --from=deps --chown=control:control /app/packages/control-plane/node_modules ./packages/control-plane/node_modules

COPY --chown=control:control package.json pnpm-workspace.yaml ./
COPY --chown=control:control packages/shared ./packages/shared
COPY --chown=control:control packages/adapter ./packages/adapter
COPY --chown=control:control packages/control-plane ./packages/control-plane

# The database migrations, so an operator can run them from the same image that serves.
# Deliberately not run at startup: with more than one task a rolling deploy would have several
# racing to alter the same tables.
COPY --chown=control:control db ./db

USER control

# 0.0.0.0 because a container that binds loopback is unreachable from its own load balancer, and
# the health check failing looks like the application being broken.
ENV INTELLIDEV_BIND_HOST=0.0.0.0
ENV PORT=4000
ENV NODE_ENV=production

EXPOSE 4000

# Docker's own check, for `docker run` and for anything that reads it. The load balancer has its
# own against the same path; both ask the question that matters, which is whether this instance
# can reach the database rather than whether the process exists.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `exec` form, so the process is PID 1 and receives SIGTERM directly. Through a shell it would
# not, and ECS would wait out the stop timeout on every deploy before killing it — the same
# failure the signal handling was fixed for.
ENTRYPOINT ["node", "--import", "tsx", "packages/control-plane/src/main.ts"]
