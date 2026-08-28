/**
 * Shared tenancy for tests that need a task but are not about tenancy.
 *
 * Every task now belongs to a project, and its repository has to be one that project is allowed
 * to act on. That is two setup steps a test about the reconciler or the event socket should not
 * have to restate, and restating it in five files is how they drift apart.
 */
import type { ProjectScope, Store } from '../src/store/types.js'

/**
 * Placeholder ids. Well-formed uuids because the columns are `uuid`, and visibly fake so a
 * value that escaped into a real database would be obvious rather than plausible.
 */
export const TEST_SCOPE: ProjectScope = {
  projectId: '00000000-0000-0000-0000-0000000000d1',
  clientSpaceId: '00000000-0000-0000-0000-0000000000d2',
  workspaceId: '00000000-0000-0000-0000-0000000000d3',
}

export const TEST_REPO = { owner: 'acme', repo: 'widget' }
export const TEST_REPO_URL = `https://github.com/${TEST_REPO.owner}/${TEST_REPO.repo}.git`

/**
 * Allowlists the test repository, so `createTask` can succeed.
 *
 * Idempotent, so it is safe in a `beforeEach` alongside a store reset.
 */
export async function allowTestRepo(store: Store, scope: ProjectScope = TEST_SCOPE) {
  return await store.addProjectRepo(scope, { ...TEST_REPO, installationRef: 'test' })
}

/**
 * Allowlists whatever repository a URL names.
 *
 * Needed because several tests deliberately use *other* hosts and paths — a scp-like remote, a
 * host with a port, a second repository — to prove the broker compares hosts correctly. A fixed
 * allowlist entry would force those URLs to change, which would quietly delete the thing they
 * were testing.
 */
export async function allowRepoFor(
  store: Store,
  repoUrl: string,
  scope: ProjectScope = TEST_SCOPE,
) {
  const path = (() => {
    try {
      return new URL(repoUrl).pathname
    } catch {
      return /^[^@]+@[^:]+:(.+)$/.exec(repoUrl)?.[1]
    }
  })()
  const [owner, repo] = (path ?? '')
    .replace(/^\//, '')
    .replace(/\.git$/, '')
    .split('/')
  if (!owner || !repo) throw new Error(`fixture cannot parse a repo from ${repoUrl}`)
  return await store.addProjectRepo(scope, { owner, repo, installationRef: 'test' })
}

/** A task body whose repository is the allowlisted one. */
export const TEST_TASK = {
  title: 'test task',
  description: 'created by a fixture',
  acceptanceCriteria: ['it works'],
  harness: 'claude-code' as const,
  repoUrl: TEST_REPO_URL,
  baseBranch: 'main',
  mcpServerIds: [] as string[],
}
