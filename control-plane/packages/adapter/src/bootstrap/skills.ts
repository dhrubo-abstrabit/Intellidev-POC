import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSkills, type SkillRef } from '@intellidev/shared'

/**
 * Discover skills from disk.
 *
 * In production the control plane resolves the skill set and puts it in the run spec. But
 * repo-native skills live in the *worktree*, which the control plane has never seen — so
 * something inside the container has to find those regardless, and a local run with no
 * control plane needs to find all of them.
 *
 * Precedence is `resolveSkills`': repo beats project beats org. A repo that ships its own
 * `migrations` skill overrides the project's, which is the behaviour a team expects when
 * they check one in.
 */
export async function discoverSkills(args: {
  /** Unpacked bundle; `skills/<name>/SKILL.md`. */
  bundleRoot?: string
  /** The worktree; `.claude/skills/<name>/SKILL.md` is repo-native. */
  worktree?: string
  /** Already resolved by the control plane. Discovery only fills gaps. */
  declared?: readonly SkillRef[]
}): Promise<SkillRef[]> {
  const found: SkillRef[] = [...(args.declared ?? [])]

  if (args.bundleRoot) {
    found.push(...(await scan(join(args.bundleRoot, 'skills'), 'project')))
  }
  if (args.worktree) {
    found.push(...(await scan(join(args.worktree, '.claude', 'skills'), 'repo')))
  }

  return resolveSkills(found)
}

async function scan(dir: string, origin: SkillRef['origin']): Promise<SkillRef[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const skills: SkillRef[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'SKILL.md')
    const body = await readFile(path, 'utf8').catch(() => null)
    // A directory without a SKILL.md is not a skill. Skipped quietly, because half-made
    // directories are normal while someone is writing one.
    if (body === null) continue

    const meta = parseFrontmatter(body)
    skills.push({
      name: meta.name ?? entry.name,
      origin,
      path: join(dir, entry.name, 'SKILL.md'),
      ...(meta.description ? { description: meta.description } : {}),
      stages: [],
    })
  }
  return skills
}

/**
 * Read `name` and `description` out of YAML frontmatter.
 *
 * Deliberately not a YAML parser: these two scalar fields are all a skill index needs, and
 * pulling in a parser to read them would be more code in the golden image than the feature
 * is worth. A skill with no frontmatter falls back to its directory name.
 */
export function parseFrontmatter(body: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body)
  if (!match?.[1]) return {}

  const out: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):\s*(.+)$/.exec(line.trim())
    if (!field?.[1] || !field[2]) continue
    const value = field[2].trim().replace(/^['"]|['"]$/g, '')
    if (field[1] === 'name') out.name = value
    else out.description = value
  }
  return out
}
