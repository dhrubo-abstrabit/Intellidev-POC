# Milestone 0 — the walking skeleton

**Goal:** a task typed into the UI by hand produces a real pull request, with live
event streaming, using both harnesses behind one driver interface.

Split in two so there is a working demo before any cloud work:

- **M0a — First PR, locally.** Control plane in docker-compose, runs in local Docker.
- **M0b — Same thing on Fargate.** Golden image in ECR, S3 caches, `RunTask`.

## What M0 is actually testing

The point is to invalidate the design early if it is wrong. Five things are unproven:

1. Can we drive **Claude Code and Codex headlessly**, normalise both to one event
   vocabulary, and steer them mid-run?
2. Does a **stage machine with real gates** hold up, and does it resume after a crash?
3. Can the adapter **land a PR** with pull-on-demand GitHub credentials?
4. Does the **MCP gateway** actually make one tool attachment work on both harnesses?
5. Is the **60–120 s dispatch** budget real on Fargate?

Everything else in the architecture is ordinary web-app work and can wait.

## Explicitly not in M0

Named so scope does not creep. Each has a milestone in [roadmap.md](roadmap.md).

Seat pool and admission control (one hardcoded credential instead) · usage ledger and
budgets · human approval gates · egress allowlist · derived images · cache pruning ·
warm anything · more than one project · OAuth-based MCP attachment flow in the UI
(M0 uses a token pasted into config) · Graviton · Spot.

## Stack

TypeScript end to end — the harness CLIs, the MCP SDK and the UI are all in that
ecosystem, and the adapter shares types with the control plane. Rationale for each
choice, and the alternatives rejected, is in [stack.md](stack.md).

| Piece     | Choice                                                          |
| --------- | --------------------------------------------------------------- |
| API       | Fastify + Zod (`fastify-type-provider-zod` → generated OpenAPI) |
| WS ingest | `@fastify/websocket`, **separate entrypoint** from the API      |
| DB        | Postgres + Drizzle (needs literal `FOR UPDATE SKIP LOCKED`)     |
| Queue     | Postgres `SKIP LOCKED` + `LISTEN/NOTIFY` — no Redis in M0       |
| Adapter   | Plain Node CLI, no framework, single file via esbuild           |
| MCP       | `@modelcontextprotocol/sdk` — client _and_ server               |
| UI        | React (existing build)                                          |
| Infra     | Terraform                                                       |
| Monorepo  | pnpm workspaces, `@intellidev/shared` consumed as source        |

```
packages/
  shared/        canonical event schema, manifest types, Zod schemas
  adapter/       drivers, stage engine, MCP gateway, broker, git workflow
  control-plane/ API, orchestrator, Runner + CacheProvider, WS gateway
  ui/            existing React app
infra/           terraform: vpc, ecr, ecs, s3, rds
docs/
```

---

## M0a — First PR, locally

### T1 · Monorepo scaffold and shared contracts

Set up pnpm workspaces, TypeScript project refs, lint, CI. Define in `packages/shared`
the canonical `AgentEvent` union, `ProjectManifest`, `StageDefinition` and `RunSpec` as
Zod schemas with inferred types.

**Done when:** `pnpm build` and `pnpm test` pass in CI, and both adapter and control
plane import the same event type.

**Note:** the event schema is the contract everything else hangs off. Write it once,
here, and treat later changes as breaking.

### T2 · Claude Code driver

Spawn `claude -p --output-format stream-json --input-format stream-json --verbose`,
parse the stream, normalise to `AgentEvent`. Implement `send()` (streaming stdin),
`interrupt()`, `usage()` and `resumeToken`.

**Done when:** a fixture prompt against a scratch repo produces a correct ordered event
sequence, and a contract test asserts the shape against the pinned CLI version.

### T3 · Codex driver

Same interface, `codex exec --json`. Steering is queued and injected at
`turn.boundary`. Where a capability is missing, degrade explicitly rather than
pretending.

**Done when:** the same fixture prompt through the Codex driver produces the same
canonical event _types_ (values will differ), and both contract tests run in CI.

**Why this is task 3 and not task 12:** the second driver is what proves the abstraction
is not Claude-Code-shaped. Building it after everything else is built on top is the
expensive order.

### T4 · Stage engine

State machine over `StageDefinition[]`, driven from YAML. Command gates and predicate
gates. Bounded attempts per stage. Persist every transition so a killed process resumes
at the last gate.

**Done when:** a stage config with a deliberately failing test loops back to `code`
exactly 3 times then ends `failed`; and killing the process mid-`code` and restarting
resumes at `code` rather than `design`.

### T5 · Credential broker and GitHub App

Broker on `/run/broker.sock`. GitHub App registered; control plane mints installation
tokens scoped to the project's repos. `intellidev-cred` git credential helper responds
to the git protocol on stdin.

**Done when:** `git push` works with no token in the environment, and a run whose token
expires mid-flight pushes successfully after a transparent refresh (test by minting a
60-second token).

### T6 · Git workflow

Restore or clone the mirror, `worktree add` on a new branch from the manifest's
`branch_pattern`, commit with a generated message, push, open the PR via the GitHub API.
The PR body is assembled from the run's event log — diffstat, checks run, review
findings — not improvised by the model.

**Done when:** a real PR appears on a test repo with a body reflecting what happened.

### T7 · MCP gateway

The adapter serves one stdio MCP endpoint downstream and connects upstream to attached
servers. Built-in tools: `stage_state`, `stage_advance`, `task_context`, `run_check`,
`skill_list`, `skill_load`, `ask_user`. Filter the merged tool list by stage scope and
policy. Emit `tool.call` / `tool.result` / `tool.denied` for everything passing through.

**Done when:** one upstream server (start with a trivial local one, then a real remote)
plus one skill are visible to **both** harnesses through a single config entry each, and
a tool excluded from the `design` stage is genuinely absent there.

### T8 · Config projection

Render from the manifest at boot: `.mcp.json`, `~/.claude/settings.json`, `CLAUDE.md`,
`~/.codex/config.toml`, `AGENTS.md` with skill index, skills symlink, git credential
helper config. Idempotent.

**Done when:** switching a project's harness in the manifest changes only which config
files are written, with no change to stages, tools or skills behaviour.

### T9 · Control plane: schema and API

Postgres schema per [architecture.md §10](architecture.md). Endpoints for projects,
manifests (immutable, versioned), tasks and runs.

The **manual task form** is the only way tasks are created in M0:

| Field               | Notes                                              |
| ------------------- | -------------------------------------------------- |
| Title               | required                                           |
| Description         | required, markdown — becomes the agent's brief     |
| Details / context   | optional, markdown — links, constraints, prior art |
| Acceptance criteria | optional list — surfaced to the review stage       |
| Repo + base branch  | defaults from the project                          |
| Harness             | defaults from the project, overridable per task    |
| Stage template      | defaults from the project                          |

**Done when:** a task can be created, listed and fetched, and its status transitions are
enforced server-side (`not_started → dispatched → running → in_review → done`).

### T10 · Event ingest and UI streaming

WS endpoint the adapter dials out to. Append events to `run_events` with per-run `seq`.
SSE endpoint for the UI. Control frames down the same socket for `steer` and
`interrupt`, queued and injected at `turn.boundary`, with pending → delivered feedback.
Replay from last acked `seq` on reconnect.

**Done when:** two browser tabs show the same live run identically; a steer message
appears immediately as pending and flips to delivered; and killing the WS mid-run
resumes with no gap and no duplicate events.

### T11 · Orchestrator and dispatch

`Runner` interface with a Docker implementation. `POST /api/tasks/:id/dispatch` inserts
a run, resolves the manifest version, mints a single-use `RUN_TOKEN`, launches the
container, and reconciles on exit. One hardcoded model credential — no seat pool yet.

**Done when:** **M0a acceptance** — a task typed into the UI dispatches, streams live,
and lands a PR, with the same task succeeding on both harnesses.

---

## M0b — Same thing on Fargate

### T12 · Golden image

Multi-stage: OS + git/gh/node/python/mise in a base layer, pinned `claude` and `codex`
plus the adapter in a thin top layer. Non-root uid 10001, no privileged assumptions.
Push to ECR.

**Done when:** the image runs a task locally, and a harness version bump is a top-layer
rebuild only.

### T13 · CacheProvider and bootstrap

`prepare(project) → path` backed by S3 tarballs: git mirror, package store, build
artefacts. Seed at project-create, restore per run, re-upload on change. Bootstrap
emits `run.provisioning`, `bundle.fetched`, `cache.restored`, `worktree.ready`.

**Done when:** a cold project seeds in one pass, a warm run restores in under 60 s, and
deleting the cache object degrades to a slow run rather than a failure.

### T14 · Fargate runner and Terraform

VPC with a **public subnet and `assignPublicIp`** (no NAT gateway), security group,
task and execution roles, **S3 gateway VPC endpoint**, one task definition per image
version with `RunTask` overrides, explicit ephemeral storage, run TTL and idle kill.

**Done when:** the same dispatch path works with `FargateRunner` swapped for
`DockerRunner` and no other change; and `terraform destroy` leaves no hourly-billed
resource behind.

### T15 · End-to-end acceptance

Measure and record: dispatch-to-first-token, per-stage p50/p90 from `stage.entered` /
`stage.exited`, and cost per run. Re-cost [architecture.md §13](architecture.md) from
real numbers.

**Done when:** **M0 acceptance** — all of the following hold.

## M0 definition of done

1. A task created by hand in the UI lands a PR on a real repo, unattended.
2. The same task succeeds through **both** Claude Code and Codex, selected per task.
3. One MCP server attachment and one skill work on both harnesses via a single config
   entry each, with stage scoping enforced.
4. A failing test suite loops back to `code`, bounded, then fails cleanly with a
   diagnosable event log.
5. Killing a run mid-stage and re-dispatching resumes at the last gate.
6. The UI streams a run live, and a chat message steers it at a turn boundary.
7. Dispatch to first token is inside 120 s on Fargate, with bootstrap progress visible.
8. No secret exists in any container environment variable.
9. `terraform destroy` leaves nothing billing hourly.

## Sequencing note

T2 and T3 before everything else is deliberate: the harness seam and the event schema
are the two things that are expensive to change later and cheap to prove now. T5 and T7
are next because credential pull-on-demand and the gateway are the other two novel
mechanisms. T9–T11 are ordinary application work and carry the least risk — do them once
the risky parts have held.
