import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the constraint that everything is scoped by project.
 *
 * `projectId: 'local'` was inlined in the run spec, which meant every project would have
 * shared one cache prefix and one seat pool. A source-level assertion rather than a
 * behavioural one because `buildRunSpec` is not exported — and the thing worth preventing
 * is the literal coming back, which is exactly what this catches.
 */
const source = readFileSync(join(import.meta.dirname, '../src/dispatch.ts'), 'utf8')

describe('project scoping', () => {
  it('takes projectId from config rather than a literal', () => {
    expect(source).toContain('projectId: config.projectId')
    expect(source).not.toContain("projectId: 'local'")
  })

  it('derives the manifest project and seat pool from the same value', () => {
    expect(source).toContain('project: config.projectId')
    expect(source).toContain('pool: config.projectId')
  })

  it('derives the cache name from the spec, so it cannot drift from the project', () => {
    expect(source).toContain('intellidev-cache-${spec.projectId}')
  })
})
