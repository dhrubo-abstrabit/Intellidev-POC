# Stack choices

Recorded with reasoning, because "which framework" gets asked again every few months.

## What actually constrains the choice

Not "which framework is nicest". These four things:

1. **Long-lived WebSockets.** One socket per run, open for the whole run — 15 minutes to
   2 hours. We need many idle-but-open sockets, and a deploy must not drop them.
2. **SSE fanout to the UI**, with gapless replay from a sequence number.
3. **Transactional Postgres.** Seat acquisition needs literal
   `SELECT … FOR UPDATE SKIP LOCKED`. Immutable manifests need real transactions.
4. **The adapter is not a web app.** It is a CLI daemon that runs inside the container
   and shares types with the control plane. That is the whole reason for TypeScript.

Anything that makes (1) or (3) awkward is disqualified regardless of DX.

## Control plane: Fastify

```
fastify + @fastify/websocket + fastify-type-provider-zod
```

**Why:**

- Lowest per-connection overhead of the mainstream Node servers, and
  `@fastify/websocket` is a thin wrapper over `ws` — it does not fight you when a socket
  lives for an hour.
- `fastify-type-provider-zod` reuses the Zod schemas **already** in
  `@intellidev/shared` for request validation _and_ OpenAPI generation. That means
  [ui-contract.md](ui-contract.md) becomes generated rather than hand-maintained, so it
  cannot drift from the code.
- Plugin encapsulation gives module boundaries without a DI container.
- SSE is a plain `reply.raw` write loop. No abstraction to work around.

**Why not the alternatives:**

| Option      | Why not                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NestJS**  | Structure we do not need yet, at real cost. Decorators plus reflection, heavier cold start, and its gateway/interceptor abstractions actively get in the way of raw streaming and long-lived sockets. The orchestrator is a background reconciler, not a request handler — Nest wants it modelled as a module with lifecycle hooks. Reconsider if the team grows past ~6 backend devs. |
| **Hono**    | Excellent, but edge-first. WS support is runtime-dependent and it is optimised for short requests, not a stateful socket server on long-running Node.                                                                                                                                                                                                                                  |
| **tRPC**    | Great when UI and API are one codebase. Ours are not: the UI is an existing build, and the adapter needs a documented REST surface (`/internal/runs/:id/spec`). We would end up maintaining REST anyway.                                                                                                                                                                               |
| **Express** | Slow, weak TS story, no first-class async error handling. No reason in 2026.                                                                                                                                                                                                                                                                                                           |

### Split the API and the WS gateway now

Two entrypoints over the same codebase, one process in M0:

```
packages/control-plane/src/
  server/api.ts        # REST — deployed often, restarts freely
  server/gateway.ts    # WS ingest from adapters — restarts drop live runs
```

**Why now:** shipping an API fix should not kill in-flight runs. Splitting later means
untangling shared in-process state; splitting now costs one extra file. The adapter
already reconnects and replays from its last acked `seq`, so gateway restarts are
survivable — but they should still be rare.

## Adapter: no framework

Plain Node. `cac` for arg parsing, `execa` for subprocesses,
`@modelcontextprotocol/sdk` as **both** client (upstream servers) and server (the
gateway the harnesses talk to), bundled with esbuild into a single file for the image.

A framework here would be pure cost. The adapter's job is process supervision, stream
parsing and a state machine.

## Database: Drizzle, not Prisma

- We need `FOR UPDATE SKIP LOCKED` written as SQL. Drizzle emits real SQL and gets out
  of the way; Prisma's engine makes row-level locking awkward.
- Drizzle is types plus a thin runtime — no query-engine binary to ship or match to an
  architecture. That matters when the same code may run on x86 and Graviton.
- Migrations are not Drizzle's. They are hand-written SQL in the app repository's Supabase
  history, because RLS policies, `SECURITY DEFINER` helpers and `GRANT`/`REVOKE` cannot be
  generated from a schema definition — and this database is shared with the product.

## Queue: Postgres, not Redis

Dispatch and reconcile use `SELECT … FOR UPDATE SKIP LOCKED` polling, and SSE fanout
uses `LISTEN`/`NOTIFY`. We already need SKIP LOCKED for seats, so this is one pattern
rather than two systems.

Add Redis when fanout genuinely spans many API instances — not before. At the scale in
[architecture.md §13](architecture.md), Postgres is not the bottleneck.

## Everything else

| Concern        | Choice          | Note                                                                                          |
| -------------- | --------------- | --------------------------------------------------------------------------------------------- |
| Validation     | Zod             | Already the shared contract; one schema, three uses                                           |
| Tests          | Vitest          | Fast, ESM-native, same config everywhere                                                      |
| Monorepo       | pnpm workspaces | `@intellidev/shared` consumed as **source**, so there is no "did you rebuild shared?" failure |
| Bundling       | esbuild         | Adapter only                                                                                  |
| Container base | Debian slim     | Needs git, node, python, mise — distroless cannot host them                                   |
| IaC            | Terraform       | One module per concern; `destroy` must leave nothing billing hourly                           |
| Logs           | pino            | Structured, and Fastify ships with it                                                         |

## Deliberately not chosen yet

**An auth framework.** M0 has no multi-tenancy. When it lands, the decision is a
provider (WorkOS / Auth0 / Cognito) not a framework, and it touches only the API edge.

**A UI framework.** The UI already exists as a React build. The backend's obligation is
[ui-contract.md](ui-contract.md), nothing more.

**A workflow engine** (Temporal, Inngest). Tempting for stages, and genuinely the right
shape — durable execution with retries is exactly our stage machine. Rejected for now
because our state machine is small, must run _inside_ the run container next to the
harness, and needs to resume from `run_stages` rows that the UI already reads. Adding a
second source of run state would violate the rule that `run_events` is the only one.
Revisit only if stage orchestration outgrows a few hundred lines.
