import { createHash } from 'node:crypto'
import type { ArtifactKind } from './types.js'

/**
 * Where an artifact's bytes live when a text column is the wrong instrument.
 *
 * An interface rather than the S3 client directly, for two reasons that both matter now: the
 * in-memory store needs a home for blobs so the contract tests can cover binary artifacts on
 * both stores, and a deployment with no bucket configured must fail on *writing* an image
 * rather than at some later read.
 */
export interface ArtifactBlobs {
  /**
   * Stores the bytes and returns the key they went to.
   *
   * The key is the blob store's to choose, and the row records what came back. The store used
   * to compute a key itself and hand it to `put` — which was fine until an implementation
   * chose differently, and then the row pointed at nothing while the object sat under another
   * name. Whoever writes the object names it.
   */
  put(input: {
    projectId: string
    taskId: string
    /** So an overwrite writes a new object rather than mutating one being read. */
    artifactId: string
    name: string
    contentType: string
    bytes: Buffer
  }): Promise<string>
  get(key: string): Promise<Buffer | undefined>
  delete(key: string): Promise<void>
}

/**
 * How big an inline body may be, and which kinds are allowed to be one.
 *
 * `mermaid` and `markdown` are always inline regardless of size: a later stage reads them back
 * *as text* through `read_artifact`, and a round trip through object storage to answer that is
 * latency for nothing. They are also the kinds that cannot plausibly be large — a diagram that
 * needs a megabyte of source is a diagram nobody can read.
 *
 * `html` is inline while it is small, because it usually is, and an object when it is not.
 * `image` and `file` are never inline: base64 in a JSON envelope already costs a third more
 * than the bytes, and a text column is not where binary belongs.
 */
export const INLINE_LIMIT_BYTES = 1_048_576
const ALWAYS_INLINE: readonly ArtifactKind[] = ['mermaid', 'markdown']
const NEVER_INLINE: readonly ArtifactKind[] = ['image', 'file']

export function chooseStorage(kind: ArtifactKind, byteLength: number): 'inline' | 's3' {
  if (NEVER_INLINE.includes(kind)) return 's3'
  if (ALWAYS_INLINE.includes(kind)) return 'inline'
  return byteLength <= INLINE_LIMIT_BYTES ? 'inline' : 's3'
}

/** Raised when an artifact needs a bucket and there is none. */
export class BlobStoreUnavailable extends Error {
  constructor(kind: ArtifactKind) {
    super(
      `this deployment cannot store a ${kind} artifact: no object storage is configured for ` +
        'artifact bodies',
    )
    this.name = 'BlobStoreUnavailable'
  }
}

/**
 * The default content type for a kind, when the writer did not say.
 *
 * Text kinds have one right answer. `image` and `file` do not — an `image/png` and an
 * `image/svg+xml` are both images and must not be served as each other — so those are required
 * from the caller rather than guessed. Guessing is how an SVG becomes a download.
 */
export function defaultContentType(kind: ArtifactKind): string | undefined {
  switch (kind) {
    case 'html':
      return 'text/html; charset=utf-8'
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    case 'mermaid':
      return 'text/plain; charset=utf-8'
    default:
      return undefined
  }
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The key an artifact's object lives under.
 *
 * Includes the artifact's own id rather than only its name, so overwriting a name writes a *new*
 * object and the old one can be removed deliberately. Deriving the key from the name alone would
 * make an overwrite silently mutate an object that a half-finished read might still be streaming.
 */
export function artifactObjectKey(input: {
  projectId: string
  taskId: string
  artifactId: string
  name: string
}): string {
  // The name is included for the benefit of anyone looking in the bucket, and sanitised because
  // it reaches a key: the endpoint already restricts it, and a key is the wrong place to find
  // out that something slipped through.
  const safe = input.name.replace(/[^A-Za-z0-9._-]/g, '_')
  return `artifacts/${input.projectId}/${input.taskId}/${input.artifactId}-${safe}`
}
