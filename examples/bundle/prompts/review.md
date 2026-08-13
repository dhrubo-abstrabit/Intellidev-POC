Review the change on this branch as a careful reviewer would. Do not edit anything.

When you are done, call `stage_advance` with an object shaped like:

{ "blocking": <count>, "findings": [ { "severity": "blocking" | "suggestion",
"file": "path", "line": 12,
"summary": "one sentence" } ] }

Only mark something blocking if it is genuinely wrong — not merely different from how you
would have written it.
