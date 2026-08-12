# UI contract

What the backend owes the UI, and the design system the UI already uses.

## Design system

Extracted from `Intellidev.html` (a bundled build of the existing React app). **That
file is the source of truth** — the tables below are what was recoverable from its CSS
custom properties, and a couple of shorter token names may be missing. Do not re-derive
a palette; reuse these variables.

**Typefaces:** `Manrope` for UI and body, `JetBrains Mono` for code, IDs, metrics and
anything tabular. Both themes are fully defined, so any new surface must set colours
from tokens rather than literals.

### Surfaces

| Token                | Light                 | Dark                  |
| -------------------- | --------------------- | --------------------- |
| `--app`              | `#ffffff`             | `#0d100e`             |
| `--main`             | `#ffffff`             | `#0c100e`             |
| `--panel`            | `#fafbfa`             | `#0e1210`             |
| `--card`             | `#ffffff`             | `#121614`             |
| `--modal`            | `#ffffff`             | `#111513`             |
| `--inset`            | `#f5f7f5`             | `#0f1311`             |
| `--field`            | `#f5f7f5`             | `#161a18`             |
| `--input`            | `#f2f5f2`             | `#141816`             |
| `--chip`             | `#f2f5f2`             | `#171c19`             |
| `--hover`            | `#f1f4f1`             | `#191e1b`             |
| `--active`           | `#e9f1eb`             | `#1a211d`             |
| `--btn2` / `--btn2h` | `#f0f4f1` / `#e4ece7` | `#1f2724` / `#28332e` |
| `--scrim`            | `rgba(24,34,28,.34)`  | `rgba(4,7,5,.62)`     |

### Borders

| Token         | Light     | Dark      |
| ------------- | --------- | --------- |
| `--bd-soft`   | `#e9ede9` | `#1d2320` |
| `--bd-strong` | `#ccd5ce` | `#2a302c` |
| `--bd-hover`  | `#a5b6aa` | `#3a463f` |
| `--bd-input`  | `#d8dfd9` | `#262d29` |
| `--bd-danger` | `#f0c8c4` | `#3d2725` |
| `--bd-warn`   | `#e9d9a6` | `#3a3524` |

### Foreground ramp

`--fg2` … `--fg7`, decreasing emphasis. Light: `#31403a`, `#56655d`, `#697870`,
`#66736c`, `#5e6a64`, `#39433d`. Dark: `#c6d0ca`, `#9aa8a1`, `#7f8a84`, `#7e8b84`,
`#98a49e`, `#c3ccc6`.

### Accent and semantics

Green is the primary accent — this is a green-forward product, not a blue one.

| Token        | Light     | Dark      | Use                                      |
| ------------ | --------- | --------- | ---------------------------------------- |
| `--green`    | `#12915a` | `#4ade80` | primary action, success, running         |
| `--green2`   | `#0f7a4b` | `#7dd3a0` | secondary green                          |
| `--green-bd` | `#2f7d4f` | `#3d9a63` | green borders                            |
| `--on-green` | `#ffffff` | `#06210f` | text on green fills                      |
| `--amber`    | `#b06a08` | `#f59e0b` | warning, waiting capacity, needs re-auth |
| `--amber2`   | `#a35c0b` | `#c98a3c` | secondary amber                          |
| `--blue`     | `#2563eb` | `#4c8dff` | informational, links                     |
| `--red`      | `#d13b3b` | `#f87171` | failure, destructive                     |

Semantic colour is separate from the accent. A green "running" pill and a green
"primary button" are the same hue doing two jobs — encode state in **form** as well
(pill, stripe, icon) so status reads at a glance without relying on hue alone.

## Enums

Statuses are server-authoritative. The UI renders them; it never infers them.

**Task status** — `not_started` · `dispatched` · `running` · `waiting_capacity` ·
`in_review` · `done` · `blocked` · `failed`

**Run status** — `queued` · `provisioning` · `running` · `parked` · `succeeded` ·
`failed` · `cancelled`

**Stage** — `design` · `branch` · `code` · `verify` · `test` · `review` · `approval` ·
`pr`

**Harness** — `claude-code` · `codex`

**Connection health** — `ok` · `needs_reauth` · `unreachable`

## REST surface

```
# projects & manifests
GET    /api/projects
POST   /api/projects
GET    /api/projects/:id
GET    /api/projects/:id/manifests            -- immutable, newest first
POST   /api/projects/:id/manifests            -- returns new version

# tasks  (created by hand — see the manual form in milestone-0.md T9)
GET    /api/projects/:id/tasks?status=
POST   /api/projects/:id/tasks
GET    /api/tasks/:id
PATCH  /api/tasks/:id
POST   /api/tasks/:id/dispatch                -- 202; body { harness?, stageTemplate? }

# runs
GET    /api/tasks/:id/runs
GET    /api/runs/:id                          -- includes stages[] with gate results
GET    /api/runs/:id/events?since=<seq>       -- backfill, paginated
GET    /api/runs/:id/stream                   -- SSE, live
POST   /api/runs/:id/steer                    -- { text }
POST   /api/runs/:id/interrupt
POST   /api/runs/:id/cancel
POST   /api/approvals/:id                     -- { decision, reason }

# tools & skills
GET    /api/tool-servers                      -- org catalogue
POST   /api/tool-servers                      -- begins server-side MCP handshake
GET    /api/tool-servers/:id/oauth/start      -- redirects; consent happens in browser
GET    /api/projects/:id/tool-attachments
PUT    /api/projects/:id/tool-attachments/:serverId   -- { enabledTools, stages, required }
GET    /api/projects/:id/skills               -- resolved set, each with origin
GET    /api/projects/:id/tools/health         -- per-attachment health + verified_at

# capacity & usage
GET    /api/seats                             -- window utilisation, reset, holders
GET    /api/projects/:id/usage?from=&to=
```

## Streaming

`GET /api/runs/:id/stream` is SSE. Each message is one canonical event:

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

Rules the UI can rely on:

- `seq` is **per-run and monotonic**. Reconnect with `?since=<last seq>` and you get a
  gapless replay — never duplicates, never holes.
- Bootstrap events (`run.provisioning`, `bundle.fetched`, `cache.restored`,
  `worktree.ready`) arrive during the 60–120 s dispatch. Render them as progress, so the
  wait is legible rather than a spinner. This is what makes optimistic UI honest here.
- `assistant.delta` is the token stream. `turn.boundary` marks where steering can land.
- A steer posts immediately and returns `steer.received` with `status: pending`. Show the
  message greyed. It flips to `steer.delivered` when injected at the next turn boundary.
  **Do not** show it as delivered before that event.
- `interrupt` is a distinct action from steering. Surface both: "stop" jumps the queue,
  "also check the auth module" does not.
- `usage.updated` carries an **estimate**. Label it as one — "about 72% used, resets
  around 16:40" is forgiven in a way a progress bar that lied never is.

## Things the UI should not do

- **Do not infer run state from events.** Read `GET /api/runs/:id`. `run_events` is the
  source of truth server-side; the UI gets a projection of it.
- **Do not imply a config change affects a running run.** Manifests are immutable and
  runs pin a version. Attaching a tool applies to the **next** dispatch — say so.
- **Do not show a project as "a container".** Show its **active runs**; that is the real
  mechanism and it happens to be the more useful affordance.
