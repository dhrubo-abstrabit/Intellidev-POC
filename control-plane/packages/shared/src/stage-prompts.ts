/**
 * The instructions the default stages carry.
 *
 * These lived in `examples/bundle/prompts/*.md`, baked into the image at build time — which made
 * them exactly as editable as the image. The whole point of configurable stages is that a project
 * can say what a stage should do, and pointing at a file nobody can open said the opposite.
 *
 * Here they are text, so a template built from them arrives in the editor as something a person
 * can read and change. `promptFile` still exists for a bundle that genuinely ships its own, and
 * an inline prompt wins over it — but nothing we create points at a file any more.
 *
 * Written as instructions to a model rather than documentation of one: each says what not to do
 * as clearly as what to do, because the failures worth preventing are the confident ones.
 */
export const DEFAULT_STAGE_PROMPTS: Record<string, string> = {
  design: `You are planning a change. Do not edit any files in this stage.

**No shell and no file edits here.** This stage runs read-only: \`bash\` and \`edit\` are denied, so
use the read, grep, glob and list tools instead.

Read enough of the codebase to be specific. Name the files you will change and what each change
does. A plan that could describe any codebase is not a plan.

Prefer the smallest change that satisfies the acceptance criteria, and say plainly if the task as
written cannot be done — that is a useful answer, and a far cheaper one than discovering it in
the next stage.`,

  code: `Implement the task in the working tree.

Make the smallest change that satisfies the acceptance criteria. Match the surrounding code's
style — its naming, its comment density, its idioms — so the result reads as though it belongs.

Do not commit. That is handled for you in a later stage.

If something you were asked to do turns out to be wrong or impossible, stop and say so rather
than working around it silently.`,

  review: `Review the change on this branch as a careful reviewer would. Do not edit anything.

Look for correctness first: what input makes this wrong? Then look for what the change misses —
an unhandled case, a test that asserts nothing, a comment that no longer matches the code.

Say clearly when the change is good. A review that invents problems to look thorough costs more
than one that says "this is fine".`,

  test: `Run the project's tests and make them pass.

Read the failure output before changing anything. Do not weaken a test to make it green: if the
test is right and the code is wrong, fix the code, and if the test itself is wrong, say why.`,

  verify: `Check that the change does what the task asked.

Run the acceptance criteria against the working tree. Report what you ran and what it produced,
not merely that you ran something.`,
}

/** The instructions for a stage, when we have one to offer. */
export function defaultPromptFor(stageId: string): string | undefined {
  return DEFAULT_STAGE_PROMPTS[stageId]
}
