# Architecture

## 1. The shape

Five things exist.

- **Control plane** — UI, API, Postgres. Lives outside every container. Owns tasks,
  manifests, credentials, seats, tool attachments and the event log.
- **Project registry** — each project is a versioned, immutable YAML manifest plus a
  bundle of skills, prompts and stage definitions, stored in S3.
- **Runtime** — ECS on Fargate. One task per dispatch via `RunTask`. Bills per second
  while running, nothing between runs.
- **Run container** — started per dispatched task from a single golden image, with the
  project cache restored from S3 and config rendered at boot.
- **Adapter** — our process inside the container. Owns the git workflow, the stage
  state machine, the normalised event stream, the MCP gateway, the credential broker,
  and one driver per harness.

The harness is the least important part. It is a replaceable subprocess behind a
driver interface. Everything durable lives in the adapter.

### Project is not a container

A **project** is a durable identity — repo, manifest, S3 caches, attached tools, seat
pool reference. It costs a little storage and no compute, and never executes anything.

A **run** is an ephemeral Fargate task. It restores the cache, creates its own
`git worktree`, works one task, opens a PR, exits.

This is what makes concurrency safe: two tasks on one project never contend for a
working tree. Idle projects cost nothing. A poisoned run is discarded, not debugged.

## 2. Dispatch path

Budget: **60–120 seconds** from dispatch to first agent token. Deliberately relaxed —
which is what removes the warm pool, pre-warming and all start-time engineering.

```
POST /api/tasks/:id/dispatch
  → INSERT runs (status=queued)
  → acquire seat            -- FOR UPDATE SKIP LOCKED; if none: status=waiting_capacity
  → orchestrator.launch(run)
      ecs.RunTask
        taskDefinition : intellidev-runner:<rev>       -- one def per image version
        overrides      : { env: RUN_ID, CONTROL_PLANE_URL, RUN_TOKEN }
        networkConfig  : public subnet, assignPublicIp ENABLED   -- avoids NAT
  → adapter entrypoint: intellidev-adapter run
      GET  /internal/runs/:id/spec        (bearer RUN_TOKEN, single use, 10 min TTL)
      GET  bundle.tar.zst from S3         verify digest → /opt/project
      start broker on /run/broker.sock
      materialise config                  (§5)
      restore cache from S3 + git worktree add
      connect upstream MCP servers        (§6)
      WS connect /runs/:id/stream
      stages.run()
```

Timing, roughly: `RunTask` placement and image pull 10–40 s, bootstrap 2–5 s, cache
restore 20–60 s, dependency install 0–60 s, harness handshake ~5 s.

Bootstrap emits its own events — `run.provisioning`, `bundle.fetched`,
`cache.restored`, `worktree.ready` — so the UI shows progress, not a spinner.
Optimistic UI works here because there is real progress to report.

## 3. Container layout

```
/opt/intellidev/       adapter binary + MCP gateway                    [image]
/opt/harness/          claude, codex — pinned versions                 [image]
/opt/project/          unpacked bundle: skills/ prompts/ stages/       [boot]
/cache/                restored from S3: git mirror, pnpm store        [boot]
/work/run-<id>/        git worktree on the feature branch              [boot]
/run/broker.sock       credential broker, uid 10001 only              [boot]
```

Rendered from the manifest at boot (~100 ms, idempotent, never authored by hand):

```
/work/.mcp.json                  → single entry: the adapter gateway
/work/CLAUDE.md                  → from context/repo.md
/work/AGENTS.md                  → same source + skill index
/work/.claude/skills → /opt/project/skills
~/.claude/settings.json          → permissions, PreToolUse hook, model
~/.codex/config.toml             → [mcp_servers], sandbox, approval policy
git config credential.helper     → '!intellidev-cred git'
```

**Nothing project-specific is ever baked into an image.** One golden image, rebuilt
only when a harness version changes. Onboarding a project is a database row.

## 4. Adapter internals

### Driver interface

```ts
interface HarnessDriver {
  readonly id: 'claude-code' | 'codex'
  materialise(bundle: ProjectBundle): Promise<void> // write this harness's config
  start(req: StageRequest): Promise<Session> // one stage = one session
}

interface Session {
  readonly events: AsyncIterable<AgentEvent> // normalised vocabulary
  send(text: string): Promise<void> // steering, queued
  interrupt(): Promise<void> // jumps the queue
  usage(): UsageSnapshot
  readonly resumeToken: string | null
}
```

Invocation, to be pinned and contract-tested per version:

```
claude -p --output-format stream-json --input-format stream-json --verbose \
       --mcp-config /work/.mcp.json --append-system-prompt <stagePrompt> \
       --session-id <uuid>

codex exec --json -C /work/run-<id> <prompt>
```

CLI flags and JSON event shapes move between releases. Pin versions in the image and
keep a contract test per driver asserting the event shape, so drift fails in CI rather
than mid-run.

### Canonical event envelope

```json
{
  "seq": 417,
  "run": "4821",
  "ts": "2026-08-12T09:14:03.221Z",
  "stage": "code",
  "type": "tool.call",
  "data": { "id": "toolu_01A", "name": "Edit", "input": { "file_path": "src/auth.ts" } }
}
```

`seq` is per-run and monotonic, which makes reconnect a replay rather than a gap.

| Group     | Events                                                                         |
| --------- | ------------------------------------------------------------------------------ |
| lifecycle | `run.provisioning` `run.started` `stage.entered` `stage.exited` `run.finished` |
| model     | `assistant.delta` `assistant.message` `thinking.started` `turn.boundary`       |
| tools     | `tool.call` `tool.result` `tool.denied`                                        |
| workspace | `file.changed` `diff.produced` `command.output`                                |
| git       | `git.branch_created` `git.committed` `git.pushed` `pr.opened`                  |
| control   | `gate.evaluated` `gate.blocked` `approval.requested` `steer.received`          |
| metering  | `usage.updated` `budget.warned` `budget.exceeded`                              |
| failure   | `error` `harness.crashed` `rate_limited`                                       |

One append-only stream serves four purposes: UI feed, audit trail, crash resume,
and eval input.

## 5. Stages, not prompts

Each stage is a **separate session** with its own prompt and tool allowlist, joined by
gates. A prompt is advice; a gate is enforcement.

```
design → branch → code → verify → test → review → approval → pr
                    ↑        │        │       │
                    └────────┴────────┴───────┘   failed gate, bounded attempts
```

| Stage    | Tools                         | Gate                              |
| -------- | ----------------------------- | --------------------------------- |
| design   | read-only                     | plan validates against schema     |
| branch   | builtin, no agent             | —                                 |
| code     | full                          | —                                 |
| verify   | full                          | `lint && typecheck` exit 0        |
| test     | full                          | suite exit 0, ≤3 attempts         |
| review   | read-only, **second harness** | zero blocking findings            |
| approval | —                             | human, only on irreversible edges |
| pr       | builtin                       | —                                 |

Three gate kinds cover everything:

- **Command** — exit code of a command in the worktree. Deterministic and cheap; prefer it.
- **Predicate** — expression over structured output the agent returned. The agent calls
  `stage_advance(stage, output)` on the gateway and the adapter validates against a JSON
  Schema, so we never parse prose to decide a transition.
- **Human** — emits `approval.requested`, parks the run, resumes on a UI decision.

Every transition is persisted to `run_stages`, so a container crash resumes at the last
gate rather than restarting the task. Because review is just another stage, **cross-model
review** is free: write with one harness, review with the other.

## 6. Tools and skills — connect once

Three scopes: an **org catalogue** of attachable servers, a **project attachment** with
config, and a **stage scope** saying which attachments are visible in which stage.

### The handshake happens in the control plane

A headless container cannot complete an interactive OAuth consent, so discovery and
authorisation happen server-side, once, with a human present:

1. User adds a server by URL in the UI.
2. Control plane calls `initialize`, then `tools/list`.
3. If auth is needed, the OAuth flow runs in the user's browser; tokens land in the
   credential service keyed by `(project, server)`.
4. The discovered tool list is cached as a snapshot with a schema digest.
5. User picks which tools and which stages. A new manifest version is written.

Runs consume the snapshot plus a broker token. They never negotiate auth.

Two classes of server, and the UI must distinguish them: **remote HTTP/SSE** attach
instantly; **built-in stdio** need the command present in the golden image and therefore
an image release.

### The adapter is an MCP gateway

The adapter connects upstream once per run and presents one merged, filtered MCP
endpoint downstream. Each harness config holds exactly **one** server entry pointing at
the adapter.

This is what makes "once" true across harnesses:

- Per-tool and per-stage filtering enforced centrally, regardless of what a harness can
  express. Claude Code can gate individual MCP tools; other CLIs often cannot.
- Uniform `tool.call` / `tool.result` events — no dependence on harness event fidelity.
- Upstream credentials never reach the harness or the agent environment.
- One upstream connection set per run rather than one per harness.
- Skills become tools (`skill_list`, `skill_load`) for harnesses with no native primitive.

The gateway also exposes `stage_state`, `stage_advance`, `task_context`, `run_check`
and `ask_user`.

**One deliberate exception:** where a harness has native skills, use them. Claude Code
gets real files in `.claude/skills/` for progressive disclosure, and uses the gateway
only for MCP servers. Levelling down to the weakest harness is the wrong consistency.

### Skills resolution

Precedence, highest first: **repo-native** (`.claude/skills/` in the worktree) →
**project attachment** → **org library**. The UI must show the resolved set with each
skill's origin; a shadowing rule nobody can see is a rule nobody trusts.

### What still needs a human

Nothing per task, per run or per harness. Each run does open a transport session to
each upstream server at boot using a stored token — connection in the TCP sense, not
the product sense, a few hundred milliseconds inside bootstrap.

Re-auth is needed only when: a refresh token is revoked or expires, a broader OAuth
scope is required, or the provider issues no refresh token. Two things keep that rare:

- **Prefer org-owned credentials over personal ones.** A token tied to a person breaks
  when they leave, and makes every run act as them in downstream audit logs.
- **Give every connection a health state** — `ok` / `needs_reauth` / `unreachable` —
  refreshed on a schedule. A `needs_reauth` on a _required_ attachment blocks dispatch
  with a clear message rather than failing a run thirty minutes in.

## 7. Streaming and steering

The container dials out; the control plane never dials in. One outbound WebSocket per
run carries events up and control frames down. No inbound ports, and no dependence on a
platform log-tail or exec API — the biggest source of lock-in in container platforms,
avoided by a decision made for firewall reasons.

Two details decide whether steering feels good:

- **Queue, then inject at a `turn.boundary`.** A message arriving mid tool-call waits.
  Show it immediately as pending and confirm when the adapter injects it — the user sees
  their input land without being told the wrong thing about when it took effect.
- **Interrupt is a separate verb.** "Stop" jumps the queue; "also check auth" does not.

On reconnect the adapter replays from its last acked `seq`.

## 8. Credentials

Nothing sensitive goes in an environment variable — anything there can be read by a
`Bash` tool call and printed into a transcript. A broker on a unix socket hands out
short-lived credentials on demand, which also gives an access log and the ability to
refuse a request from a stage that should not need it.

- **GitHub**: a GitHub App. The private key never leaves the control plane. Installation
  tokens are scoped to the project's repos, 1 h TTL. A git credential helper
  (`intellidev-cred git`) pulls on demand, so a run that outlives its token keeps
  working — the push at minute 90 transparently gets a fresh one.
- **Seats**: OAuth material written to the harness credential file at boot and refreshed
  by the broker. One file per run container, for the one seat that run was assigned.
- **MCP upstreams**: held by the gateway, never handed to a harness.

## 9. Seats as a scheduled resource

Because harnesses authenticate with subscription seats, the limit is a rolling window on
a shared **account**, not on a project. The seat becomes something the control plane
allocates like a host.

```sql
UPDATE seats SET held = held + 1
WHERE id = (
  SELECT s.id FROM seats s
  JOIN seat_windows w ON w.seat_id = s.id AND w.window_start = current_window()
  WHERE s.pool = $1
    AND s.held < s.concurrency_cap
    AND w.consumed_est < s.plan_ceiling * 0.95
  ORDER BY w.consumed_est ASC
  LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING id;
```

- **Admission control, not failure.** No headroom → task stays `waiting_capacity` with a
  reset countdown. A run that dies at 40% has burned spend and left a half-finished
  branch; a queued task cost nothing.
- **Cap concurrency per seat.** Start at 1–2 and raise on evidence; parallel runs on one
  account trip rate limits in ways that look like random failure.
- **On 429, park — don't die.** Finish the current tool call, park at the next gate,
  resume when the window rolls over.

Remaining quota is an **estimate we maintain** from per-turn token records. Label it as
one in the UI. On an elastic runtime this is the _only_ capacity constraint in the
system — compute stretches, so tasks queue for a seat, never for a container.

## 10. Data model

| Table                          | Holds                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `projects`                     | name, repos, current manifest version, default harness, seat pool                  |
| `manifests`                    | immutable versioned YAML + bundle digest — runs pin a version                      |
| `tasks`                        | title, description, details, acceptance criteria, status                           |
| `runs`                         | task, manifest version, harness, seat, branch, stage, status, `seq_hwm`            |
| `run_events`                   | append-only canonical stream, sequence-numbered per run                            |
| `run_stages`                   | one row per stage: session token, gate result, attempts, output                    |
| `approvals`                    | requested/decided, actor, reason                                                   |
| `credentials`                  | kind (`seat` \| `api_key` \| `github_app` \| `mcp_oauth`), material, refresh state |
| `seats`                        | pool, account label, credential, concurrency cap, window length, ceiling           |
| `seat_windows`                 | seat, window start, consumed estimate, projected reset                             |
| `usage_records`                | run, project, **seat**, tokens in/out/cache, estimated cost                        |
| `tool_servers`                 | org catalogue: kind, endpoint or command, auth kind, min image version             |
| `tool_attachments`             | project, server, config, `required`, enabled tools, stage scope                    |
| `tool_snapshots`               | server, discovered tools + schemas, digest, `verified_at`                          |
| `skills` / `skill_attachments` | org or project scope, version, S3 key, stage scope                                 |

Task status: `not_started → dispatched → running → in_review → done`, plus
`waiting_capacity`, `blocked`, `failed`.

## 11. Runtime portability

The orchestrator sits behind two interfaces so the runtime stays a swap:

- **`Runner`** — `create`, `start`, `stop`. Docker for the local dev loop, Fargate deployed.
- **`CacheProvider`** — `prepare(project) → path`. S3 by default; bootstrap asks for a
  prepared path and never assumes a bind mount.

What keeps portability real: the adapter dials out, credentials come from our broker,
and no privileged mode is required. What would cost work on a migration day: the cache
strategy (behind `CacheProvider`, so one implementation) and egress enforcement.

**AWS specifics that matter:**

- **Avoid the NAT gateway.** It bills hourly whether or not anything runs. Use a public
  subnet with an assigned public IP plus an **S3 gateway VPC endpoint**.
- **One task definition**, not one per project. `RunTask` overrides carry env and command.
- **Size ephemeral storage explicitly** from the manifest; the default is modest.
- **Egress allowlist is a security group plus VPC endpoints** — enforcement outside the
  container, where a compromised run cannot reach it. This is the strongest security
  argument for this runtime and the reason that work is configuration, not code.
- **Fargate Spot is viable later** precisely because stages are persisted: an interrupted
  run resumes at its last gate.

## 12. Decisions taken

| Decision                             | Why                                                 | Watch for                                       |
| ------------------------------------ | --------------------------------------------------- | ----------------------------------------------- |
| Project identity ≠ run execution     | Concurrency and crash safety by construction        | —                                               |
| ECS Fargate, scale-to-zero           | No idle cost, no capacity ceiling to design for     | NAT gateway; nested containers unavailable      |
| 60–120 s dispatch budget             | Deletes the warm pool, pre-warming, start-time work | UI must show bootstrap progress                 |
| S3 caches, not EFS                   | No multi-attach problem, no idle storage floor      | Prune caches for idle projects                  |
| Subscription seats                   | Materially lower cost per run                       | Confirm provider terms; keep an `api_key` path  |
| Stages as a state machine with gates | Enforcement, resumability, cross-model review       | Gate quality is the real quality ceiling        |
| Adapter as MCP gateway               | Makes connect-once true across harnesses            | Adapter must be MCP client _and_ server         |
| Exactly two harnesses                | Enough to prove the abstraction, not more           | Add a third only behind a driver                |
| No nested containers                 | Keeps the platform list open; Fargate needs it      | Route to EC2 capacity provider if ever required |

## 13. Costs

Workload model: a run is 2 vCPU / 4 GB for ~45 minutes. Wall clock is dominated by
model latency and turn count, not CPU.

| Line item                     | 100 runs/mo | 500 runs/mo | 2 000 runs/mo |
| ----------------------------- | ----------- | ----------- | ------------- |
| Fargate task time             | $8          | $40         | $160          |
| S3 caches + ECR               | $4          | $4          | $6            |
| Control plane (API, ALB, RDS) | $52         | $52         | $55           |
| **Total infrastructure**      | **~$65**    | **~$96**    | **~$220**     |

Infrastructure is low single-digit percent of total cost — a single top-tier seat
typically exceeds the whole infra bill at 500 runs. **The cost lever is seat count and
how efficiently a run consumes its window**, not compute. Graviton (~20% cheaper) and
Spot are tidy P4 wins worth ~$25/mo; spend no early engineering time on them.

Where cost surprises: EFS if ever adopted (~$30/mo per 100 GB, never scales to zero),
a NAT gateway added later, and **runs that hang rather than fail** — which is why the
per-stage timeout, run TTL (~90 min) and idle kill are not optional.

Break-even against an always-on instance: a t3.medium is cheaper above ~42% utilisation
(~400 runs/mo), but caps concurrency at one run. The good answer at that point is an
**ECS capacity provider strategy** — `base: 1` on EC2, overflow to Fargate — which is
configuration, not code, and hands back nested containers.
