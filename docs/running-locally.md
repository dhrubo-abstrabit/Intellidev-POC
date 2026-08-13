# Running a task locally

One task, end to end, with no control plane, no Postgres and no Docker. Everything the
control plane would supply comes from a file and the environment instead, so the parts that
carry the risk — harness, stages, gates, gateway, git — can be exercised on a workstation.

## What you need

- Node 24 and pnpm (`pnpm install`)
- At least one harness on your PATH: `opencode`, `claude`, or `codex`
- A git repo to work against
- `INTELLIDEV_GITHUB_TOKEN` **only** if the run should push and open a PR

opencode is the default and needs no credentials of your own — it ships free models under
its own provider, which is what makes a zero-setup first run possible.

## Fastest possible run

```sh
# a throwaway origin with one commit
mkdir -p /tmp/demo && cd /tmp/demo
git init --bare --initial-branch=main origin.git
git clone origin.git seed && cd seed
printf 'export const VERSION = "0.1.0"\n' > src.ts
git add . && git commit -m seed && git push origin main
cd -

# point the example spec at it, then run
#   (edit examples/run-spec.json: git.repoUrl, manifest.repos[0].url,
#    git.mirrorPath, git.worktreePath, brokerSocket)
pnpm adapter run --spec examples/run-spec.json --bundle examples/bundle --dry-run
pnpm adapter run --spec examples/run-spec.json --bundle examples/bundle
```

`--dry-run` wires everything up — worktree, broker, gateway, config projection — and stops
before running a model. It is the fastest way to check plumbing without spending anything.

## What you should see

```
0004 design ── stage attempt 1
0005 design → stage_state {}
0033 branch ── stage attempt 1
0036 code   ── stage attempt 1
0046 code   → run_check {"name":"test"}
0054 test   ── stage attempt 1
0099 test   gate PASS grep -rq hello . --include=*.ts
0101 test   ── succeeded
SUCCEEDED  stages=4  events=102  credentials=0
```

Console output goes to **stderr**, and every event is appended as JSONL to the path printed
at startup. Nothing is written to stdout except the final summary — stdout is reserved
because in other configurations it belongs to a protocol transport.

## Things that look wrong but are not

**`credentials=0`.** git only consults a credential helper for authenticated remotes, so a
local `file://` origin legitimately needs none. Point the spec at an HTTPS remote and this
becomes non-zero.

**No commit unless the `pr` stage runs.** Committing currently lives inside the
`github.open_pr` builtin, so a template without it will change files and never commit.
That is a wart — a separate `git.commit` builtin would be better — and it is why the
example spec keeps `pr` when pointed at a real GitHub repo.

**The agent may find the work already done.** The example task is small; a model will often
report that the function already exists rather than writing anything. That is a _correct_
outcome, and the gate passing on existing code is the system working.

## Bundle layout

`--bundle` points at what the control plane would otherwise ship as a tarball:

```
examples/bundle/
  context/repo.md          → CLAUDE.md / AGENTS.md
  prompts/design.md        → one per agent stage, named by the stage template
  prompts/code.md
  prompts/fix.md
  prompts/review.md
  skills/<name>/SKILL.md   → discovered automatically, frontmatter read for the index
```

Skills are discovered from the bundle **and** from `.claude/skills/` in the worktree, with
repo-native ones winning — the control plane has never seen the worktree, so that
resolution has to happen inside the run.

## Switching harness

Change `harness` in the spec to `claude-code` or `codex`. Nothing else changes: the same
stages, the same gates, the same gateway, the same skills. Only which config files get
written differs, which is the whole point of the projection layer.

## Debugging

| Symptom                                 | Look at                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Hangs with no output                    | a harness waiting on stdin, or an auth prompt — both are guarded, so report it |
| `no such tool`                          | the stage's `tools.mode`, and whether the tool is in scope for that stage      |
| Gate fails but the agent says it passed | run `run_check` yourself; the gate and `run_check` use the same command        |
| Tool appears twice in the log           | should not happen — see `gateway/naming.ts`                                    |
| `spec fetch failed` / Zod error         | the spec is parsed strictly on purpose; the error names the field              |
