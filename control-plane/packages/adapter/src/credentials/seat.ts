import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import type { SeatCredential } from './types.js'

/**
 * The shape of a seat credential's `material`, and how it reaches a harness.
 *
 * Each CLI authenticates its own way — Claude Code reads an environment variable, Codex and
 * opencode read a JSON file under HOME — so the material describes *where things go* rather
 * than encoding one harness's habits. Adding a harness becomes data, not a code path.
 *
 * Deliberately an import rather than an OAuth flow of our own. A subscription login belongs to
 * the vendor's own client id, and reimplementing it would mean impersonating their client:
 * fragile, and not ours to do. The sanctioned commands (`claude setup-token`, `codex login`,
 * `opencode auth login`) run on a machine with a browser, and what they produce is what gets
 * imported here.
 */
export interface SeatMaterial {
  /** Merged into the harness's environment. */
  env?: Record<string, string>
  /** Written under the run's HOME. Relative paths only. */
  files?: Array<{ path: string; contents: string }>
}

/** Where each harness keeps its credential, relative to HOME. */
export const HARNESS_CREDENTIAL_PATH: Record<string, string> = {
  'claude-code': '.claude/.credentials.json',
  codex: '.codex/auth.json',
  opencode: '.local/share/opencode/auth.json',
}

export function parseSeatMaterial(material: Record<string, unknown>): SeatMaterial {
  const env = material['env']
  const files = material['files']
  return {
    ...(isStringRecord(env) ? { env } : {}),
    ...(Array.isArray(files)
      ? {
          files: files.flatMap((entry) => {
            if (!entry || typeof entry !== 'object') return []
            const path = (entry as Record<string, unknown>)['path']
            const contents = (entry as Record<string, unknown>)['contents']
            if (typeof path !== 'string' || typeof contents !== 'string') return []
            return [{ path, contents }]
          }),
        }
      : {}),
  }
}

/**
 * Write a seat credential into the run's HOME and return the env it contributes.
 *
 * Files are written `0600`, and their paths are confined to HOME: material arrives from the
 * control plane, and a `../` in it would otherwise be a write anywhere the adapter can reach.
 * Returns the env rather than applying it, so the caller decides which stages see it.
 */
export async function materialiseSeat(args: {
  credential: SeatCredential
  home: string
  onFile?: (path: string) => void
}): Promise<Record<string, string>> {
  const material = parseSeatMaterial(args.credential.material)

  for (const file of material.files ?? []) {
    const target = normalize(join(args.home, file.path))
    if (isAbsolute(file.path) || relative(args.home, target).startsWith('..')) {
      throw new Error(`seat credential file "${file.path}" would land outside HOME`)
    }
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.contents)
    // The harness reads it; nothing else should be able to.
    await chmod(target, 0o600)
    args.onFile?.(target)
  }

  return material.env ?? {}
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}
