# Deploying to AWS — ECS Fargate

Task breakdown for moving the validated local path onto AWS. Decisions already taken live in
[architecture.md §11](architecture.md); this document is only the work.

## Where each piece runs

| Piece                  | Local today                | On AWS                                   | Scales to zero |
| ---------------------- | -------------------------- | ---------------------------------------- | -------------- |
| UI                     | browser → :4000            | browser → ALB                            | n/a            |
| **Control plane**      | `pnpm ui` on your Mac      | **long-lived Fargate service**           | **no**         |
| Postgres               | in-memory `Store`          | Supabase (managed, outside the VPC)      | no             |
| **Orchestrator**       | stage engine in the runner | **unchanged — still in the runner**      | yes            |
| Adapter + harness      | `docker run` per task      | **one Fargate task per run** (`RunTask`) | yes            |
| Caches, bundles, specs | named volume + bind mounts | S3                                       | yes            |

### Who starts and stops the container

| Concern                   | Local today                               | On AWS                                               |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| Launch                    | control plane runs `docker run`           | control plane calls `ecs:RunTask`                    |
| Placement, image pull     | local Docker                              | **ECS scheduler + Fargate** — not our code           |
| Knowing it finished       | `launch()` awaits the child process       | `run.finished` event, plus EventBridge as safety net |
| Cancel                    | `docker kill`                             | `ecs:StopTask`                                       |
| Wall-clock / idle timeout | control plane's own `setTimeout` kills it | **nothing — ECS has no task timeout.** Ours to build |
| Cleanup                   | `--rm` removes the container              | task and its ephemeral storage die with it           |

**ECS is the container orchestrator.** We ask for a task and it handles placement, the image pull,
the run and the reaping. What ECS does _not_ do is bound the task's life or tell our code that a run
ended — those two are the work in C1, C5 and E1.

Two things worth being explicit about, because they are the most common misreading:

- **The orchestrator is not a service.** It is the stage engine (`stages/engine.ts`) running
  _inside_ each run container. Nothing on AWS decides what stage runs next; the control plane says
  "run this spec" and then only watches. That is deliberate — a control-plane restart cannot strand
  a half-finished run.
- **The control plane is the one thing that cannot scale to zero.** It serves the UI, holds SSE
  connections, and answers the credential broker. Everything else is per-run and idles at $0.

## Decisions taken

Settled 2026-08-20. Renamed from D1–D5, which collided with the Phase D task numbers —
every bare "D1"/"D2"/"D3" elsewhere in this document means the **Phase D task**.

| #   | Question               | Settled                                                                                                          |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Q1  | IaC tool               | **AWS CDK (TypeScript)** — same language as the repo; the app lives in `infra/aws`                               |
| Q2  | Control-plane hosting  | **Fargate service + ALB** — App Runner's per-request timeout ceiling is hostile to long-lived SSE connections    |
| Q3  | Database               | **Supabase Postgres 17**, plain Postgres only — see below                                                        |
| Q4  | Credential storage     | **Secrets Manager**, behind the `SecretStore` interface (B2)                                                     |
| Q5  | Harness refresh tokens | **long-lived tokens + one seat per account**; credential writeback only if subscription accounts become the norm |

**On Q2.** The earlier justification — "App Runner cannot reach a VPC-only RDS" — stopped
applying when Q3 moved the database out of the VPC. ALB remains right for a different
reason: it terminates TLS, holds long-lived SSE connections, and is what allows a second
control-plane instance at all (C6).

**On Q3.** Cost was a wash — $10/mo for a Supabase project against ~$14 for
`db.t4g.micro` — so it turned on operational familiarity rather than price. What RDS gives
up is **IAM database auth**, where no database password exists at all; with Supabase one
long-lived credential does. It lives in Secrets Manager and never reaches a run container.

Three commitments, listed because each fails _silently_ rather than loudly:

- **Session-mode connection string.** Transaction pooling accepts the connection and runs
  queries normally but never delivers `LISTEN`/`NOTIFY` — which presents as a run that
  looks stalled while it is progressing, exactly the C6 failure mode.
- **`pg_advisory_xact_lock`, never `pg_advisory_lock`** (D1). Session-scoped locks do not
  survive transaction pooling.
- **No Supabase-specific features** — no Realtime, no RLS, no PostgREST, no `supabase-js`.
  B1's `Store` stays vendor-neutral, so moving to RDS later is a connection string plus a
  migration run.

**Open on Q3.** The project created for this (`wfsnuveiadnopafbxxvc`) is in
**ap-southeast-1**, not `ap-south-1` — ~55–70 ms from Mumbai against 1–5 ms same-region,
paid on every event insert. Recreate it in `ap-south-1` while it is still empty, or accept
the latency and batch event writes in B1.

## Constraints every task inherits

These are the difference between a deployment and a platform. A task is not done unless it holds
to them.

- **Every AWS capability sits behind an interface with a local implementation.** `Runner`,
  `CacheProvider`, `SecretStore`, event sink. The local loop must keep working after every task, or
  reproducing a production failure means deploying to reproduce it.
- **No resource name, ARN or region in application code.** They arrive as config resolved at boot,
  so `dev` and `prod` differ by configuration and never by code path.
- **Everything is scoped by project.** S3 keys, secret names, log groups, seats, cache prefixes. The
  local path hardcodes `projectId: 'local'` — that is known debt, and the first task that touches a
  resource name should retire it rather than copy it.
- **Every AWS call is retried and idempotent.** Throttling is normal. Dispatch keyed on `runId` so a
  retried call cannot launch two containers for one run.
- **Least privilege, three separate roles.** Control-plane role, task execution role (pull image,
  write logs), task role (its own S3 prefix and nothing else). A run must never hold credentials it
  did not ask the broker for.
- **The control plane must be stateless.** Any in-process state is a ceiling of one instance —
  which is exactly what D1 and C6 exist to remove.
- **Each task ships the signal that proves it works** — a metric, a log line, or an event. "It
  seemed to work" is not an acceptance criterion.
- **Each task carries a test that fails without it.** For infrastructure that means a deploy-time
  assertion or a smoke check, not a unit test for its own sake.

## Phase A · Foundations

### A0 · AWS access and CLI authentication — **done**

- **Goal** anyone picking up this plan can reach the account from a terminal, without a long-lived
  key on disk.
- **Settled** region is **`ap-south-1`** — every stack, bucket and repository goes there unless a
  task says otherwise.
- **Interactive access** is `aws login`, which vends temporary, self-refreshing credentials for an
  **IAM user** (`user/Abstrabit_Internal_Tech`) — not an assumed role, as an earlier draft of this
  section claimed. Nothing long-lived is on disk, which was the actual goal, but the caller ARN is a
  user and a reader expecting a role ARN will not find one. Sessions expire; `aws login` again.
- **Unattended access** is the `intellidev` profile: an access key on
  `user/intellidev-deploy-cli`, whose _only_ permission is `sts:AssumeRole` on the
  `IntellidevDeploy` role, which holds the actual deploy policy. The CLI refreshes the assumed-role
  credentials on its own, so a long deploy cannot expire halfway. A leaked key can do exactly one
  thing, and revocation is deleting one role.
- **Done** `cdk bootstrap` has run — bootstrap version **32**, default qualifier `hnb659fds`. The
  account id is resolved at deploy time from `aws sts get-caller-identity` and written down nowhere.
- **Known deviation** a non-`--trust` bootstrap attaches `AdministratorAccess` to the
  CloudFormation execution role, and `IntellidevDeploy` needs IAM write access because CDK creates
  the task roles in A2 and C1. Tighten both together before B1: re-bootstrap with
  `--custom-permissions-boundary` and scope the execution policy.
- **Environment then found** AWS CLI 2.36.25, no CDK installed (`npx aws-cdk` is fine), Node 24.17.

**Recommended — console session, auto-refreshing** (simplest for local dev):

```bash
aws login                      # opens a browser, pick the console session
aws sts get-caller-identity    # must print an account and an ARN
```

- Acquires temporary credentials plus a refresh token and renews them itself, so nothing
  long-lived is stored.

**If the org uses IAM Identity Center** (preferred once there is more than one person):

```bash
aws configure sso              # start URL, region, account, role → name the profile
export AWS_PROFILE=intellidev-dev
aws sts get-caller-identity
```

**Last resort — access keys.** A long-lived secret in `~/.aws/credentials`; only if neither of the
above is available, and rotate it:

```bash
aws configure                  # access key, secret, region, output
```

**Then, regardless of method:**

```bash
aws configure set region ap-south-1        # already set
aws sts get-caller-identity               # confirm the session is live
npx aws-cdk@latest --version              # no global install needed
npx aws-cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/ap-south-1"
```

- **Verify the region really applies**, not just that it is configured:
  `aws ec2 describe-availability-zones --query 'AvailabilityZones[0].RegionName' --output text`
  must print `ap-south-1`.
- **Done when** `aws sts get-caller-identity` works in a fresh shell and `cdk bootstrap` has
  succeeded once.
- **A session expires.** When any AWS call starts failing with an expired-token error, run
  `aws login` again — it is not a broken setup.
- **Never** commit credentials, and never bake them into the image — the runner gets its permissions
  from its **task role**, not from a key.
- **For CI later** use GitHub OIDC with a deploy role. No access keys in Actions secrets.

### A1 · IaC skeleton and environments — **done**

- **Goal** one `infra/aws/` CDK app with a `dev` stage that deploys nothing but a VPC.
- **Shipped** `@intellidev/infra-aws` as a workspace package, so its assertions run inside the
  existing `pnpm check` rather than in a gate of their own. `lib/config.ts` is the environment
  table; `lib/naming.ts` is the only place a resource name is formed; `lib/build-app.ts` holds the
  wiring so the tests assert the template that actually deploys.
- **The VPC** is 2 AZs, public plus private-isolated, `natGateways: 0` from the first line —
  `ec2.Vpc` defaults to one NAT per AZ, so the expensive choice is the library's default.
  `mapPublicIpOnLaunch` stays off: a public address is a per-task decision at `RunTask` time.
- **The application seam** is SSM, not CloudFormation outputs. Stacks write
  `/intellidev/<env>/network/{vpc-id,public-subnet-ids,isolated-subnet-ids}`; the control plane
  reads that prefix at boot, because it is not a CDK process and must not call CloudFormation at
  runtime.
- **The guardrail** is a CDK `Aspect` that **throws** on `CfnNatGateway` or `CfnEIP` in any stack.
  It throws rather than using `Annotations.addError`, which only makes the CLI refuse to deploy and
  leaves an in-process synth passing — an untestable rule is not a rule.
- **Tests** 20 in `test/network.test.ts`: no NAT, no EIP, the aspect itself fails when a NAT is
  added, CIDR and AZ count come from config, both SSM tiers exist, tags are applied, and `prod`
  refuses to synth without an explicit matching account.
- **Proving signal** `pnpm infra:verify` checks deployed reality, not the template — SSM resolves
  to a VPC that exists with the configured CIDR and the tags, and no NAT gateway exists anywhere in
  the region. It was confirmed to fail after `destroy`, so it is not vacuous.
- **`pnpm infra:deploy` runs `scripts/preflight.sh` first**, which refuses to deploy as the wrong
  principal, account or region. This exists because forgetting `AWS_PROFILE` deploys _successfully_
  under a different principal in the same account, bypassing the scoped role with nothing looking
  wrong until an audit.
- **Verified** deploy → verify → destroy → redeploy, all clean; `10.20.0.0/16`, no NAT gateways,
  nothing left behind but `CDKToolkit`. `pnpm check` passes, and no application code changed, so
  the local Docker path is untouched.

### A2 · Network without a NAT gateway

- **Goal** VPC where run tasks reach the internet and S3 at no idle cost.
- **Scope** public subnets, `assignPublicIp: ENABLED`, **S3 gateway VPC endpoint**, security groups;
  private subnet for RDS only.
- **Done when** a task in the VPC can `git clone` over HTTPS and `GET` from S3, and
  `aws ec2 describe-nat-gateways` returns empty.
- **Why it matters** a NAT gateway bills hourly whether or not anything runs — it is the single
  biggest way to accidentally lose scale-to-zero.

### A3 · ECR and image pipeline

- **Goal** the golden image in ECR, pinned by digest.
- **Scope** ECR repo with lifecycle policy, build-and-push script, digest recorded per deploy.
- **Done when** a task definition references a digest, not `:dev`, and rollback is a digest change.
- **Note** the image is **1.52 GB** today; pull time lands inside the dispatch budget. Measure it
  here, and if it dominates, split the harness layer or drop unused harnesses per project.

## Phase B · State the control plane needs

### B1 · Postgres replaces the in-memory store

- **Goal** tasks, runs and events survive a restart.
- **Scope** Drizzle schema for the tables in [architecture.md §10](architecture.md), migrations, and
  a `Store` implementation behind the existing methods.
- **Done when** the same API tests pass against Postgres, and restarting the control plane keeps the
  board.
- **Depends on** A1.
- **Note** the current `Store` was written to be swapped: same method names, same row shapes.
- **`run_events` needs a retention policy, and there was none anywhere in this plan.** It is the
  dominant table by volume: 35 event types, previews capped at 2 000 chars, order 10²–10³ events
  per run — roughly 0.5–5 MB a run, so 0.25–2.5 GB/month at 500 runs, growing without bound. It
  also sits on the live streaming path, since SSE backfill and C4's reconnect-replay both read it.
  Supabase Pro includes 8 GB, which makes this land inside the first year. Decide retention (and
  whether terminal runs collapse to a summary) as part of the schema, not after.

### B2 · Credentials into Secrets Manager

- **Goal** MCP OAuth tokens and harness seat credentials leave the `0600` JSON files.
- **Scope** a `SecretStore` interface with a local file implementation and a Secrets Manager one;
  migrate `McpRegistry` and `HarnessAccounts` behind it.
- **Done when** no credential is written to disk on the control plane, and the local dev path still
  works unchanged.
- **Depends on** A1.

### B3 · Run identity and the broker over HTTPS

- **Goal** a run authenticates to the control plane, so credentials are pulled rather than passed.
- **Scope** per-run token minted at dispatch, `ControlPlaneCredentialProvider` (already written)
  pointed at the real API, token-scoped endpoints for git / seat / mcp / secrets.
- **Done when** a run holds no credential in its environment — only its own run token.
- **Depends on** B1, B2.
- **Why it matters** today `INTELLIDEV_SEAT_MATERIAL` and MCP tokens travel in the task environment,
  where model-authored code can read them. This is what closes that.

## Phase C · The run path

### C1 · `FargateRunner`

- **Goal** dispatch launches a Fargate task instead of `docker run`.
- **Scope** implement the `Runner` interface with `RunTask`, overrides for env and command, task ARN
  as the run handle, `stop` on cancel.
- **Reshape the interface first.** `launch()` currently **blocks until the container exits** and
  returns its exit code, which is a Docker-shaped contract: `RunTask` returns a task ARN
  immediately. Split it into `start(spec) → handle` plus an observed terminal outcome, and let
  `DockerRunner` satisfy the same shape by watching its own child.
- **Done when** a dispatched task appears in ECS, its ARN is stored on the run, and cancelling from
  the UI stops it.
- **Depends on** A2, A3.
- **Note** `DockerRunner` stays — it is the local loop and the fastest way to reproduce a failure.

### C2 · Spec and bundle over S3

- **Goal** remove the bind mounts.
- **Scope** write the run spec to S3 at dispatch, presigned GET into the task; bundle already
  designed as an S3 object with a digest; verify the digest at boot.
- **Done when** the task definition has no bind mounts and a tampered bundle fails closed.
- **Depends on** C1.

### C3 · S3 `CacheProvider`

- **Goal** the git mirror and package caches survive between runs without a volume.
- **Scope** implement `CacheProvider.prepare(project)`, restore on boot, save on success, per-project
  prefix, prune policy.
- **Done when** a second run on the same project reports `cache.restored` with `hit: true`, and two
  concurrent runs do not contend.
- **Depends on** C1.
- **Why not EFS** it never scales to zero and a block volume attaches to one task.

### C4 · Events over WebSocket

- **Goal** replace tailing a JSONL file with the adapter dialling out.
- **Scope** WebSocket endpoint authenticated by the run token, adapter sink that reconnects and
  replays from its last acked `seq`, control plane persists to Postgres and fans out to SSE.
- **Done when** killing the connection mid-run produces a gapless event log.
- **Depends on** B1, B3.
- **Note** per-run monotonic `seq` already exists precisely so reconnect is a replay, not a hole.

### C5 · Run lifecycle observation and reconciliation

- **Goal** every run reaches a terminal state, including runs whose container died without saying so.
- **Problem** today the control plane learns the outcome by awaiting the Docker child. On Fargate
  nothing reports back: a task killed by OOM, a failed image pull, or a Spot interruption leaves the
  run sitting `running` for ever, and the task row is the only evidence.
- **Scope** treat `run.finished` as the primary signal; add an **EventBridge** rule on ECS Task State
  Change delivering stopped-task reasons to the control plane; add a reconciler that sweeps runs
  marked running whose task is gone and settles them with the ECS stop reason.
- **Done when** killing a task from the AWS console — with no cooperation from the adapter — moves
  the run to `failed` with a reason a human can act on.
- **Depends on** C1, C4.
- **Why it matters** a run stuck `running` blocks its seat (D2) and hides cost.

### C6 · Cross-instance event fan-out

- **Goal** a UI client connected to one control-plane instance sees events delivered to another.
- **Problem** `store.subscribe()` fans out **in process**. The adapter's WebSocket lands on whichever
  instance the ALB chose, so with two instances a browser watching a run can silently receive
  nothing — and the run looks stalled while it is progressing.
- **Scope** Postgres `LISTEN`/`NOTIFY` (no new infrastructure) behind the existing `subscribe`
  method; SSE backfills from `seq` on connect, as it already does, so a gap self-heals.
- **Done when** two control-plane instances are running, events arrive on one, and a browser
  attached to the other streams them in order.
- **Depends on** B1, C4.
- **Why now** without it the control plane is capped at one instance, which makes the ALB decorative
  and every deploy a gap in the stream.

## Phase D · Correct under concurrency

Everything here was discovered by running the local path. None of it is theoretical.

### D1 · Distributed lock for MCP token refresh

- **Goal** the single-flight refresh guard keeps working with more than one control-plane task.
- **Scope** replace the in-process `Map` with a Postgres advisory lock keyed by server id.
- **Done when** two control-plane tasks refreshing the same server produce one token request.
- **Depends on** B1.
- **Why it matters** rotating-refresh-token providers treat a concurrent replay as an attack and
  revoke the whole token family — a permanent disconnect, not a retryable error.

### D2 · Seat leases and admission control

- **Goal** a harness account is used by one run at a time, and extra tasks queue instead of failing.
- **Scope** `seats` table, assignment at dispatch with `FOR UPDATE SKIP LOCKED`, `waiting_capacity`
  status with a reset countdown, release on run end and on TTL.
- **Done when** dispatching three tasks against one seat runs them one at a time, and the UI shows
  the queue.
- **Depends on** B1.

### D3 · Harness credential rotation (the open one)

- **Goal** a harness that rotates its token inside a task does not leave the stored copy stale.
- **Problem** MCP refresh happens in the control plane, where a lock is possible. **Harness refresh
  happens inside the container**, where it is not — and the rotated token dies with the task.
- **Options** (a) long-lived tokens only (`claude setup-token`, API keys) and refuse file-based
  accounts for concurrent use; (b) credential **writeback** through the broker, so the task reports
  its rotated token before exiting; (c) one seat per account, making rotation serial (D2).
- **Recommendation** ship (a) + (c) first, then (b) if subscription accounts become the norm.
- **Done when** an expired stored credential is detected at dispatch and reported before a run is
  spent.

## Phase E · Operations

### E1 · Limits, TTL and idle-kill

- **Goal** no run bills for ever.
- **ECS has no task timeout.** Locally the control plane's own `setTimeout` kills the container; on
  Fargate nothing does, so a hung adapter runs until someone notices. This is required work, not
  polish.
- **Scope** enforce `wallClockSec` and `idleKillSec` from the control plane (a scheduled sweep
  calling `StopTask`), plus a run-level cost ceiling and a stopped-task reaper.
- **Done when** a task whose adapter is wedged is stopped by the platform within its budget, and the
  run says why.
- **Depends on** C5.

### E2 · Logs, metrics and alarms

- **Goal** answer "why did that run fail" without shell access.
- **Scope** CloudWatch log group per run, dispatch-latency and failure-rate metrics, alarms on
  dispatch p90 over budget and on any NAT gateway appearing.
- **Done when** a failed run's cause is visible from the UI plus one log link.

### E3 · Cost guardrails

- **Goal** the bill matches the model in [architecture.md §11](architecture.md).
- **Scope** budget alarm, per-project attribution from the usage ledger, a daily report.
- **Done when** projected idle cost is the control plane plus RDS and nothing else.

## Suggested order

```
A0 → A1 → A2 → A3 → B1 → B2 → B3 → C1 → C2 → C3 → C4 → C5 → C6 → D1 → D2 → D3 → E1 → E2 → E3
```

- **A0** first and once: everything else needs a terminal that can reach the account.
- **A1–A3** are independent of application code and can go first without blocking local work.
- **B1** unblocks the most: seats, events and the broker all need a real database.
- **C1–C5** is the smallest set that makes a run work on AWS end to end. C5 is not optional: without
  it a task that dies quietly leaves a run running for ever.
- **C6 and D1** are what allow a second control-plane instance. Until both land, run one.
- **D1–D3** should land before anyone runs two tasks at once against one account.

## Definition of done for the whole track

- A task dispatched from the UI runs on Fargate, streams events over WebSocket, restores its cache
  from S3, opens a PR, and leaves nothing running.
- Dispatch to `run.started` inside **60–120 s**, measured, with the number recorded.
- Idle cost is the control plane and the database only — verified by leaving it alone for a day.
- No credential in a task's environment; every one pulled through the broker with a run token.
- `DockerRunner` still works, so a failing run can be reproduced locally.
- Two control-plane instances can serve the same run — proving nothing important is in process
  memory.
