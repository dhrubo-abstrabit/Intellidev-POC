# Intellidev

Dispatch a development task from a UI; an ephemeral container branches, implements, commits and
opens a PR — streamed live. Three harnesses behind one adapter: **opencode**, **Claude Code**,
**Codex**.

- **Docs** — start at [docs/README.md](docs/README.md); local details in
  [docs/running-locally.md](docs/running-locally.md)
- **Requires** — Node 24+, pnpm, Docker Desktop running

---

## 1. Install and build

```bash
pnpm install
pnpm --filter @intellidev/adapter build                        # bundles the adapter
docker build -f infra/docker/Dockerfile -t intellidev/runner:dev .
```

- The image **bakes in** the adapter bundle — after changing adapter code, run **both** builds
  again before dispatching.

## 2. Create a repo to work against

```bash
mkdir -p .intellidev-local
git init --bare .intellidev-local/origin.git

rm -rf /tmp/seed && git clone .intellidev-local/origin.git /tmp/seed
cd /tmp/seed
cat > greet.js <<'EOF'
export function hello(n) {
  return `Hi, ${n}!`
}
EOF
git add -A && git -c user.email=s@e.test -c user.name=s commit -qm seed && git push -q origin main
cd -
```

- The quoted heredoc (`<<'EOF'`) matters — unquoted, zsh tries to expand `!` and backticks.

## 3. Run the servers

**Control plane + UI** → http://127.0.0.1:4000

```bash
INTELLIDEV_MODE=docker \
INTELLIDEV_WORK_ROOT=$PWD/.intellidev-local/work \
INTELLIDEV_MOUNT_REPO=$PWD/.intellidev-local/origin.git \
pnpm ui
```

- Drop `INTELLIDEV_MODE=docker` to run the adapter **in-process** — faster to iterate, no image
  rebuild, same events.
- Keep the terminal open: it streams the container's own output, which is the best view when a run
  misbehaves.

**Fixture MCP server** (optional, for testing tools + auth) → port 4100

```bash
node packages/control-plane/examples/facts-server.mjs
```

- Requires bearer token `s3cret-fixture-token`; returns a value no model could guess, so a passing
  test proves the whole chain.

**Stop a server**

```bash
lsof -ti tcp:4000 | xargs -r kill -9      # control plane
lsof -ti tcp:4100 | xargs -r kill -9      # fixture
```

## 4. Connect credentials (once)

In the UI's left column:

- **Harness accounts** → **Sign in** — opens the vendor's own OAuth page (Claude Code, Codex);
  opencode uses **Import** after `opencode auth login`.
- **MCP servers** → **Add** — presets for Supabase (OAuth), GitHub (PAT), the local fixture.
- Both are **persisted** and injected into every container afterwards; the banner prints what is
  connected on startup.

## 5. Dispatch and inspect

- Fill **New task**, tick the servers under **Tools**, **Create task** → click it → **Dispatch**.
- Stages advance `design → branch → code → commit`; expect **4–6 min**.
- Commits land in the git mirror inside the cache volume, not in `origin.git` (the local template
  has no `pr` stage, and `push` happens only there):

```bash
docker run --rm -v intellidev-cache-local:/cache \
  --entrypoint sh intellidev/runner:dev -c \
  'cd /cache/git/repo.git && git branch && git log --oneline --all | head'
```

## Environment variables

| Variable                     | Default                 | Purpose                                           |
| ---------------------------- | ----------------------- | ------------------------------------------------- |
| `INTELLIDEV_MODE`            | `inline`                | `inline` in-process, `docker` in the image        |
| `INTELLIDEV_WORK_ROOT`       | `.intellidev-work`      | mirrors, worktrees, run exchange, stored accounts |
| `INTELLIDEV_MOUNT_REPO`      | —                       | host path to bind-mount, for a `file://` origin   |
| `INTELLIDEV_IMAGE`           | `intellidev/runner:dev` | image `docker` mode launches                      |
| `INTELLIDEV_GITHUB_TOKEN`    | —                       | needed to push and open a PR                      |
| `INTELLIDEV_MODEL_<HARNESS>` | harness default         | e.g. `INTELLIDEV_MODEL_CLAUDE_CODE=sonnet`        |
| `ANTHROPIC_API_KEY` etc.     | —                       | forwarded to the harness if set                   |

- Ports: **4000** control plane + UI · **4100** fixture MCP · **1455** codex login callback
  (transient).

## Development

```bash
pnpm check          # format + typecheck + tests — run before every commit
pnpm test           # tests only
pnpm -r typecheck   # types only
```

- Use `pnpm check && git commit`, never a pipe — a pipe hides the exit code.

## Reset

```bash
docker volume rm intellidev-cache-local        # git mirror cache; do not hide its output
rm -rf .intellidev-local/work                  # worktrees, exchange, stored accounts
```

- Tasks are **in memory** — restarting the control plane clears the board. Connected harness
  accounts and MCP servers survive, since they live under the work root.

## macOS gotchas

- **Docker Desktop only shares some paths.** An unshared bind mount silently produces an _empty,
  root-owned_ directory rather than an error. `/Users` is shared; `os.tmpdir()`
  (`/var/folders/...`) is not — which is why the work root belongs under your home directory.
- **A bind-mounted repo trips git's ownership check.** Handled automatically in docker mode via a
  `safe.directory` exception scoped to that case.
