import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * No destructive suite may point at the project someone dispatches into.
 *
 * This is a source-level check because the failure it prevents is not observable from inside a
 * test run. The contract suite calls `truncateAll()`, which deletes every task in its project;
 * pointed at the development project it destroyed a live Fargate run mid-flight. The run
 * finished and opened its PR, and the row describing it simply was not there afterwards —
 * nothing failed, nothing logged, the evidence was the absence.
 *
 * `pnpm dev:seed` creates a second project for tests. This makes forgetting to use it a failing
 * test rather than a lost run.
 */
describe('destructive suites use the test project', () => {
  const dir = new URL('.', import.meta.url).pathname
  // This file names both strings in order to look for them, so it would flag itself.
  const SELF = 'no-wiping-dev-project.test.ts'
  const suites = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== SELF)

  it('finds the suites that truncate', () => {
    const truncating = suites.filter((f) =>
      readFileSync(`${dir}${f}`, 'utf8').includes('truncateAll()'),
    )
    // A sanity check on the check: if this ever hits zero, the rule below is passing because it
    // has nothing to examine.
    expect(truncating.length).toBeGreaterThan(0)
  })

  it("scopes the delete to a project, so it cannot reach another project's runs", () => {
    // The check the previous version of this file missed. Pointing tests at their own project
    // achieved nothing while `truncateAll` deleted every runner task in the database regardless
    // of project — a live Fargate run was destroyed a second time before that was noticed.
    // Asserted on the SQL rather than on the caller, because the blast radius is the statement's.
    const source = readFileSync(
      new URL('../src/store/postgres.ts', import.meta.url).pathname,
      'utf8',
    )
    const statement = source.slice(
      source.indexOf('async truncateAll('),
      source.indexOf('async close('),
    )
    expect(statement).toContain('project_id =')
    expect(statement).toContain('runner.task_specs')
  })

  it('never reads INTELLIDEV_PROJECT_ID, which is the one being dispatched into', () => {
    const offenders = suites.filter((file) => {
      const source = readFileSync(`${dir}${file}`, 'utf8')
      return source.includes('truncateAll()') && source.includes("INTELLIDEV_PROJECT_ID'")
    })
    expect(offenders).toEqual([])
  })
})
