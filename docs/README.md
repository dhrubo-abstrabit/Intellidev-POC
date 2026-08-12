# Intellidev — docs

Backend platform for dispatching development tasks to containerised coding agents.
A task created in the UI is picked up by an ephemeral container that branches,
implements, tests, reviews and opens a PR — streamed live and steerable mid-run.

## Read in this order

| Doc                                | What it covers                                                        |
| ---------------------------------- | --------------------------------------------------------------------- |
| [architecture.md](architecture.md) | System shape, components, data model, API surface, decisions taken    |
| [stack.md](stack.md)               | Framework and library choices, with the alternatives rejected and why |
| [milestone-0.md](milestone-0.md)   | The walking skeleton — the first slice to build, task by task         |
| [roadmap.md](roadmap.md)           | M1–M5 after the skeleton, with the trigger for each                   |
| [ui-contract.md](ui-contract.md)   | Design tokens, vocabulary, and the endpoints the UI consumes          |

## Current status

**T1 complete** — monorepo scaffold and `@intellidev/shared` canonical contracts:
event vocabulary, stage templates, manifest, toolset, run spec. Typecheck clean,
37 tests passing. Next: T2, the Claude Code driver.

Verify with `pnpm install && pnpm check`.

- **Runtime**: AWS ECS on Fargate, scale-to-zero, 60–120 s dispatch budget
- **Harnesses**: Claude Code and Codex CLI (exactly two, deliberately)
- **Model auth**: subscription seats, scheduled as a pooled resource
- **Language**: TypeScript end to end (control plane, adapter, UI)

## Vocabulary

Use these words in code, API and UI. They match the UI build.

| Term         | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| **Project**  | Durable identity: repo, manifest, caches, attached tools. Never executes.  |
| **Task**     | A unit of work someone wants done. Created by hand in the UI.              |
| **Run**      | One ephemeral container executing one task. Disposable.                    |
| **Stage**    | One step of the process — design, code, test, review. _Not_ "phase".       |
| **Harness**  | A coding-agent CLI (Claude Code, Codex). Replaceable behind a driver.      |
| **Adapter**  | Our process inside the container. Owns stages, events, tools, credentials. |
| **Dispatch** | The act of sending a task to a runner.                                     |
| **Seat**     | A subscription credential, allocated like a resource.                      |

## Non-negotiables

Carried from the design discussion. Breaking one of these is a design change,
not an implementation detail.

1. **Never mount a host Docker socket.** Model-authored code runs in these containers.
2. **No long-lived secrets in the container environment.** Credentials are pulled
   on demand from a broker over a unix socket.
3. **Manifests are immutable and runs pin a version.** Editing a project never
   changes the meaning of a run already in flight.
4. **`run_events` is the only source of run state.** UI, resume and audit read the
   same stream so they cannot disagree.
5. **Every usage record carries its seat.** Per-project cost attribution on a shared
   subscription account is impossible to backfill.
6. **The PR is the boundary.** Nothing writes to `main`.
