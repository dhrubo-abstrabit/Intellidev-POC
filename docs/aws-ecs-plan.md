# Deploying to AWS — ECS Fargate

Task breakdown for moving the validated local path onto AWS. Decisions already taken live in
[architecture.md §11](architecture.md); this document is only the work.

## Where each piece runs

| Piece                  | Local today                | On AWS                                   | Scales to zero |
| ---------------------- | -------------------------- | ---------------------------------------- | -------------- |
| UI                     | browser → :4000            | browser → ALB                            | n/a            |
| **Control plane**      | `pnpm ui` on your Mac      | **long-lived Fargate service**           | **no**         |
| Postgres               | in-memory `Store`          | RDS / Aurora Serverless v2               | no (or near)   |
| **Orchestrator**       | stage engine in the runner | **unchanged — still in the runner**      | yes            |
| Adapter + harness      | `docker run` per task      | **one Fargate task per run** (`RunTask`) | yes            |
| Caches, bundles, specs | named volume + bind mounts | S3                                       | yes            |

Two things worth being explicit about, because they are the most common misreading:

- **The orchestrator is not a service.** It is the stage engine (`stages/engine.ts`) running
  _inside_ each run container. Nothing on AWS decides what stage runs next; the control plane says
  "run this spec" and then only watches. That is deliberate — a control-plane restart cannot strand
  a half-finished run.
- **The control plane is the one thing that cannot scale to zero.** It serves the UI, holds SSE
  connections, and answers the credential broker. Everything else is per-run and idles at $0.

## Decisions to confirm before starting

These change what gets built, so they are worth settling first.

| #   | Question                        | Options                                                                    | Recommendation                                                                        |
| --- | ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D1  | IaC tool                        | AWS CDK (TypeScript) · Terraform                                           | **CDK** — same language as the repo, and `RunTask` wiring is far less verbose         |
| D2  | Control-plane hosting           | Fargate service + ALB · App Runner                                         | **Fargate service + ALB** — App Runner cannot reach a VPC-only RDS without extra work |
| D3  | Database                        | RDS `db.t4g.micro` · Aurora Serverless v2 (0.5 ACU floor)                  | **RDS t4g.micro** — cheaper at this size; Aurora's floor costs more than it saves     |
| D4  | Credential storage              | Secrets Manager per credential · KMS-encrypted column in Postgres          | **Secrets Manager** — rotation and audit come free; ~$0.40/secret/month               |
| D5  | Harness refresh tokens (see F3) | long-lived tokens only · in-container writeback · one seat per concurrency | **decide with F3** — this is the sharpest new constraint                              |

## Phase A · Foundations

### A1 · IaC skeleton and environments

- **Goal** one `infra/aws/` CDK app with a `dev` stage that deploys nothing but a VPC.
- **Scope** CDK bootstrap, stack layout, config per environment, `pnpm infra:deploy` script.
- **Done when** `cdk deploy` creates and destroys cleanly, and the repo has no hand-made resources.

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
- **Scope** implement the existing `Runner` interface (`create` / `start` / `stop`) with `RunTask`,
  overrides for env and command, task ARN as the run handle, `stop` on cancel.
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

- **Goal** no run bills forever.
- **Scope** enforce `wallClockSec` and `idleKillSec` outside the container, a stopped-task reaper,
  and a run-level cost ceiling.
- **Done when** a hung task is stopped by the platform, not by someone noticing.

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
A1 → A2 → A3 → B1 → B2 → B3 → C1 → C2 → C3 → C4 → D1 → D2 → D3 → E1 → E2 → E3
```

- **A1–A3** are independent of application code and can go first without blocking local work.
- **B1** unblocks the most: seats, events and the broker all need a real database.
- **C1–C4** is the smallest set that makes a run work on AWS end to end.
- **D1–D3** should land before anyone runs two tasks at once against one account.

## Definition of done for the whole track

- A task dispatched from the UI runs on Fargate, streams events over WebSocket, restores its cache
  from S3, opens a PR, and leaves nothing running.
- Dispatch to `run.started` inside **60–120 s**, measured, with the number recorded.
- Idle cost is the control plane and the database only — verified by leaving it alone for a day.
- No credential in a task's environment; every one pulled through the broker with a run token.
- `DockerRunner` still works, so a failing run can be reproduced locally.
