import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { AgentEvent } from '@intellidev/shared'
import { InMemoryStore } from '../src/store/memory.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PostgresStore } from '../src/store/postgres.js'
import type { ProjectScope } from '../src/store/types.js'
import type { Store } from '../src/store/types.js'

/**
 * Connections one test store may hold.
 *
 * Supabase's session pooler allows fifteen per project, and these suites open two or three
 * stores each — at the production default of five that is the whole budget, and the symptom is
 * `(EMAXCONNSESSION) max clients reached` appearing as thirty unrelated test failures.
 */
const TEST_POOL = 2

/**
 * One suite, both implementations.
 *
 * This is what makes "the same API tests pass against Postgres" — B1's done-condition —
 * a proven claim rather than an intention. Every behaviour the control plane relies on is
 * asserted against each store, so a divergence is a failing test rather than a bug that
 * only appears once deployed.
 *
 * The Postgres half is skipped when no connection string is configured, so the suite stays
 * runnable offline and in CI without secrets. It is **not** skipped silently in a way that
 * could hide a regression: the describe block reports as skipped, by name.
 */

function connectionString(): string | undefined {
  try {
    const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    const line = env
      .split('\n')
      .find((l) => l.trim().startsWith('SUPABASE_CONNECTION_STRING_SESSION='))
    return line
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

/**
 * A minimal valid event.
 *
 * Fixed to `run.provisioning` rather than parameterised by type: each event type has its
 * own required payload, so a generic helper that swapped the type while keeping one `data`
 * shape produced schema failures that looked like store bugs.
 */
/** Waits for a predicate, since backfill is asynchronous in both implementations. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function event(runId: string, seq: number): AgentEvent {
  return AgentEvent.parse({
    seq,
    runId,
    ts: new Date(1700000000000 + seq * 1000).toISOString(),
    stage: null,
    type: 'run.provisioning',
    data: { message: `event ${seq}` },
  })
}

const TASK = {
  title: 'contract',
  description: 'shared by both stores',
  acceptanceCriteria: ['behaves identically'],
  harness: 'claude-code' as const,
  repoUrl: 'https://github.com/acme/widget.git',
  baseBranch: 'main',
  mcpServerIds: ['github'],
}

/**
 * Every behaviour the control plane depends on, run against whichever store is given.
 *
 * `reset` matters more than it looks. The in-memory store is isolated because each test
 * gets a fresh instance; a database is not, and without truncation between tests one
 * test's rows are another's — `findRunByHandle('container-xyz')` finding a *previous*
 * test's run is exactly the false failure that shows up first. One store instance for the
 * whole suite, emptied between tests, also avoids opening a connection pool per test.
 */
function contract(
  name: string,
  store: Store,
  scope: ProjectScope,
  hooks: { reset?: () => Promise<void>; dispose?: () => Promise<void> } = {},
) {
  describe(name, () => {
    beforeEach(async () => {
      if (hooks.reset) await hooks.reset()
      // Re-added every test because `reset` empties tasks, and a task cannot be created for a
      // repository the project has not been allowed. Idempotent, so this is one statement.
      await store.addProjectRepo(scope, {
        owner: 'acme',
        repo: 'widget',
        installationRef: 'contract',
      })
    })
    afterAll(async () => {
      if (hooks.dispose) await hooks.dispose()
    })

    describe('tasks', () => {
      it('round-trips every field, including the optional ones', async () => {
        const created = await store.createTask({ ...TASK, details: 'extra context' }, scope)
        const fetched = await store.getTask(created.id)
        expect(fetched).toMatchObject({
          title: TASK.title,
          acceptanceCriteria: TASK.acceptanceCriteria,
          mcpServerIds: TASK.mcpServerIds,
          details: 'extra context',
          status: 'not_started',
        })
        // ISO strings both sides, so the UI contract does not depend on which store is live.
        expect(fetched?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      })

      it('omits an absent optional rather than returning null', async () => {
        // A `details: null` would reach the UI as a rendered "null"; absence must stay absence.
        const created = await store.createTask(TASK, scope)
        expect(await store.getTask(created.id)).not.toHaveProperty('details')
      })

      it('returns undefined for a task that does not exist', async () => {
        expect(await store.getTask('00000000-0000-0000-0000-00000000dead')).toBeUndefined()
      })

      it('enforces the status machine, refusing an illegal jump', async () => {
        const task = await store.createTask(TASK, scope)
        await expect(store.setTaskStatus(task.id, 'in_review')).rejects.toThrow(/cannot move/)
        expect((await store.getTask(task.id))?.status).toBe('not_started')
      })

      it('allows the legal path', async () => {
        const task = await store.createTask(TASK, scope)
        await store.setTaskStatus(task.id, 'dispatched')
        await store.setTaskStatus(task.id, 'running')
        expect((await store.setTaskStatus(task.id, 'in_review')).status).toBe('in_review')
      })

      it('treats setting the current status as a no-op, not a violation', async () => {
        const task = await store.createTask(TASK, scope)
        expect((await store.setTaskStatus(task.id, 'not_started')).status).toBe('not_started')
      })
    })

    describe('runs', () => {
      it('starts queued with seqHwm -1, so seq 0 is acceptable', async () => {
        // `0 <= 0` would reject the very first event if this were 0.
        const task = await store.createTask(TASK, scope)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        expect(run.status).toBe('queued')
        expect(run.seqHwm).toBe(-1)
        expect(run.records).toEqual([])
      })

      it('applies a partial patch without disturbing other fields', async () => {
        const task = await store.createTask(TASK, scope)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        await store.updateRun(run.id, { handle: 'arn:aws:ecs:::task/abc' })
        await store.updateRun(run.id, { status: 'running' })
        const after = await store.getRun(run.id)
        expect(after?.handle).toBe('arn:aws:ecs:::task/abc')
        expect(after?.status).toBe('running')
        expect(after?.branch).toBe('feat/x')
      })

      it('round-trips every patchable field, so none is silently dropped', async () => {
        /**
         * FOUND BY ADDING A FIELD. The Postgres `updateRun` writes an explicit allowlist while
         * the in-memory one does `Object.assign`, so a new field round-trips in tests and
         * vanishes in production — the worst shape of failure, because everything reports
         * success. `engineState` was dropped exactly this way, and losing *that* means a resumed
         * run repeats stages someone had already approved.
         *
         * Written as one patch of everything rather than a test per field: the next field added
         * to RunRow should fail here without anyone remembering to extend this.
         */
        const task = await store.createTask(TASK, scope)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')

        const patch = {
          status: 'running' as const,
          branch: 'feat/renamed',
          seqHwm: 42,
          records: [{ stage: 'code', status: 'passed' }] as never,
          prUrl: 'https://example.test/pr/9',
          failureReason: 'none, but it must survive',
          handle: 'arn:aws:ecs:::task/round-trip',
          engineState: { cursor: 3, status: 'parked', approvals: { code: 'approved' } },
        }
        await store.updateRun(run.id, patch)

        const after = await store.getRun(run.id)
        for (const [key, value] of Object.entries(patch)) {
          expect(after?.[key as keyof typeof after], `${key} did not survive updateRun`).toEqual(
            value,
          )
        }
      })

      it('saves over a template of the same name rather than failing', async () => {
        /**
         * FOUND BY SAVING TWICE. The insert was blind, and the partial unique index on
         * (project_id, name) rejected the second save — reaching the client as a 500, so the
         * stage editor worked exactly once per name and then broke with no explanation.
         *
         * Asserted on both stores because the in-memory one has no index to catch it: without
         * being told, it would happily keep two templates called the same thing and the
         * behaviour would differ only in production.
         */
        const first = await store.saveStageTemplate({
          clientSpaceId: scope.clientSpaceId,
          projectId: scope.projectId,
          name: 'Pipeline',
          stages: [{ id: 'code', kind: 'agent', prompt: 'a' }] as never,
          isDefault: true,
        })
        const second = await store.saveStageTemplate({
          clientSpaceId: scope.clientSpaceId,
          projectId: scope.projectId,
          name: 'Pipeline',
          stages: [{ id: 'code', kind: 'agent', prompt: 'b' }] as never,
          isDefault: true,
        })

        // The same row, edited — not a second one beside it.
        expect(second.id).toBe(first.id)
        const listed = (await store.listStageTemplates(scope)).filter((t) => t.name === 'Pipeline')
        expect(listed).toHaveLength(1)
      })

      it('keeps templates of the same name in different scopes apart', async () => {
        // A space template and a project template may share a name: one is the inherited
        // default and the other is the override, and calling them the same thing is natural.
        await store.saveStageTemplate({
          clientSpaceId: scope.clientSpaceId,
          name: 'Shared name',
          stages: [{ id: 'code', kind: 'agent', prompt: 'space' }] as never,
          isDefault: false,
        })
        await store.saveStageTemplate({
          clientSpaceId: scope.clientSpaceId,
          projectId: scope.projectId,
          name: 'Shared name',
          stages: [{ id: 'code', kind: 'agent', prompt: 'project' }] as never,
          isDefault: false,
        })

        const both = (await store.listStageTemplates(scope)).filter((t) => t.name === 'Shared name')
        expect(both).toHaveLength(2)

        /**
         * The space-level one is deleted here rather than by `truncateAll`.
         *
         * `truncateAll` is scoped to a project on purpose — a space template is shared by every
         * project in the space, and letting a per-project reset delete it would make the reset
         * more dangerous than the leak it fixes. So the test that creates one cleans up after
         * itself.
         */
        const spaceLevel = both.find((t) => t.projectId === undefined)
        if (spaceLevel) await store.deleteStageTemplate(spaceLevel.id)
      })

      describe('artifacts', () => {
        /**
         * What a stage drew, kept for the stages after it and for the person reviewing.
         *
         * The properties that matter are the ones a UI and a later stage both depend on: a name is
         * an overwrite rather than a second row, a list never carries bodies, and an artifact
         * outlives the run that wrote it.
         */
        const diagram = (over: Partial<Parameters<Store['saveTaskArtifact']>[1]> = {}) => ({
          taskId: '',
          name: 'architecture.mmd',
          kind: 'mermaid' as const,
          // `content`, not `body`: which home the bytes go to is the store's decision.
          content: 'graph TD\n  A --> B',
          ...over,
        })

        it('round-trips an artifact, including the optional fields', async () => {
          const task = await store.createTask(TASK, scope)
          const run = await store.createRun(task.id, 'claude-code', 'feat/x')

          const saved = await store.saveTaskArtifact(scope, {
            ...diagram(),
            taskId: task.id,
            runId: run.id,
            stage: 'design',
            title: 'How the pieces fit',
          })

          const fetched = await store.getTaskArtifact(saved.id)
          expect(fetched).toMatchObject({
            taskId: task.id,
            runId: run.id,
            stage: 'design',
            name: 'architecture.mmd',
            kind: 'mermaid',
            title: 'How the pieces fit',
            body: 'graph TD\n  A --> B',
            // Text stays here, in the row. See `chooseStorage`.
            storage: 'inline',
            contentType: 'text/plain; charset=utf-8',
          })
          // Bytes, so a list can show a size without reading every body.
          expect(fetched?.bytes).toBe(Buffer.byteLength('graph TD\n  A --> B', 'utf8'))
          expect(fetched?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
          // The hash is derived, not supplied — it cannot be recovered later for bytes that
          // have moved, so it is written from the start.
          expect(fetched?.sha256).toBe(
            createHash('sha256').update('graph TD\n  A --> B').digest('hex'),
          )
          expect(fetched?.storageKey).toBeUndefined()
        })

        it('reads the content back from the row for an inline artifact', async () => {
          // One method for both homes, so nothing outside the store branches on `storage`.
          const task = await store.createTask(TASK, scope)
          const saved = await store.saveTaskArtifact(scope, { ...diagram(), taskId: task.id })

          const content = await store.readTaskArtifactContent(saved.id)

          expect(content?.bytes.toString('utf8')).toBe('graph TD\n  A --> B')
          expect(content?.contentType).toBe('text/plain; charset=utf-8')
        })

        it('counts bytes rather than characters', async () => {
          /**
           * The column is checked against `octet_length`, so a body of multi-byte text whose
           * length was counted in characters would disagree with its own constraint and be
           * rejected on write. Postgres would refuse it; the in-memory store would not — which is
           * the shape of divergence these tests exist to catch.
           */
          const task = await store.createTask(TASK, scope)
          const text = '→ ✓ é 日本語'

          const saved = await store.saveTaskArtifact(scope, {
            ...diagram({ content: text }),
            taskId: task.id,
          })

          expect(saved.bytes).toBe(Buffer.byteLength(text, 'utf8'))
          expect(saved.bytes).toBeGreaterThan(text.length)
        })

        it('replaces an artifact of the same name rather than adding a second', async () => {
          // A stage that re-renders its diagram means to replace it. Two rows with one name leave
          // nothing to say which is current, and the later stage reads whichever comes back first.
          const task = await store.createTask(TASK, scope)

          const first = await store.saveTaskArtifact(scope, {
            ...diagram({ content: 'graph TD\n  A --> B' }),
            taskId: task.id,
          })
          const second = await store.saveTaskArtifact(scope, {
            ...diagram({ content: 'graph TD\n  A --> C' }),
            taskId: task.id,
          })

          expect(second.id).toBe(first.id)
          expect(second.body).toContain('A --> C')
          expect(await store.listTaskArtifacts(task.id)).toHaveLength(1)
          // The creation time survives the edit; only `updatedAt` moves.
          expect(second.createdAt).toBe(first.createdAt)
        })

        it('keeps the same name on two different tasks apart', async () => {
          // `design.md` is the obvious name, so every task will have one.
          const one = await store.createTask(TASK, scope)
          const two = await store.createTask(TASK, scope)

          await store.saveTaskArtifact(scope, { ...diagram({ content: 'one' }), taskId: one.id })
          await store.saveTaskArtifact(scope, { ...diagram({ content: 'two' }), taskId: two.id })

          expect((await store.listTaskArtifacts(one.id))[0]?.taskId).toBe(one.id)
          expect((await store.findTaskArtifact(two.id, 'architecture.mmd'))?.body).toBe('two')
        })

        it('leaves bodies out of a list', async () => {
          /**
           * A body may be most of a megabyte and a project may have a hundred artifacts, so a
           * list that carried them would send megabytes to render a sidebar. Asserted rather than
           * assumed because the Postgres store gets this right by naming columns — which a
           * `select()` added later would quietly undo.
           */
          const task = await store.createTask(TASK, scope)
          await store.saveTaskArtifact(scope, { ...diagram(), taskId: task.id })

          const [listed] = await store.listTaskArtifacts(task.id)
          expect(listed?.name).toBe('architecture.mmd')
          expect(listed).not.toHaveProperty('body')

          const [projectListed] = await store.listProjectArtifacts(scope)
          expect(projectListed).not.toHaveProperty('body')
        })

        it("lists the project's artifacts newest first", async () => {
          // The other half of what this is for: one task's artifact while reviewing it, and the
          // project's when you want to know what has already been decided.
          const one = await store.createTask(TASK, scope)
          const two = await store.createTask(TASK, scope)
          await store.saveTaskArtifact(scope, { ...diagram({ name: 'older' }), taskId: one.id })
          // A tick between them, so the two `updatedAt` values genuinely differ. Postgres has
          // microsecond precision and separates them anyway; the in-memory store keeps ISO
          // strings at millisecond precision, and this test is about ordering rather than
          // about how a tie is broken.
          await new Promise((resolve) => setTimeout(resolve, 5))
          await store.saveTaskArtifact(scope, { ...diagram({ name: 'newer' }), taskId: two.id })

          const listed = await store.listProjectArtifacts(scope)
          expect(listed.map((a) => a.name).slice(0, 2)).toEqual(['newer', 'older'])
        })

        it('records which run and stage wrote it, and works without either', async () => {
          /**
           * Both are optional on purpose. An artifact outlives the run that wrote it — the
           * column is `ON DELETE SET NULL`, because runs are pruned and artifacts are the
           * point — and a person may add one with no run behind it at all.
           *
           * The constraint's own behaviour is not asserted here: nothing in the store deletes a
           * run, so proving it would mean reaching past the store to restate what the migration
           * already declares.
           */
          const task = await store.createTask(TASK, scope)
          const run = await store.createRun(task.id, 'claude-code', 'feat/x')

          const attributed = await store.saveTaskArtifact(scope, {
            ...diagram({ name: 'from-a-run' }),
            taskId: task.id,
            runId: run.id,
            stage: 'design',
          })
          const byHand = await store.saveTaskArtifact(scope, {
            ...diagram({ name: 'by-hand' }),
            taskId: task.id,
          })

          expect(attributed).toMatchObject({ runId: run.id, stage: 'design' })
          expect(byHand.runId).toBeUndefined()
          expect(byHand.stage).toBeUndefined()
        })

        describe('versions', () => {
          /**
           * An iteration is a version, not a second artifact — and not a silent replacement.
           *
           * Overwriting by name was the right instinct with the wrong half implemented: an agent
           * redrawing a diagram means to revise *that* diagram, but the earlier attempt is often
           * the better one and there was no way back to it.
           */
          it('adds a version instead of a second artifact', async () => {
            const task = await store.createTask(TASK, scope)

            const first = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'graph TD\n  A --> B' }),
              taskId: task.id,
            })
            const second = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'graph TD\n  A --> C' }),
              taskId: task.id,
            })

            // The same artifact, moved on.
            expect(second.id).toBe(first.id)
            expect(first.version).toBe(1)
            expect(second.version).toBe(2)
            expect(second.versionCount).toBe(2)
            // And one entry in the list, not two.
            expect(await store.listTaskArtifacts(task.id)).toHaveLength(1)
          })

          it('keeps the earlier content readable', async () => {
            // The point of the whole thing: the previous attempt survives.
            const task = await store.createTask(TASK, scope)
            const v1 = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'the first attempt' }),
              taskId: task.id,
            })
            await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'the second attempt' }),
              taskId: task.id,
            })

            const older = await store.readTaskArtifactContent(v1.id, 1)
            const current = await store.readTaskArtifactContent(v1.id)

            expect(older?.bytes.toString('utf8')).toBe('the first attempt')
            expect(current?.bytes.toString('utf8')).toBe('the second attempt')
          })

          it('lists the history newest first, marking the current one', async () => {
            const task = await store.createTask(TASK, scope)
            const a = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'one' }),
              taskId: task.id,
              stage: 'design',
            })
            await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'two' }),
              taskId: task.id,
              stage: 'code',
            })

            const history = await store.listTaskArtifactVersions(a.id)

            expect(history.map((v) => v.version)).toEqual([2, 1])
            expect(history[0]?.isCurrent).toBe(true)
            expect(history[1]?.isCurrent).toBe(false)
            /**
             * Which stage produced each version.
             *
             * Previously the run and stage lived on the artifact, so an overwrite lost who wrote
             * the earlier content — exactly the question a history exists to answer.
             */
            expect(history.map((v) => v.stage)).toEqual(['code', 'design'])
            // No bodies: choosing what to look at should not cost the bytes of everything.
            expect(history[0]).not.toHaveProperty('body')
          })

          it('switches which version is shown, without copying anything', async () => {
            // A pointer move. Copying the chosen bytes back over the top would make "which
            // version is this" unanswerable, since the copy looks like a new revision.
            const task = await store.createTask(TASK, scope)
            const a = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'the good one' }),
              taskId: task.id,
            })
            await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'the regression' }),
              taskId: task.id,
            })

            const switched = await store.setCurrentArtifactVersion(a.id, 1)

            expect(switched?.version).toBe(1)
            expect(switched?.body).toBe('the good one')
            // Still two versions — nothing was written to go back.
            expect(switched?.versionCount).toBe(2)
            // And a plain read now returns the chosen one.
            expect((await store.getTaskArtifact(a.id))?.body).toBe('the good one')
          })

          it('refuses to point at a version that does not exist', async () => {
            // The pointer is a deferred foreign key, so an unchecked switch would fail at commit
            // with a constraint name rather than an answer a caller can turn into a 404.
            const task = await store.createTask(TASK, scope)
            const a = await store.saveTaskArtifact(scope, { ...diagram(), taskId: task.id })

            expect(await store.setCurrentArtifactVersion(a.id, 99)).toBeUndefined()
            expect((await store.getTaskArtifact(a.id))?.version).toBe(1)
          })

          it('carries on numbering after a switch backwards', async () => {
            /**
             * Someone switches to v1, keeps working, and saves. That must become v3 — not a
             * second v2, which the primary key would reject, and not v2 again, which would
             * overwrite history that is still referenced.
             */
            const task = await store.createTask(TASK, scope)
            const a = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'one' }),
              taskId: task.id,
            })
            await store.saveTaskArtifact(scope, { ...diagram({ content: 'two' }), taskId: task.id })
            await store.setCurrentArtifactVersion(a.id, 1)

            const next = await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'three' }),
              taskId: task.id,
            })

            expect(next.version).toBe(3)
            expect(next.versionCount).toBe(3)
          })

          it('lets a version change what kind it is', async () => {
            // A note that gains a diagram may legitimately move from markdown to mermaid, and
            // each version still has to be served as what it actually is.
            const task = await store.createTask(TASK, scope)
            const a = await store.saveTaskArtifact(scope, {
              taskId: task.id,
              name: 'design.md',
              kind: 'markdown',
              content: '# notes',
            })
            await store.saveTaskArtifact(scope, {
              taskId: task.id,
              name: 'design.md',
              kind: 'mermaid',
              content: 'graph TD\n  A --> B',
            })

            expect((await store.getTaskArtifact(a.id))?.kind).toBe('mermaid')
            const history = await store.listTaskArtifactVersions(a.id)
            expect(history.map((v) => v.kind)).toEqual(['mermaid', 'markdown'])
            // And the content type follows the kind, so v1 is not served as a diagram.
            expect(history[1]?.contentType).toContain('markdown')
          })

          it('deletes the whole history with the artifact', async () => {
            const task = await store.createTask(TASK, scope)
            const a = await store.saveTaskArtifact(scope, { ...diagram(), taskId: task.id })
            await store.saveTaskArtifact(scope, {
              ...diagram({ content: 'second' }),
              taskId: task.id,
            })

            expect(await store.deleteTaskArtifact(a.id)).toBe(true)
            expect(await store.listTaskArtifactVersions(a.id)).toHaveLength(0)
            expect(await store.getTaskArtifact(a.id)).toBeUndefined()
          })
        })

        describe('bytes that do not belong in a column', () => {
          /**
           * The extension this schema was shaped for.
           *
           * A diagram is text and belongs in the row; a screenshot is not and does not. What
           * matters is that nothing outside the store can tell the difference — `saveTaskArtifact`
           * takes content and `readTaskArtifactContent` returns content, and where the bytes went
           * is a routing decision recorded on the row.
           */
          /** A blob store that records what it holds, standing in for the bucket. */
          function fakeBlobs() {
            const objects = new Map<string, Buffer>()
            const deleted: string[] = []
            return {
              objects,
              deleted,
              blobs: {
                async put(input: {
                  projectId: string
                  taskId: string
                  name: string
                  contentType: string
                  bytes: Buffer
                }) {
                  const key = `artifacts/${input.projectId}/${input.taskId}/${input.name}`
                  objects.set(key, input.bytes)
                  return key
                },
                async get(key: string) {
                  return objects.get(key)
                },
                async delete(key: string) {
                  deleted.push(key)
                  objects.delete(key)
                },
              },
            }
          }

          // A one-pixel PNG, so the bytes are genuinely binary rather than text pretending.
          const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
          )

          it('sends an image to the blob store and reads it back byte for byte', async () => {
            const { blobs, objects } = fakeBlobs()
            store.useArtifactBlobs(blobs)
            const task = await store.createTask(TASK, scope)

            const saved = await store.saveTaskArtifact(scope, {
              taskId: task.id,
              name: 'screenshot.png',
              kind: 'image',
              contentType: 'image/png',
              content: png,
            })

            expect(saved.storage).toBe('s3')
            expect(saved.storageKey).toBeTruthy()
            // Never in the row: base64 in a text column costs a third more and is the wrong
            // instrument besides.
            expect(saved.body).toBeUndefined()
            expect(saved.bytes).toBe(png.byteLength)
            expect(objects.size).toBe(1)

            const content = await store.readTaskArtifactContent(saved.id)
            expect(content?.contentType).toBe('image/png')
            // Byte for byte, which is the only assertion that means anything for binary.
            expect(content?.bytes.equals(png)).toBe(true)
            store.useArtifactBlobs(undefined)
          })

          it('keeps a diagram inline however large it gets', async () => {
            /**
             * `mermaid` and `markdown` are read back *as text* by a later stage, so a round trip
             * through object storage to answer `read_artifact` would be latency for nothing.
             * Size does not change that.
             */
            const { blobs, objects } = fakeBlobs()
            store.useArtifactBlobs(blobs)
            const task = await store.createTask(TASK, scope)

            const saved = await store.saveTaskArtifact(scope, {
              ...diagram({ content: `graph TD\n${'  A --> B\n'.repeat(2000)}` }),
              taskId: task.id,
            })

            expect(saved.storage).toBe('inline')
            expect(objects.size).toBe(0)
            store.useArtifactBlobs(undefined)
          })

          it('refuses an image when the deployment has no blob store', async () => {
            /**
             * Refused on the *write*, naming what is missing. Accepting it and failing later
             * would produce an artifact that exists in every list and cannot be opened, which
             * is the failure that takes a day to understand.
             */
            store.useArtifactBlobs(undefined)
            const task = await store.createTask(TASK, scope)

            await expect(
              store.saveTaskArtifact(scope, {
                taskId: task.id,
                name: 'screenshot.png',
                kind: 'image',
                contentType: 'image/png',
                content: png,
              }),
            ).rejects.toThrow(/no object storage is configured/)
          })

          it('requires a content type for bytes it cannot guess one for', async () => {
            // `image/png` and `image/svg+xml` are both images and must not be served as each
            // other. Guessing is how an SVG becomes a download.
            const { blobs } = fakeBlobs()
            store.useArtifactBlobs(blobs)
            const task = await store.createTask(TASK, scope)

            await expect(
              store.saveTaskArtifact(scope, {
                taskId: task.id,
                name: 'unknown.bin',
                kind: 'file',
                content: png,
              }),
            ).rejects.toThrow(/content type/)
            store.useArtifactBlobs(undefined)
          })

          it('keeps an object per version, since the older one is still readable', async () => {
            /**
             * This used to assert the opposite — that overwriting removed the previous object —
             * which was right when a name held one revision. Versioning changed the contract:
             * the earlier bytes are the thing being kept, so both objects exist and the version
             * number is in the key so neither mutates the other.
             */
            const { blobs, objects } = fakeBlobs()
            store.useArtifactBlobs(blobs)
            const task = await store.createTask(TASK, scope)
            const first = await store.saveTaskArtifact(scope, {
              taskId: task.id,
              name: 'screenshot.png',
              kind: 'image',
              contentType: 'image/png',
              content: png,
            })

            const second = await store.saveTaskArtifact(scope, {
              taskId: task.id,
              name: 'screenshot.png',
              kind: 'image',
              contentType: 'image/png',
              content: Buffer.concat([png, Buffer.from([0])]),
            })

            expect(second.id).toBe(first.id)
            expect(second.version).toBe(2)
            expect(objects.size).toBe(2)
            // And both are readable, byte for byte.
            expect((await store.readTaskArtifactContent(first.id, 1))?.bytes.equals(png)).toBe(true)
            expect((await store.readTaskArtifactContent(first.id, 2))?.bytes.byteLength).toBe(
              png.byteLength + 1,
            )
            store.useArtifactBlobs(undefined)
          })

          it('prunes the oldest versions past the cap, and their objects', async () => {
            /**
             * History is bounded. An agent iterating in a loop would otherwise grow a bucket
             * without limit, and nobody scrolls back twenty revisions.
             *
             * The cap is lowered for the test rather than writing twenty rows to a database
             * eighty-five milliseconds away.
             */
            const { blobs, objects } = fakeBlobs()
            store.useArtifactBlobs(blobs)
            // Lowered on the store under test, so this proves the same code path on both.
            store.useArtifactVersionsKept(3)
            const task = await store.createTask(TASK, scope)

            for (let i = 1; i <= 5; i++) {
              await store.saveTaskArtifact(scope, {
                taskId: task.id,
                name: 'screenshot.png',
                kind: 'image',
                contentType: 'image/png',
                content: Buffer.concat([png, Buffer.from([i])]),
              })
            }

            const history = await store.listTaskArtifactVersions(
              (await store.findTaskArtifact(task.id, 'screenshot.png'))!.id,
            )
            expect(history.map((v) => v.version)).toEqual([5, 4, 3])
            // The objects went with the rows rather than being left in the bucket.
            expect(objects.size).toBe(3)
            store.useArtifactBlobs(undefined)
            store.useArtifactVersionsKept(20)
          })

          it('takes the object with the row when an artifact is deleted', async () => {
            const { blobs, objects } = fakeBlobs()
            store.useArtifactBlobs(blobs)
            const task = await store.createTask(TASK, scope)
            const saved = await store.saveTaskArtifact(scope, {
              taskId: task.id,
              name: 'screenshot.png',
              kind: 'image',
              contentType: 'image/png',
              content: png,
            })

            expect(await store.deleteTaskArtifact(saved.id)).toBe(true)
            expect(objects.size).toBe(0)
            store.useArtifactBlobs(undefined)
          })
        })

        it('deletes one by id', async () => {
          const task = await store.createTask(TASK, scope)
          const saved = await store.saveTaskArtifact(scope, { ...diagram(), taskId: task.id })

          expect(await store.deleteTaskArtifact(saved.id)).toBe(true)
          expect(await store.getTaskArtifact(saved.id)).toBeUndefined()
          // Idempotent, so a double-click on a delete button is not an error.
          expect(await store.deleteTaskArtifact(saved.id)).toBe(false)
        })
      })

      it('finds a run by its runtime handle', async () => {
        const task = await store.createTask(TASK, scope)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        await store.updateRun(run.id, { handle: 'container-xyz' })
        expect((await store.findRunByHandle('container-xyz'))?.id).toBe(run.id)
        expect(await store.findRunByHandle('nothing')).toBeUndefined()
      })

      it('lists unsettled runs across every non-terminal status but parked', async () => {
        // The reconciler sweeps exactly this set. `parked` waits on a human, not a container.
        const task = await store.createTask(TASK, scope)
        const ids: Record<string, string> = {}
        for (const status of [
          'queued',
          'provisioning',
          'running',
          'parked',
          'succeeded',
        ] as const) {
          const run = await store.createRun(task.id, 'claude-code', `feat/${status}`)
          await store.updateRun(run.id, { status })
          ids[status] = run.id
        }
        // Filtered to this test's own runs, because `listUnsettledRuns` is deliberately global:
        // one control plane sweeps every project, so a run dispatched elsewhere while this suite
        // is running legitimately appears in it. Asserting on the whole list made the test fail
        // whenever a real Fargate run happened to be in flight.
        const mine = new Set(Object.values(ids))
        const unsettled = (await store.listUnsettledRuns())
          .map((r) => r.id)
          .filter((id) => mine.has(id))
          .sort()
        expect(unsettled).toEqual([ids['queued']!, ids['provisioning']!, ids['running']!].sort())
      })

      it('scopes listRuns by task', async () => {
        const a = await store.createTask(TASK, scope)
        const b = await store.createTask(TASK, scope)
        await store.createRun(a.id, 'claude-code', 'feat/a')
        await store.createRun(b.id, 'claude-code', 'feat/b')
        expect(await store.listRuns(a.id)).toHaveLength(1)
        expect((await store.listRuns()).length).toBeGreaterThanOrEqual(2)
      })

      it('rejects a patch to a run that does not exist', async () => {
        await expect(
          store.updateRun('00000000-0000-0000-0000-00000000beef', { status: 'failed' }),
        ).rejects.toThrow(/no such run/)
      })

      it('persists stage records as structured data', async () => {
        const task = await store.createTask(TASK, scope)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        const records = [
          {
            stage: 'design' as const,
            attempt: 1,
            status: 'passed' as const,
            resumeToken: null,
            gatePassed: true,
            startedAt: '2026-01-01T00:00:00.000Z',
          },
        ]
        await store.updateRun(run.id, { records })
        expect((await store.getRun(run.id))?.records).toEqual(records)
      })
    })

    describe('events', () => {
      async function runFixture(): Promise<string> {
        const task = await store.createTask(TASK, scope)
        return (await store.createRun(task.id, 'claude-code', 'feat/x')).id
      }

      it('accepts seq 0 as the first event', async () => {
        const runId = await runFixture()
        expect(await store.appendEvent(event(runId, 0))).toBe(true)
        expect((await store.getRun(runId))?.seqHwm).toBe(0)
      })

      it('drops a duplicate, so a replay is not a second row', async () => {
        // The adapter re-sends everything unacknowledged on every reconnect by design.
        const runId = await runFixture()
        expect(await store.appendEvent(event(runId, 0))).toBe(true)
        expect(await store.appendEvent(event(runId, 0))).toBe(false)
        expect(await store.eventsSince(runId, -1)).toHaveLength(1)
      })

      it('accepts a late event that fills a gap, and never lowers the watermark', async () => {
        // The corrected contract, and the contract suite is what caught the old one being
        // wrong. Rejecting `seq <= seqHwm` would refuse a replay of seq 3 after 5 arrived
        // and make that hole permanent — the opposite of the gapless guarantee.
        const runId = await runFixture()
        await store.appendEvent(event(runId, 5))
        expect(await store.appendEvent(event(runId, 3))).toBe(true)
        expect((await store.getRun(runId))?.seqHwm).toBe(5)
        expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([3, 5])
      })

      it('still refuses an exact duplicate', async () => {
        const runId = await runFixture()
        await store.appendEvent(event(runId, 5))
        expect(await store.appendEvent(event(runId, 5))).toBe(false)
        expect(await store.eventsSince(runId, -1)).toHaveLength(1)
      })

      it('backfills only what is after `since`, which is what SSE needs', async () => {
        const runId = await runFixture()
        for (const seq of [0, 1, 2, 3]) await store.appendEvent(event(runId, seq))
        expect((await store.eventsSince(runId, 1)).map((e) => e.seq)).toEqual([2, 3])
        expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([0, 1, 2, 3])
      })

      it('returns events in seq order even when they arrived out of order', async () => {
        const runId = await runFixture()
        await store.appendEvents([event(runId, 0), event(runId, 1), event(runId, 2)])
        expect((await store.eventsSince(runId, -1)).map((e) => e.seq)).toEqual([0, 1, 2])
      })

      it('counts only genuinely new events in a batch', async () => {
        const runId = await runFixture()
        expect(await store.appendEvents([event(runId, 0), event(runId, 1)])).toBe(2)
        // A replayed batch overlapping what is stored: 2 was new, the rest were not.
        expect(await store.appendEvents([event(runId, 0), event(runId, 1), event(runId, 2)])).toBe(
          1,
        )
        expect(await store.eventsSince(runId, -1)).toHaveLength(3)
      })

      it('treats an empty batch as a no-op', async () => {
        expect(await store.appendEvents([])).toBe(0)
      })

      it('keeps the whole event body, so the log is replayable', async () => {
        const runId = await runFixture()
        // A stage-stamped event with a non-trivial payload, so the assertion covers more
        // than the two columns that are also stored separately.
        const original = AgentEvent.parse({
          seq: 0,
          runId,
          ts: '2026-01-01T00:00:00.000Z',
          stage: 'design',
          type: 'stage.entered',
          data: { attempt: 2 },
        })
        await store.appendEvent(original)
        expect((await store.eventsSince(runId, -1))[0]).toEqual(original)
      })

      it('isolates one run from another', async () => {
        const a = await runFixture()
        const b = await runFixture()
        await store.appendEvent(event(a, 0))
        expect(await store.eventsSince(b, -1)).toHaveLength(0)
      })
    })

    describe('subscription', () => {
      /**
       * Overlapping batches must not cost a live subscriber an event.
       *
       * This is where the bug lived, and it only reproduces against Postgres: `appendEvents`
       * awaits between its insert and its fan-out, so two batches for one run interleave and the
       * later one used to advance the subscriber's watermark past the earlier one. A Fargate run
       * dropped seqs 4, 6, 7 and 12 from a live stream while the database held all fourteen.
       *
       * In the contract rather than a unit test because both stores owe the same guarantee, and
       * the in-memory one satisfies it for a different reason (it re-reads the whole log).
       */
      it('delivers every seq exactly once when two batches overlap', async () => {
        const task = await store.createTask(TASK, scope)
        const run = await store.createRun(task.id, 'claude-code', 'feat/x')
        const seen: number[] = []
        store.subscribe(run.id, (e) => seen.push(e.seq), { since: -1 })

        // Started without awaiting the first, which is what the event socket does when a
        // container emits faster than a database round trip.
        const late = store.appendEvents([event(run.id, 4)])
        const early = store.appendEvents([event(run.id, 5), event(run.id, 6), event(run.id, 7)])
        await Promise.all([early, late])
        await new Promise((resolve) => setTimeout(resolve, 300))

        expect([...seen].sort((a, b) => a - b)).toEqual([4, 5, 6, 7])
        expect(new Set(seen).size).toBe(seen.length)
      })

      it('backfills from `since`, so there is no separate read to race', async () => {
        const task = await store.createTask(TASK, scope)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1, 2]) await store.appendEvent(event(runId, seq))

        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: 0 })
        await until(() => seen.length >= 2)
        // Exclusive: `since: 0` means "after seq 0".
        expect(seen).toEqual([1, 2])
        unsubscribe()
      })

      it('delivers the whole log for `since: -1`', async () => {
        const task = await store.createTask(TASK, scope)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1]) await store.appendEvent(event(runId, seq))

        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
        await until(() => seen.length >= 2)
        expect(seen).toEqual([0, 1])
        unsubscribe()
      })

      it('gives two subscribers of one run their own backlog', async () => {
        // A shared watermark let whoever subscribed first starve the second of its history.
        const task = await store.createTask(TASK, scope)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1, 2]) await store.appendEvent(event(runId, seq))

        const first: number[] = []
        const second: number[] = []
        const un1 = store.subscribe(runId, (e) => first.push(e.seq), { since: -1 })
        await until(() => first.length >= 3)
        const un2 = store.subscribe(runId, (e) => second.push(e.seq), { since: -1 })
        await until(() => second.length >= 3)

        expect(first).toEqual([0, 1, 2])
        expect(second).toEqual([0, 1, 2])
        un1()
        un2()
      })

      it('delivers only what follows a mid-log `since`', async () => {
        // Replaces a test for an "omitted since" mode that no longer exists: reading the
        // run's current position asynchronously could return a watermark that already
        // included the event the subscriber was meant to see, skipping it with nothing to
        // retry. `since` is required now, so the caller states where it is.
        const task = await store.createTask(TASK, scope)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        for (const seq of [0, 1]) await store.appendEvent(event(runId, seq))

        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: 1 })
        await store.appendEvent(event(runId, 2))
        await until(() => seen.length >= 1)
        await new Promise((resolve) => setTimeout(resolve, 250))

        expect(seen).toEqual([2])
        unsubscribe()
      })

      it('delivers new events to a listener and stops on unsubscribe', async () => {
        const task = await store.createTask(TASK, scope)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
        await store.appendEvent(event(runId, 0))
        await store.appendEvent(event(runId, 1))
        await until(() => seen.length >= 2)
        unsubscribe()
        await store.appendEvent(event(runId, 2))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(seen).toEqual([0, 1])
      })

      it('does not re-deliver a replayed duplicate', async () => {
        // Otherwise a reconnect would make the UI re-render events it already showed.
        const task = await store.createTask(TASK, scope)
        const runId = (await store.createRun(task.id, 'claude-code', 'feat/x')).id
        const seen: number[] = []
        const unsubscribe = store.subscribe(runId, (e) => seen.push(e.seq), { since: -1 })
        await store.appendEvent(event(runId, 0))
        await store.appendEvent(event(runId, 0))
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(seen).toEqual([0])
        unsubscribe()
      })
    })
  })
}

/**
 * The in-memory store's tenancy. Placeholders, because nothing joins on them here.
 */
const MEMORY_SCOPE: ProjectScope = {
  projectId: '00000000-0000-0000-0000-0000000000d1',
  clientSpaceId: '00000000-0000-0000-0000-0000000000d2',
  workspaceId: '00000000-0000-0000-0000-0000000000d3',
}

// A fresh in-memory store per test is what isolation means here, so `reset` swaps it.
let memory = new InMemoryStore()
contract(
  'InMemoryStore',
  new Proxy({} as Store, {
    get: (_target, prop) => Reflect.get(memory as object, prop, memory),
    /**
     * Writes go to the instance too.
     *
     * FOUND BY A STORE METHOD THAT SETS A FIELD. Without this trap, a method invoked through the
     * proxy runs with `this` bound to the *proxy*, so `this.blobs = …` landed on the dead target
     * object and every later read saw nothing — a store configured in a test and behaving as
     * though it had not been.
     */
    set: (_target, prop, value) => Reflect.set(memory as object, prop, value),
  }),
  MEMORY_SCOPE,
  {
    reset: async () => {
      memory = new InMemoryStore()
    },
  },
)

const dsn = connectionString()

/**
 * The project the tests own, which is not the one anyone dispatches into.
 *
 * These suites call `truncateAll()`, which deletes every task in their project. Pointing that at
 * the development project destroyed a live Fargate run mid-flight — the run finished and opened
 * its PR, and the row describing it was gone. `pnpm dev:seed` creates this second project for
 * exactly that reason.
 */
const liveProjectId = process.env['INTELLIDEV_TEST_PROJECT_ID']

if (dsn && liveProjectId) {
  const live = new PostgresStore({ connectionString: dsn, maxConnections: TEST_POOL })
  const found = await live.findProject(liveProjectId)

  if (!found) {
    await live.close()
    describe.skip(`PostgresStore (skipped: project ${liveProjectId} not in this database)`, () => {
      it('is skipped', () => {})
    })
  } else {
    contract('PostgresStore', live, found, {
      reset: async () => {
        await live.truncateAll(found)
      },
      dispose: async () => {
        await live.truncateAll(found)
        // `truncateAll` clears tasks, not the allowlist, and this runs against the same shared
        // database the product team uses — a leftover entry surfaces later as a repository
        // nobody remembers adding.
        await live.removeProjectRepo(found, 'acme', 'widget')
        await live.close()
      },
    })

    /**
     * `truncateAll` must not be able to reach a task this system did not create.
     *
     * This is the test the previous guard stood in for. `truncateAll` used to be
     * `truncate table tasks cascade` against an unqualified name, which resolved to
     * `public.tasks` — the product's own table, shared with an ingest pipeline — so the suite
     * was aimed at another team's data and survived only because the table was empty.
     *
     * The fix was to narrow it to tasks that have a runner spec, which is the definition of
     * agent work. A blanket skip would have protected the data by removing the coverage; this
     * protects it by proving the property, and it fails if anyone ever widens the statement.
     */
    describe('PostgresStore destructive safety', () => {
      it('leaves a product task with no runner spec untouched', async () => {
        // Its own store and pool: the contract suite's `dispose` closes `live` when its own
        // tests finish, which is before this sibling block runs.
        const own = new PostgresStore({ connectionString: dsn, maxConnections: TEST_POOL })
        const pool = new pg.Pool({
          connectionString: dsn,
          max: 1,
          ssl: { rejectUnauthorized: false },
        })
        // Inserted with raw SQL on purpose: the store has no way to create a spec-less task,
        // which is exactly why it needs proving that it cannot delete one either.
        const id = randomUUID()
        try {
          await pool.query(
            `insert into public.tasks (id, client_space_id, workspace_id, project_id, title)
             values ($1, $2, $3, $4, $5)`,
            [id, found.clientSpaceId, found.workspaceId, found.projectId, 'ingest-owned, not ours'],
          )

          await own.truncateAll(found)

          const after = await pool.query('select id from public.tasks where id = $1', [id])
          expect(after.rows).toHaveLength(1)
        } finally {
          await pool.query('delete from public.tasks where id = $1', [id]).catch(() => undefined)
          await pool.end()
          await own.close()
        }
      })
    })
  }
} else {
  const why = !dsn
    ? 'no SUPABASE_CONNECTION_STRING_SESSION configured'
    : 'no INTELLIDEV_TEST_PROJECT_ID — run `pnpm dev:seed`'
  describe.skip(`PostgresStore (skipped: ${why})`, () => {
    it('is skipped', () => {})
  })
}
