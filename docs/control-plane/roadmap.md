# Roadmap after the skeleton

Each milestone has a **trigger** — the observation that says build it now. Nothing here
is scheduled; it is pulled when its trigger fires. [milestone-0.md](milestone-0.md) is
the only thing committed to up front.

## M1 · Process as data

Stage templates edited in the UI rather than checked into a repo. Predicate gates with
JSON Schema validation on `stage_advance`. Cross-model review wired properly — write
with one harness, review with the other. Human approval gates on irreversible edges
(PR open, migration apply), parking the run and resuming on a UI decision.

**Trigger:** the first time someone wants a different process for a second project, or
the first PR that passes every gate and is still wrong.

**Why it matters:** gate quality is the real quality ceiling. The stage machine enforces
exactly what the repo can verify — a project with a weak suite will produce
confidently-wrong PRs. Early projects should be ones whose tests are worth gating on.

## M2 · Tools and skills at scale

The full connect-once flow: org catalogue, OAuth handshake in the control plane, tool
snapshots with schema digests, per-tool and per-stage scoping in the UI, connection
health states (`ok` / `needs_reauth` / `unreachable`) on a schedule, drift detection when
an upstream tool list changes. Skills authoring and versioning in the UI, with resolved
origin displayed.

**Trigger:** the second MCP server attachment, or the first time a token expiry breaks a
run.

**Do early regardless:** prefer org-owned credentials over personal ones. Retrofitting
that means re-authorising every attachment.

## M3 · Seats and metering

Seat pool as a scheduled resource. Assignment at dispatch with
`FOR UPDATE SKIP LOCKED`. Admission control so tasks queue on `waiting_capacity` with a
reset countdown instead of failing. Rolling-window estimates per seat. Usage ledger
stamped with `(run, project, seat)`. Per-run and per-day budgets with `budget.warned` at
80% and park-at-next-gate at 100%.

**Trigger:** more than one concurrent run, or the first rate-limit failure that looked
like a random crash.

**Cannot be deferred:** the `seat` column on `usage_records`. Land it in M0 or
per-project cost attribution is unrecoverable.

## Deployment · ECS Fargate

Broken into tasks in [aws-ecs-plan.md](aws-ecs-plan.md). Runs alongside the milestones below
rather than after them: A1–A3 touch no application code, and B1 (Postgres) is what M3 needs
anyway.

**Trigger:** the local path is validated end to end — task in, commit out, tools and credentials
connected once. That has happened.

## M4 · Hardening

Egress allowlist as security groups plus VPC endpoints — enforcement outside the
container. Broker access logging and per-stage credential refusal. Audit views over
`run_events`. Run TTL and idle-kill tuning from measured p90s. Secret rotation drills.

**Trigger:** before pointing the system at any repo you would be upset to lose, and
before any external user can create a project.

**The one rule:** never mount a host Docker socket, under any deadline. If a project
needs testcontainers, route it to an EC2 capacity provider where privileged mode exists.

## M5 · Efficiency

Graviton golden image (~20% cheaper, if native deps are ARM-clean). Fargate Spot for
`code` and `test` stages — viable precisely because stages are persisted, so an
interruption resumes at the last gate. Derived images for projects with slow dependency
installs. Cache pruning for idle projects. ECS capacity provider strategy with `base: 1`
on EC2 and overflow to Fargate.

**Trigger:** ~300–400 runs/month, where an always-on instance passes break-even
utilisation. Worth roughly $25–100/month — deliberately last, because infrastructure is
low single-digit percent of total cost and seats are the real lever.

## Dropped, not deferred

| Idea                              | Why it is gone                                                   |
| --------------------------------- | ---------------------------------------------------------------- |
| Warm pool                         | The managed runtime plus a 60–120 s budget remove the need       |
| Multi-host scheduling             | Fargate supplies elasticity                                      |
| Shared cache volumes (EFS)        | Multi-attach limits and a permanent idle cost floor              |
| Long-lived per-project containers | Two runs on one project would contend for a worktree             |
| Harness-specific platform forks   | A new harness is a driver plus a capability record, never a fork |
