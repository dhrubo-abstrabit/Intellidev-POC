# Contributing

## Commit messages

Conventional commits, with a pointer-style body.

```
<type>(<scope>): <short description>

- what changed, one pointer per line
- why, when it is not obvious from the change
- anything a reviewer would otherwise have to ask about
```

Rules:

- Subject in the imperative, lower case, no trailing full stop, under ~72 chars.
- Scope is the area touched, not the file: `shared`, `adapter`, `control-plane`,
  `mcp`, `stages`, `infra`, `docs`, `repo`.
- Body is **bullet pointers**, not prose paragraphs.

**Types**

| Type       | Use for                         |
| ---------- | ------------------------------- |
| `feat`     | new capability                  |
| `fix`      | corrected behaviour             |
| `refactor` | same behaviour, different shape |
| `perf`     | measurable performance change   |
| `test`     | tests only                      |
| `docs`     | documentation only              |
| `chore`    | tooling, deps, scaffolding      |
| `infra`    | Terraform and deployment        |

**Examples**

```
feat(shared): add canonical event vocabulary

- 33 events across eight groups as a Zod discriminated union
- split EventBody from AgentEvent so only the adapter bus assigns seq
- cap previews at 2000 chars to keep events a log, not a blob transport
```

```
fix(adapter): inject queued steering only at a turn boundary

- injecting mid tool-call corrupted the Codex transcript
- surfaces steer.received as pending until steer.delivered fires
```

## Branches

`feat/<slug>`, `fix/<slug>`, `docs/<slug>`. Nothing is pushed to `main` directly —
the PR is the boundary, for us as much as for the agents.

## Before committing

```sh
pnpm check    # format:check → typecheck → test
```

`pnpm format` rewrites files; run it before `pnpm check` if formatting fails.
