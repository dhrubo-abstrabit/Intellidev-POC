import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import type { BundleRef } from '@intellidev/shared'

/**
 * Gets the project bundle onto local disk, or refuses to.
 *
 * Fargate has no bind mounts, so the bundle arrives as an object over HTTPS instead of a
 * read-only mount. That changes the trust story completely: a mount is whatever the host
 * put there, while a download is whatever answered the request. The digest is what closes
 * that gap, and the **order of operations is the security property** — the archive is
 * hashed and compared before anything is extracted, so a tampered bundle never reaches the
 * filesystem, let alone a stage prompt.
 *
 * `file://` is passed through untouched, because that is the local Docker path and it must
 * keep working unchanged.
 */

export interface MaterialiseBundleOptions {
  readonly ref: BundleRef
  /** Where to extract to. Created if absent, and required to be empty. */
  readonly destDir: string
  readonly fetchImpl?: typeof fetch
  /** Bounded so a hung mirror cannot hold a run open forever. */
  readonly timeoutMs?: number
  readonly maxAttempts?: number
  /** Refuses an archive larger than this before writing it all to disk. */
  readonly maxBytes?: number
  readonly onProgress?: (message: string) => void
}

export interface MaterialisedBundle {
  /** Directory the bundle's contents are readable at. */
  readonly root: string
  /** `file` when the ref pointed at a local path and nothing was downloaded. */
  readonly source: 'file' | 'download'
  readonly bytes: number
  /** The digest actually observed. Equal to `ref.digest` for a download. */
  readonly digest: string
}

/** Digests are written `sha256:<hex>`, matching the image-digest convention. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * A local bundle needs no verification and gets none.
 *
 * The local path mounts a directory the developer controls; hashing it would fail on every
 * edit and teach people to bypass the check. `'local'` is the sentinel the dev spec uses.
 */
function isLocalRef(ref: BundleRef): boolean {
  return ref.url.startsWith('file:') || ref.url === '/dev/null'
}

export async function materialiseBundle(
  opts: MaterialiseBundleOptions,
): Promise<MaterialisedBundle> {
  const { ref } = opts
  const log = opts.onProgress ?? (() => {})

  if (isLocalRef(ref)) {
    const root = ref.url.startsWith('file:') ? fileURLToPath(ref.url) : ref.url
    log(`bundle: local path ${root}, digest not verified`)
    return { root, source: 'file', bytes: 0, digest: ref.digest }
  }

  // Refuse a malformed digest up front. A spec that reached us with `digest: 'local'` but a
  // remote URL is a dispatch bug, and running it would mean verifying nothing while
  // appearing to verify something — the worst of both.
  if (!DIGEST_PATTERN.test(ref.digest)) {
    throw new Error(
      `bundle digest must be sha256:<64 hex> to be verifiable, got ${JSON.stringify(ref.digest)}. ` +
        'A remote bundle without a real digest cannot be trusted and will not be used.',
    )
  }

  // A scratch directory of its own, so the unverified archive never sits beside the
  // extracted bundle where something could pick it up by mistake.
  const scratch = await mkdtemp(join(tmpdir(), 'intellidev-bundle-'))
  const archive = join(scratch, 'bundle.tar.gz')

  try {
    const { bytes, digest } = await downloadAndHash({ ...opts, target: archive, log })

    // The whole point. Compared before extraction, and with the archive still in a scratch
    // directory nothing else reads from.
    if (digest !== ref.digest) {
      throw new Error(
        `bundle digest mismatch: spec pinned ${ref.digest} but the object hashed to ${digest}. ` +
          'Refusing to extract — the bundle has changed since it was published.',
      )
    }
    log(`bundle: ${bytes} bytes verified against ${digest}`)

    await mkdir(opts.destDir, { recursive: true })
    await extract(archive, opts.destDir)
    return { root: opts.destDir, source: 'download', bytes, digest }
  } finally {
    // Never leave a possibly-tampered archive on disk for something else to find.
    await rm(scratch, { recursive: true, force: true })
  }
}

async function downloadAndHash(opts: {
  ref: BundleRef
  target: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxAttempts?: number
  maxBytes?: number
  log: (message: string) => void
}): Promise<{ bytes: number; digest: string }> {
  const impl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 60_000
  const maxAttempts = opts.maxAttempts ?? 3
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await impl(opts.ref.url, { signal: controller.signal })
      if (!response.ok) {
        // A presigned URL that has expired returns 403, which is worth saying plainly:
        // it is a dispatch-latency problem, not a corrupt bundle.
        throw new Error(
          `bundle fetch failed: ${response.status}` +
            (response.status === 403 ? ' (presigned URL expired or not authorised)' : ''),
        )
      }
      if (!response.body) throw new Error('bundle fetch returned no body')

      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > maxBytes) {
        throw new Error(`bundle is ${declared} bytes, over the ${maxBytes} limit`)
      }

      const hash = createHash('sha256')
      let bytes = 0
      await pipeline(
        response.body as unknown as AsyncIterable<Uint8Array>,
        async function* (source) {
          for await (const chunk of source) {
            bytes += chunk.byteLength
            // Checked while streaming, not just from the header: a server can lie about
            // content-length, and the point is to bound what reaches the disk.
            if (bytes > maxBytes) {
              throw new Error(`bundle exceeded the ${maxBytes} byte limit mid-stream`)
            }
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(opts.target),
      )

      return { bytes, digest: `sha256:${hash.digest('hex')}` }
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      // Neither of these becomes true on a retry: an expired presigned URL stays expired,
      // and an oversized archive stays oversized. Retrying would replace a precise error
      // with a vague "failed after 3 attempts".
      if (message.includes('403') || message.includes('limit')) throw error
      if (attempt < maxAttempts) {
        const backoff = 250 * 2 ** (attempt - 1)
        opts.log(`bundle: attempt ${attempt} failed (${message}); retrying in ${backoff}ms`)
        await new Promise((resolve) => setTimeout(resolve, backoff))
      }
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(
    `bundle download failed after ${maxAttempts} attempts: ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
  )
}

/**
 * Extracts with `tar`, which the golden image already has.
 *
 * Safe because the digest matched first: the archive is byte-for-byte the one that was
 * published, so its member paths are ours. `--no-same-owner` and `--no-same-permissions`
 * still apply, because the archive was created on a different machine and inheriting its
 * uids inside the container would be a surprise rather than a decision.
 */
async function extract(archive: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'tar',
      ['-xzf', archive, '-C', destDir, '--no-same-owner', '--no-same-permissions'],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`)),
    )
  })

  // A bundle with no prompts directory would fail much later, inside the first stage, with
  // a missing-file error that reads like a bug in the stage engine.
  const prompts = await stat(join(destDir, 'prompts')).catch(() => null)
  if (!prompts?.isDirectory()) {
    throw new Error(`extracted bundle has no prompts/ directory at ${destDir}`)
  }
}
