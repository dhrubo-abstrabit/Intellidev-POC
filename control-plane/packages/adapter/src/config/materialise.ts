import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renderForHarness } from './renderers.js'
import type { ProjectedFile, ProjectionSpec } from './spec.js'

/**
 * Write a harness's config to disk.
 *
 * Idempotent in the strict sense: running it twice writes nothing the second time, and
 * the report says so. That matters because a resumed run re-materialises before
 * continuing, and a config file whose mtime churns on every resume makes it impossible to
 * tell whether anything actually changed.
 */
export interface MaterialiseReport {
  written: string[]
  unchanged: string[]
  /** Links declared by the projection, and whether each had to be (re)created. */
  links: Array<{ link: string; target: string; created: boolean }>
}

export async function materialiseConfig(spec: ProjectionSpec): Promise<MaterialiseReport> {
  const { files, links } = renderForHarness(spec)
  const report: MaterialiseReport = { written: [], unchanged: [], links: [] }

  for (const file of files) {
    if (await writeIfChanged(file)) report.written.push(file.path)
    else report.unchanged.push(file.path)
  }

  // No harness special-casing here: whatever the projection declared gets created.
  for (const link of links) {
    report.links.push({ ...link, created: await ensureSymlink(link.link, link.target) })
  }

  return report
}

/** Returns true when the file was actually written. */
export async function writeIfChanged(file: ProjectedFile): Promise<boolean> {
  const existing = await readFile(file.path, 'utf8').catch(() => null)
  if (existing === file.contents) return false
  await mkdir(dirname(file.path), { recursive: true })
  await writeFile(file.path, file.contents, { mode: file.mode ?? 0o644 })
  return true
}

/**
 * Point a path at the skills directory.
 *
 * A symlink rather than a copy, so a large skill bundle is not duplicated per run and a
 * skill edited in the bundle is immediately live. An existing link to the right target is
 * left alone; anything else there is replaced, because a stale link would silently serve
 * the previous run's skills.
 */
export async function ensureSymlink(link: string, target: string): Promise<boolean> {
  const current = await lstat(link).catch(() => null)
  if (current?.isSymbolicLink()) {
    const existing = await readlink(link).catch(() => null)
    if (existing === target) return false
  }
  if (current) await rm(link, { recursive: true, force: true })
  await mkdir(dirname(link), { recursive: true })
  await symlink(target, link, 'dir')
  return true
}
