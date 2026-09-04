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
# Stage 1b: the codex CLI, for signing in.
# ---------------------------------------------------------------------------
# Only codex, and only for its sign-in.
#
# Its device-code flow is the one harness login with no localhost redirect in it, and the CLI is
# what performs it: it holds the device code and polls until someone approves. Running that in a
# Fargate task meant a container start and an image pull before a person saw anything — about
# thirty seconds of blank window for an action that happens once per account.
#
# Here it is a subprocess of a process that is already running, so the same flow answers in about
# a second. It costs 135 MB compressed, which is 15 cents a month of ECR and roughly three
# seconds on a control-plane start. Measured, not estimated, because "it nearly doubles the
# image" sounded expensive and was not.
#
# Claude Code is deliberately absent: its sign-in is plain OAuth this process does itself, so its
# CLI would be weight with nothing to do.
#
# `--ignore-scripts=false` matters: codex fetches its platform binary in a postinstall step, and
# without it installs as a stub that fails at first use.
FROM node:24-bookworm-slim AS codex
ARG CODEX_VERSION=0.147.0
RUN npm install -g --ignore-scripts=false "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

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

# Copied rather than installed, so the slow layer is cached apart from application code.
COPY --from=codex /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
# Linked, not copied. npm puts a symlink here, and `COPY` dereferences it — which leaves the
# launcher sitting in /usr/local/bin with no package above it, so resolving its own platform
# binary walks up to / and fails with "Missing optional dependency @openai/codex-linux-arm64"
# while that dependency is present and 263 MB of it is right there.
RUN ln -s ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex

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

# A writable work root outside the application tree.
#
# `main.ts` creates one at boot for run scratch space, and defaults it to `.intellidev-work`
# under the repo — which is `/app` here, owned by root because the code is copied in as root and
# the process runs as `control`. The container exited 1 with `EACCES: mkdir /app/.intellidev-work`
# before this existed.
#
# Outside `/app` on purpose rather than chowning it: scratch data does not belong in the
# application tree, and a writable code directory is a larger blast radius than a writable
# scratch one.
RUN mkdir -p /var/lib/intellidev && chown control:control /var/lib/intellidev
ENV INTELLIDEV_WORK_ROOT=/var/lib/intellidev

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
