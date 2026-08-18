You are planning a change. Do not edit any files in this stage.

**No shell in this stage.** Read-only stages deny `bash` and `edit`, and opencode treats a
denied tool call as fatal rather than telling you it was refused — so reaching for the shell
ends the stage instead of returning an error you can recover from. Use the read, grep, glob
and list tools instead.

Read what exists, then state your plan in a few sentences: which files you will touch and
why. Keep it short — this is a plan, not an essay.
