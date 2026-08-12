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
| [contributing.md](contributing.md) | Commit and branch conventions                                         |

## Shape

- **Runtime**: AWS ECS on Fargate, scale-to-zero, 60–120 s dispatch budget
- **Harnesses**: Claude Code, Codex CLI and opencode — each behind one driver interface
- **Model auth**: subscription seats, scheduled as a pooled resource
- **Language**: TypeScript end to end (control plane, adapter, UI)

## Current status

**T1–T4 complete, plus a third harness.** 175 tests, typecheck clean.
Verify with `pnpm install && pnpm check`.

| Task | Ships                                                                                 |
| ---- | ------------------------------------------------------------------------------------- |
| T1   | `@intellidev/shared` — event vocabulary, stage templates, manifest, toolset, run spec |
| T2   | Claude Code driver, NDJSON reassembly, event bus with seq/ack/replay                  |
| T3   | Codex driver behind the same interface, plus a cross-harness equivalence test         |
| T4   | Stage engine — command/predicate/human gates, bounded retries, resume at last gate    |
| —    | **opencode** driver, third harness                                                    |

Contract tests replay recorded CLI output from `packages/adapter/test/fixtures/`, so
they need no subprocess and spend no quota. The
[capability matrix](architecture.md) records where the three harnesses differ.

**Next:** T5, the credential broker and GitHub App.

### Fixture provenance

Not all three are equal, and the difference matters:

| Harness             | Fixture source                                | Strength        |
| ------------------- | --------------------------------------------- | --------------- |
| Claude Code 2.1.228 | real capture of `--output-format stream-json` | verified        |
| Codex 0.147.0       | real capture of `exec --json`                 | verified        |
| opencode 1.18.16    | derived from its published OpenAPI document   | **shapes only** |

opencode has no runtime capture because no provider is authenticated on this machine
(`opencode providers list` → 0 credentials). Its event shapes come from the server's
own OpenAPI spec, which is authoritative for the schema but does not prove that
`opencode run --format json` emits exactly those objects. Authenticate a provider and
record a fixture to close that gap; the drift assertions will name anything that
differs.

### Re-recording a fixture after a CLI upgrade

```sh
# claude-code
claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages \
  --max-turns 3 --allowedTools Read < /dev/null > out.ndjson

# codex — stdin must be closed or it waits forever
codex exec --json --skip-git-repo-check -s read-only -C . "<prompt>" < /dev/null > out.jsonl

# opencode — event schemas without needing credentials
opencode serve --port 39917 & curl -s http://127.0.0.1:39917/doc > openapi.json
```

Scrub paths, session ids and uuids before committing. The contract tests will name
whatever shape changed.

## Vocabulary

Use these words in code, API and UI. They match the UI build.

| Term         | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| **Project**  | Durable identity: repo, manifest, caches, attached tools. Never executes.       |
| **Task**     | A unit of work someone wants done. Created by hand in the UI.                   |
| **Run**      | One ephemeral container executing one task. Disposable.                         |
| **Stage**    | One step of the process — design, code, test, review. _Not_ "phase".            |
| **Harness**  | A coding-agent CLI (Claude Code, Codex, opencode). Replaceable behind a driver. |
| **Adapter**  | Our process inside the container. Owns stages, events, tools, credentials.      |
| **Dispatch** | The act of sending a task to a runner.                                          |
| **Seat**     | A subscription credential, allocated like a resource.                           |

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
