import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards a bug class TypeScript cannot see.
 *
 * When the store became async, three call sites kept their old synchronous shape and still
 * typechecked, because a promise is a perfectly valid value in an object literal or a
 * boolean context. `return { runs: store.listRuns(id) }` serialised as `{}` to the UI, and
 * `if (!store.getRun(id))` was always false. Neither is a type error; both are silent.
 *
 * A source-level assertion rather than a lint rule so it lives with the code it protects
 * and fails in the same `pnpm check` everything else does.
 */
const ASYNC_METHODS = [
  'createTask',
  'listTasks',
  'getTask',
  'setTaskStatus',
  'createRun',
  'getRun',
  'findRunByHandle',
  'listUnsettledRuns',
  'listRuns',
  'updateRun',
  'appendEvent',
  'appendEvents',
  'eventsSince',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

describe('every async store call is awaited or explicitly discarded', () => {
  it('finds no floating promise', () => {
    const root = new URL('../src', import.meta.url).pathname
    const offenders: string[] = []

    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, index) => {
        for (const method of ASYNC_METHODS) {
          // Matches `store.method(` / `this.store.method(` but not a `.` prefixed
          // continuation, and not the interface declaration itself.
          const pattern = new RegExp(`(^|[^a-zA-Z.])(\\w*[Ss]tore)\\.${method}\\(`)
          if (!pattern.test(line)) continue
          // `await`, an explicit `void`, or a callback body that returns it are all fine.
          if (/\bawait\b|\bvoid\b|=>\s*\w*[Ss]tore\./.test(line)) continue
          offenders.push(`${file.split('/src/')[1]}:${index + 1}  ${line.trim()}`)
        }
      })
    }

    expect(offenders, `unawaited store calls:\n${offenders.join('\n')}`).toEqual([])
  })
})
