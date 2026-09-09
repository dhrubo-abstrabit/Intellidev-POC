/**
 * The store's public surface.
 *
 * Kept as a module so every existing import keeps working while the implementations moved
 * into `store/`. `Store` is an interface now, not a class — `InMemoryStore` is what used to
 * be called `Store`, and `PostgresStore` is the deployed one.
 */
export type { Listener, RunRow, Store, TaskRow } from './store/types.js'
export { InMemoryStore } from './store/memory.js'
export { PostgresStore, type PostgresStoreOptions } from './store/postgres.js'
export { productTasks, projectRepos, runEvents, runs, taskSpecs, schema } from './store/schema.js'
export { RepoNotAllowed } from './store/types.js'
export type { ProjectRepoRow, ProjectScope } from './store/types.js'
