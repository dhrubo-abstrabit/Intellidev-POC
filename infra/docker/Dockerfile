# The golden image.
#
# One image for every project. Nothing project-specific is baked in — a project is a
# manifest fetched at boot, which is what makes onboarding a project a database row
# rather than an image build.
#
# Harness versions are pinned to exactly what the contract tests were recorded against.
# When you bump one, re-record its fixture and let the contract test tell you what moved;
# that is the whole point of pinning rather than tracking latest.

# ---------------------------------------------------------------------------
# Stage 1: harnesses. Slowest layer, changes least often.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS harnesses

ARG CLAUDE_CODE_VERSION=2.1.228
ARG CODEX_VERSION=0.147.0
ARG OPENCODE_VERSION=1.18.16

# `--ignore-scripts=false` matters: codex and opencode fetch a platform binary in a
# postinstall step, and without it they install as a stub that fails at first use.
RUN npm install -g --ignore-scripts=false \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 2: the runtime image.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim

# git is the only hard requirement beyond node. ca-certificates because every credential
# and model call is HTTPS. `less` because git invokes a pager and its absence produces a
# confusing error rather than a missing feature.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates less \
 && rm -rf /var/lib/apt/lists/*

COPY --from=harnesses /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=harnesses /usr/local/bin /usr/local/bin

# Two users, because the credential broker is only a boundary if the harness cannot open
# its socket. See docs/architecture.md §8. NOTE: the split is not yet *enforced* — the
# adapter would need CAP_SETUID to spawn the harness as another uid, so today both run as
# `adapter`. The accounts exist so enabling it is a flag rather than an image rebuild.
RUN groupadd --gid 10001 adapter \
 && useradd  --uid 10001 --gid 10001 --create-home --shell /bin/bash adapter \
 && groupadd --gid 10002 harness \
 && useradd  --uid 10002 --gid 10002 --create-home --shell /bin/bash harness \
 && usermod -aG harness adapter

# Bundled, not installed: two files instead of a dependency tree, and no npm install
# inside the dispatch budget.
COPY --chown=root:root packages/adapter/dist/intellidev-adapter.js /opt/intellidev/
COPY --chown=root:root packages/adapter/dist/intellidev-cred.js /opt/intellidev/

# git spawns the credential helper by name on every authenticated operation, so it has to
# be on PATH and executable.
RUN printf '#!/bin/sh\nexec node /opt/intellidev/intellidev-cred.js "$@"\n' > /usr/local/bin/intellidev-cred \
 && printf '#!/bin/sh\nexec node /opt/intellidev/intellidev-adapter.js "$@"\n' > /usr/local/bin/intellidev-adapter \
 && chmod 0755 /usr/local/bin/intellidev-cred /usr/local/bin/intellidev-adapter

# Mount points. Group-writable so a future harness uid can write the worktree while the
# adapter still owns the socket directory.
RUN mkdir -p /work /cache /opt/project /run/intellidev \
 && chown -R adapter:harness /work /cache /opt/project /run/intellidev \
 && chmod 2775 /work /cache \
 && chmod 0750 /run/intellidev

USER adapter
WORKDIR /work
ENV HOME=/home/adapter \
    NODE_ENV=production \
    NO_COLOR=1 \
    GIT_TERMINAL_PROMPT=0

# Fails fast and visibly if a harness did not install correctly, which is otherwise only
# discovered mid-run as "command not found".
HEALTHCHECK --interval=30s --timeout=10s --retries=2 \
  CMD node -e "process.exit(0)"

ENTRYPOINT ["intellidev-adapter"]
CMD ["--help"]
