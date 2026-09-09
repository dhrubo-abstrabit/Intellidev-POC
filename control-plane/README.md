# Intellidev

Dispatch a development task from a UI; an ephemeral container branches, implements, commits and
opens a PR — streamed live. Three harnesses behind one adapter: **opencode**, **Claude Code**,
**Codex**.

Runs in two places behind one interface: a **local container** for the development loop, and
**ECS Fargate** for the deployed path. The UI cannot tell them apart, which is the test.

- **Docs** — start at [docs/README.md](../docs/control-plane/README.md); local details in
  [docs/running-locally.md](../docs/control-plane/running-locally.md)
- **AWS** — task breakdown and current state in [docs/aws-ecs-plan.md](../docs/control-plane/aws-ecs-plan.md)
- **Requires** — Node 24+, pnpm, Docker running (local mode only)

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
- A task pointed at a **real remote** gets a `pr` stage, which pushes the branch and opens the
  pull request. A `file://` origin has no GitHub to open one against, so it stops at `commit` —
  and those commits live only in the cache mirror:

```bash
docker run --rm -v intellidev-cache-local:/cache \
  --entrypoint sh intellidev/runner:dev -c \
  'for d in /cache/git/*.git; do echo "== $d"; git -C "$d" log --oneline --all | head -3; done'
```

- Mirrors are keyed by a hash of the repository URL, so two repositories in one project cannot
  share one — the fixed `repo.git` they used to share made the second run fail on the first's
  origin.

## Running against ECS Fargate

Same UI, same code paths — the runner and the store are swapped by configuration. The
infrastructure is CDK in `infra/aws`; see [docs/aws-ecs-plan.md](../docs/control-plane/aws-ecs-plan.md) for what
each stack is and why.

**The control plane must be reachable from the task.** A Fargate container dials _out_ to stream
events and to pull credentials, so `127.0.0.1` is useless to it. Until the control plane is itself
deployed behind an ALB, a tunnel is the shortcut:

```bash
ngrok http 4000                                  # terminal 1
```

```bash
set -a; . ./.env; set +a                          # Supabase, GitHub App
export AWS_PROFILE=intellidev
export INTELLIDEV_PUBLIC_URL=$(curl -s http://127.0.0.1:4040/api/tunnels \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["tunnels"][0]["public_url"])')

INTELLIDEV_MODE=fargate INTELLIDEV_ENV=dev pnpm ui
```

- `INTELLIDEV_PUBLIC_URL` is read **once at boot**. ngrok issues a new URL per restart, so
  restarting the tunnel means restarting the control plane.
- ngrok's free tier allows **one agent**. A second silently loses and the tunnel keeps pointing at
  the old port — check with
  `curl -s localhost:4040/api/tunnels | python3 -c 'import json,sys; print(json.load(sys.stdin)["tunnels"][0]["config"]["addr"])'`.

### After changing adapter code

The image is what Fargate runs, and the task definition pins it **by digest** — so a source change
needs all four steps:

```bash
pnpm build                     # bundle the adapter
pnpm image:push                # build, push to ECR, record the digest
pnpm infra:deploy              # new task definition revision pointing at that digest
# then restart the control plane: it resolves the revision at boot
```

### Credentials

A container holds **only its own run token**. Everything else it asks the control plane for over
HTTPS, which is why nothing below is passed into the task environment:

| Credential | Where it comes from                                                 |
| ---------- | ------------------------------------------------------------------- |
| git        | a **GitHub App** installation token, minted per repository, 1 h TTL |
| harness    | the account connected in the UI, stored under the work root         |
| MCP        | the connected server's token, refreshed by the control plane        |

Set up the App once: create it at **github.com/settings/apps** with **Contents** and **Pull
requests** at _Read and write_, generate a private key, then **Install App** on the repositories it
should reach. Put `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `.env`. `INTELLIDEV_GITHUB_TOKEN`
still works as a local fallback, but it is scoped to everything its owner can reach — the App is
scoped to one repository.

### Proving each piece

Each of these asserts against real infrastructure rather than a mock:

```bash
pnpm infra:verify        # 17 checks: no NAT, S3 endpoint routed, image digest, no bind mounts
pnpm infra:smoke         # a real task proves DNS, HTTPS, git clone and S3 with no NAT gateway
pnpm image:measure       # image pull time, against the 60–120 s dispatch budget
pnpm runner:prove        # RunTask returns an ARN before exit; cancel stops the task
pnpm reconciler:prove    # a task killed from outside still settles, with a reason
```

## Environment variables

| Variable                             | Default                  | Purpose                                                    |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------- |
| `INTELLIDEV_MODE`                    | `inline`                 | `inline` in-process, `docker` local, `fargate` on ECS      |
| `INTELLIDEV_WORK_ROOT`               | `.intellidev-work`       | mirrors, worktrees, run exchange, stored accounts          |
| `INTELLIDEV_MOUNT_REPO`              | —                        | host path to bind-mount, for a `file://` origin            |
| `INTELLIDEV_IMAGE`                   | `intellidev/runner:dev`  | image `docker` mode launches                               |
| `INTELLIDEV_PROJECT_ID`              | `local`                  | scopes cache prefixes, secret names, the seat pool         |
| `INTELLIDEV_MODEL_<HARNESS>`         | harness default          | e.g. `INTELLIDEV_MODEL_CLAUDE_CODE=sonnet`                 |
| **Fargate mode**                     |                          |                                                            |
| `INTELLIDEV_ENV`                     | `dev`                    | which `/intellidev/<env>/` config to resolve from SSM      |
| `INTELLIDEV_PUBLIC_URL`              | `http://127.0.0.1:$PORT` | where a container reaches the control plane; read at boot  |
| `AWS_PROFILE` / `AWS_REGION`         | — / `ap-south-1`         | credentials and region for `RunTask`, SQS, S3, SSM         |
| **State**                            |                          |                                                            |
| `SUPABASE_CONNECTION_STRING_SESSION` | —                        | **session-mode** pooler; in memory if unset                |
| **Credentials**                      |                          |                                                            |
| `GITHUB_APP_ID`                      | —                        | preferred over a token; mints per-repo installation tokens |
| `GITHUB_APP_PRIVATE_KEY`             | —                        | PEM; newlines may be written as `\n`                       |
| `GITHUB_APP_SLUG`                    | discovered               | only enriches an error with an install link                |
| `INTELLIDEV_GITHUB_TOKEN`            | —                        | local fallback when no App is configured                   |
| `ANTHROPIC_API_KEY` etc.             | —                        | forwarded to the harness if set; the UI login is preferred |

- Ports: **4000** control plane + UI · **4040** ngrok inspector · **4100** fixture MCP · **1455**
  codex login callback (transient).
- **Transaction-mode pooling silently breaks `LISTEN`/`NOTIFY`** — measured at 0 of 3
  cross-connection notifications against 3 of 3 on session mode, at identical latency. Use the
  session pooler (port 5432).

## Database

Migrations are SQL in the repo, generated from the Drizzle schema and applied by an explicit step —
never on boot, because several instances rolling out would race each other.

```bash
pnpm db:generate     # schema change → drizzle/NNNN_*.sql
pnpm db:migrate      # apply to SUPABASE_CONNECTION_STRING_SESSION
```

- A migration must be **backward compatible with the code it replaces**: during a rolling deploy
  both versions run at once. Adding a nullable column is safe; renaming one is not.
- `run_events` has **no retention policy yet**. It grows roughly 0.25–2.5 GB/month at 500 runs.

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

- Tasks, runs and events live in **Postgres** when `SUPABASE_CONNECTION_STRING_SESSION` is set,
  and survive a restart. Without it the store is in memory and the board empties — the startup
  banner says which is in use. Harness accounts and MCP servers always persist under the work
  root.

## macOS gotchas

- **Docker Desktop only shares some paths.** An unshared bind mount silently produces an _empty,
  root-owned_ directory rather than an error. `/Users` is shared; `os.tmpdir()`
  (`/var/folders/...`) is not — which is why the work root belongs under your home directory.
- **A bind-mounted repo trips git's ownership check.** Handled automatically in docker mode via a
  `safe.directory` exception scoped to that case.
