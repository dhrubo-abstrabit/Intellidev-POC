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

### Harness capability matrix

Measured against real captures of `claude-code 2.1.228`, `codex-cli 0.147.0` and
`opencode 1.18.16`. The gaps run in **every** direction, which is why the adapter
declares them rather than reducing everything to what the weakest harness can do.

| Capability               | Claude Code             | Codex                     | **opencode** (default)  | How the adapter compensates                                                              |
| ------------------------ | ----------------------- | ------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| Mid-run steering         | yes, streaming stdin    | **no**                    | **no**                  | Both one-shot harnesses queue; the engine folds the steer into the next attempt's prompt |
| Token deltas for live UI | yes                     | **no**                    | **no** on `run`         | opencode's _server_ stream has deltas — see the upgrade note below                       |
| Native skills            | yes                     | **no**                    | yes, `skills.paths`     | Codex gets `skill_list`/`skill_load` as gateway tools instead                            |
| Per-tool permissions     | yes                     | **no**, sandbox mode only | yes, `permission` rules | For Codex the gateway enforces the whole policy                                          |
| Native structured output | **no**                  | yes, `--output-schema`    | **no**                  | Others go through the gateway's `stage_advance` tool                                     |
| Window reset + status    | yes, `rate_limit_event` | not in `exec`             | **no**                  | Codex via app-server; opencode is provider-agnostic so has no single window              |
| Window used percent      | **no**                  | yes, via app-server       | **no**                  | Claude Code utilisation stays derived                                                    |
| Cost per turn            | yes, `total_cost_usd`   | **no**                    | yes, per step           | Codex leaves `usdEst` absent rather than deriving it from a rate card                    |
| Self-report of tools/MCP | yes, `system/init`      | **no**                    | **no**                  | Only Claude Code enumerates its tools                                                    |

No two capability records match, and a test asserts that — if any pair did, a driver
would be describing a harness nobody measured.

**Why opencode is the default.** It is the richest projection target: native skills,
MCP local _and_ remote servers, an `instructions` array, and per-tool permission
rules. The cost is no token deltas on the `run` path, so its live feed shows settled
messages rather than a token stream. Pointing that driver at `opencode serve` and its
SSE stream would recover deltas — the upgrade path if the UI needs them.

### Wire formats: three, all different

| Harness     | Shape                                            | End-of-turn signal                |
| ----------- | ------------------------------------------------ | --------------------------------- |
| Claude Code | message content blocks                           | `result`                          |
| Codex       | typed items in `item.started` / `item.completed` | `turn.completed`                  |
| opencode    | message parts in `{type, part}`                  | `step-finish` with `reason: stop` |

There is deliberately no shared base class between the mappers — an abstraction over
three dissimilar shapes would cost more than it saves. What they share is the output
type, which is the only thing anything downstream depends on.

**A correction worth keeping.** opencode's server SSE stream and its
`run --format json` stream are **different formats**. The first version of that driver
was written from the server's OpenAPI schema and was simply wrong: `run` emits parts,
not `session.next.*` events. Capture beats inference, which is why every driver here is
pinned to a recorded fixture.

Three more things only a capture showed:

- **`codex exec` hangs if stdin stays open** — piped stdin is appended to the prompt as
  a `<stdin>` block, so the driver closes stdin immediately after spawn. opencode needs
  the same treatment.
- **opencode emits a `tool` part once, already completed**, so one raw event has to
  become both `tool.call` and `tool.result` or the UI shows an orphaned result.
- **opencode has no file-change event** — a write is a tool call, so `file.changed` is
  derived from write-tool names plus the input path, the same way the Claude Code driver
  does it.

### Config projection per harness

What T8 writes at boot. opencode's config is a single JSON file and covers the most
ground, which is the other half of why it is the default.

| Concern           | Claude Code                 | Codex                       | opencode                                                     |
| ----------------- | --------------------------- | --------------------------- | ------------------------------------------------------------ |
| MCP servers       | `.mcp.json`                 | `config.toml [mcp_servers]` | `mcp.<name>` — local or remote, with headers and OAuth       |
| Skills            | `.claude/skills/`           | gateway tools               | `skills.paths` / `skills.urls`                               |
| Repo context      | `CLAUDE.md`                 | `AGENTS.md`                 | `instructions[]` — an array, so several files                |
| Tool policy       | `settings.json` permissions | `-s <sandbox>`              | `permission.{read,edit,bash,…}` + `tools.<name>`             |
| Per-stage persona | system append               | prompt prefix               | `agent.<name>` with its own model, prompt, tools, permission |
| Model             | `--model`                   | `-m`                        | `model`, or `--model provider/model`                         |

### Reaching Codex usage data: the app-server option

Neither CLI exposes usage through a plain non-interactive subcommand — `/status` and
`/usage` are TUI-only, `codex login status` reports login only, and `codex doctor`
reports auth configuration only. Claude Code does not need one, because
`rate_limit_event` already arrives inline in the stream we parse.

Codex has a **richer** path than `exec --json`, just not on the road we are on. The
experimental `codex app-server` JSON-RPC protocol exposes:

| Item                                   | Carries                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GetAccountRateLimits`                 | `RateLimitSnapshot`: primary + secondary windows, `planType`, `rateLimitReachedType`, credits |
| `RateLimitWindow`                      | **`usedPercent` (required)**, `resetsAt`, `windowDurationMins`                                |
| `AccountRateLimitsUpdatedNotification` | pushed when the window moves                                                                  |
| `ThreadTokenUsageUpdatedNotification`  | `TokenUsageBreakdown` plus `modelContextWindow`                                               |

So on utilisation the asymmetry **reverses**: Codex can report an exact percentage,
while Claude Code gives status and reset time but no number. Neither harness alone
gives us both halves.

**Not adopting this for M0.** It is marked experimental, it is a second protocol to
track alongside `exec --json`, and seat metering is M3 work. Recorded because when M3
arrives this is the difference between an estimated utilisation bar and a real one.
Regenerate the bindings to check the shape rather than trusting this table:

```sh
codex app-server generate-json-schema --out <dir>   # or generate-ts
```

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
(`.claude/skills/`) and opencode (`skills.paths`) both load skills from a directory with
progressive disclosure, so they get real files and use the gateway only for MCP servers.
Only Codex, which has no skill primitive, gets `skill_list` / `skill_load` as tools.
Levelling all three down to the weakest would be the wrong consistency.

### What the gateway can and cannot infer

One honest limit, written down because guessing here would be worse than asking. A
`read_only` stage policy **cannot** tell us whether a third-party MCP tool mutates
anything — the protocol carries no such signal. So:

- **Mode gates the built-ins we wrote**, whose behaviour we know.
- **Upstream tools are scoped explicitly**, by attachment stages and deny patterns.

Inferring read-only-ness from a tool's name would be a guess dressed as a control.

Three implementation details that matter more than they look:

- **Filtering applies to `tools/call`, not just `tools/list`.** A harness may hold a list
  from an earlier stage, so a tool absent from the list is also refused when invoked.
  Hiding without refusing makes the filter decoration. There is a protocol-level test
  that lists during `code`, calls during `design`, and expects a refusal.
- **Upstream names are namespaced `server__tool`**, and over-long names are truncated
  with a stable digest rather than simply cut — two tools sharing their first 60
  characters would otherwise collapse into one name and route to the wrong server.
- **JSON Schema is forwarded unchanged.** The gateway uses the SDK's low-level `Server`
  with raw request handlers rather than `registerTool`, which takes a Zod shape:
  converting a proxied schema to Zod and back would lose fidelity in exactly the field
  an agent relies on to call the tool correctly.

A tool failure is returned as **content**, never as an MCP error. An error aborts the
turn; a message lets the agent read the failure and try something else. Refusals are
emitted as `tool.denied` rather than swallowed, because a silently missing tool is one of
the hardest things to diagnose from a transcript.

### Named checks come from the gates

`run_check` does not take a configured list of commands. It exposes exactly the command
gates in the stage template, so the agent runs _the same command its gate will run_. A
separate list would drift, and an agent that passes its own check but fails the gate is
the most confusing outcome available.

### ask_user, honestly

An unattended run has nobody to answer. `ask_user` records the question in the event log
and tells the agent to proceed on its best judgement, stating the assumption so a
reviewer can check it. Pretending an answer is coming would make the agent wait, and a
waiting agent burns the run's wall-clock budget for nothing.

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

### What makes the broker a boundary, and what does not

A unix socket is **not** secret from a process running as the same user. If the adapter
and the harness shared a uid, the agent could simply connect to the socket and ask for a
GitHub token — the broker would be bookkeeping, not a boundary.

So the container runs **two uids**:

|         | uid | Can open the socket                 | Does                                        |
| ------- | --- | ----------------------------------- | ------------------------------------------- |
| Adapter | A   | yes                                 | all git and PR work, gates, the MCP gateway |
| Harness | B   | **no** — socket is 0600, owned by A | writes code in the worktree                 |

The agent therefore cannot obtain a GitHub token, and if it runs `git push` itself the
push fails — which is correct, because pushing is ours, not the model's. The worktree is
writable by B; the socket is not.

Project secrets are the deliberate exception: they land in the environment of the
processes that run tests, which the agent can read. That is accepted and bounded by
sandbox attestation and the egress allowlist (§8b), not pretended away.

Three properties the broker buys, in order of importance:

1. **Pull, not push.** Nothing long-lived sits in the environment, and refresh is
   automatic because every request checks expiry first.
2. **An audit trail.** Every credential use is a recorded request, including refusals.
   An injected environment variable leaves no such trace.
3. **Stage scoping.** A request can be refused because the stage asking has no business
   with it. This is the one thing an environment variable can never do.

Refresh happens **before** expiry by a 60-second margin, and concurrent callers share a
single fetch — four git operations starting at once must not mint four tokens.

- **Seats**: OAuth material written to the harness credential file at boot and refreshed
  by the broker. One file per run container, for the one seat that run was assigned.
- **MCP upstreams**: held by the gateway, never handed to a harness.

## 8b. Git and environment, per project

### Git

One GitHub App, installed against selected repositories. The App's private key never
leaves the control plane; installation tokens are minted per run, scoped to that
project's repos, 1 h TTL, and pulled on demand through the broker (§8) so a run that
outlives a token keeps working.

| Concern            | Decision                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Host               | GitHub only for M0. A second host is a credential provider, not a redesign.                                                                    |
| Repos per project  | One primary repo. `repos[]` is plural for later; the worktree logic assumes one.                                                               |
| Commit identity    | The App's **bot** identity, never a person. A run is not a human, and attributing its commits to one makes `git blame` lie.                    |
| Clone              | Blobless partial clone by default — full history, blobs on demand. Big repos are otherwise most of the cache-restore budget.                   |
| Isolation          | Mirror restored from S3 per run, then `git worktree add`. Each run has its own copy, so concurrent runs never contend.                         |
| LFS / submodules   | Opt-in. Both need the credential helper too, so neither is assumed.                                                                            |
| Base moved mid-run | **Report, don't rebase.** A silent rebase can turn a clean diff into a wrong one.                                                              |
| Failed run         | Delete the run's branch, so failures don't litter the remote.                                                                                  |
| Protected `main`   | Fine, and desirable — the PR is the boundary. Force-push and history rewrite are deny-listed in the adapter, not just discouraged in a prompt. |

### Traps the git integration tests caught

Both were found by running real git against temp repos rather than mocking it, and
neither would have surfaced any other way:

- **A bare mirror has no remote-tracking refs.** `origin/main` does not resolve in a
  worktree cut from a bare clone, so the base-moved check reads `FETCH_HEAD` instead —
  which `git fetch` writes regardless of ref layout.
- **`spawn` fails with `ENOENT` when the _cwd_ does not exist**, not just when the binary
  is missing. Probing for a mirror by running git inside a directory that has not been
  created yet reads as "git is not installed" and sends you hunting the wrong problem.

Four environment settings are also non-negotiable, each fixing something miserable to
diagnose headlessly: `GIT_TERMINAL_PROMPT=0` and empty `GIT_ASKPASS`/`SSH_ASKPASS` (a
failed auth would otherwise **hang forever** on a prompt nobody can answer),
`GIT_CONFIG_NOSYSTEM=1` with a pinned `HOME` (so a developer's global config cannot
change what a run does), and author/committer passed explicitly rather than inherited.

### The PR body is assembled, not written

A reviewer needs to know what actually happened. A model summarising its own work is
exactly the wrong source for that, so the description is built from the event log:

| Section        | Source                                                  |
| -------------- | ------------------------------------------------------- |
| What was asked | the task brief, including acceptance criteria           |
| What changed   | `diff.produced` and deduplicated `file.changed` events  |
| Checks         | `gate.evaluated` command gates, **with attempt counts** |
| Review         | the review stage's validated structured output          |
| How this ran   | harness, stage path with retries marked, tokens, cost   |

Attempt counts matter: a suite that passed on the third try is a different signal from
one that passed first time, and hiding that from a reviewer would be the whole system
lying by omission. The body ends with a comment saying it was assembled from the log.

Two related decisions. **Commit messages are deterministic** — derived from the task, so
two runs of the same task produce the same message, and a message is not the place for
creativity. And **a run that changed nothing opens no PR**: finding that out in the
builtin stage costs a second, while a reviewer finding an empty PR costs their attention.

### Environment: the uncomfortable part

A test suite reads `process.env`. There is no way to hand `pnpm test` a database URL
through a unix socket. So **any secret a run's tests need is reachable by the
model-authored code in that container** — it can read the environment, read the
rendered `.env`, or write a test that prints one.

That collides with the non-negotiable "no long-lived secrets in the container
environment", and the honest resolution is to narrow the claim rather than pretend the
container is a boundary it is not:

> Broker-held credentials — GitHub tokens, seat material, MCP upstream tokens — never
> become environment variables, because nothing inside the container except the adapter
> needs them. Project secrets that tests genuinely need **do** become environment
> variables, and are therefore assumed compromised by the run.

Hiding is not the control. **Scoping is.** Three tiers, deliberately separate:

| Tier               | Where it lives                                                    | Visible to the agent   |
| ------------------ | ----------------------------------------------------------------- | ---------------------- |
| `env.vars`         | plaintext in the manifest, versioned                              | yes, by design         |
| `env.secrets`      | a _reference_ to a vault entry; the value is resolved at dispatch | yes, once materialised |
| Broker credentials | never in env at all                                               | no                     |

Four rules follow, and the schema enforces the first two:

1. **Every secret must be attested sandbox-scoped.** `sandboxAttested` defaults to
   `false`, so silence is treated as production and dispatch refuses. Production
   credentials do not enter a run container.
2. **`SecretRef` is `.strict()` and has no value field**, so a secret cannot be pasted
   into a manifest that gets versioned and read in a PR diff.
3. **Secrets are stage-scoped**, exactly like tool attachments. The design stage has no
   business holding database credentials.
4. **Reserved names are rejected.** A project quietly setting `GITHUB_TOKEN` would break
   the credential helper in a way that surfaces as a git failure three stages later.

The real containment is the **egress allowlist** (§12): a leaked sandbox key is worth
little if the network refuses to carry it anywhere.

### Redaction happens at the bus

The event log is the one artefact that leaves the container — it goes to Postgres, to
the UI, to the audit trail. A secret only has to be printed once, by a test or a stack
trace, to be in that log permanently.

So every string in every payload is scanned **at the event bus**, before the event is
numbered and persisted. Not at call sites: call sites cannot be trusted to remember,
and one missed site is a leak that outlives the run.

Two details that matter in practice. Longer secrets are replaced first, so a secret
that is a prefix of another cannot leave a recognisable tail behind. And values shorter
than eight characters are **never** redacted — redacting `test` would turn the whole log
into markers and destroy the ability to debug anything. Short secrets are a project
configuration problem, and the redactor reports them as skipped rather than pretending.

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

### What the harness actually tells us

Corrected after recording real CLI output in T2, which contradicted the assumption that
quota is entirely ours to infer. Claude Code emits a `rate_limit_event` carrying
`rateLimitType` (e.g. `five_hour`), `resetsAt` and a `status` — so **window reset time
and status are authoritative**, not estimated. Token counts are reported per turn with
cache reads and writes broken out, plus `total_cost_usd` at the end.

What remains ours to estimate is **how much of the window is consumed**, since Claude
Code publishes no percentage. The UI should therefore show the reset countdown and
status as fact, and label only the utilisation bar as an estimate.

Codex is the mirror image: its `exec --json` stream carries no window state at all, but
its app-server protocol reports an exact `usedPercent` — see the capability matrix in §4.
Neither harness gives us both halves, so the seat ledger keeps its own running total
regardless and treats harness-reported figures as corrections to it.

`system/init` additionally reports each MCP server's `status`, which feeds connection
health for free rather than needing a separate probe.

On an elastic runtime seats are the _only_ capacity constraint in the system — compute
stretches, so tasks queue for a seat, never for a container.

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
