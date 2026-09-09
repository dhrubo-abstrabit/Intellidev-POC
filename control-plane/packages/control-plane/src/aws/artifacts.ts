import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { RunSpec } from '@intellidev/shared'

/**
 * Puts a run's spec where the run can fetch it, and nowhere else.
 *
 * This replaces the bind mounts, and the access model is the point. One task definition
 * serves every run, so any S3 grant on the run's task role would be a grant over *every*
 * run's spec — its manifest, its task brief, its seat pool. Instead the control plane
 * presigns a GET for exactly one key, with a short life. The run therefore holds no S3
 * permission at all, which is the same principle as the credential broker: a run gets the
 * one thing it needs, not the ability to ask for anything.
 *
 * Keys are scoped by project throughout, so two projects cannot collide or read each other:
 *
 *   runs/<projectId>/<runId>/spec.json
 *   bundles/<projectId>/<digest>.tar.gz
 */

export interface ArtifactStoreOptions {
  readonly bucket: string
  readonly region: string
  readonly client?: Pick<S3Client, 'send' | 'config'>
  /**
   * How long a presigned URL stays valid.
   *
   * Long enough to cover the whole dispatch budget plus an image pull and a retry, short
   * enough that a URL leaked in a log is not a durable credential. The failure mode if it
   * is too short is a 403 at boot, which the adapter reports as a dispatch-latency problem
   * rather than a corrupt bundle.
   */
  readonly urlTtlSeconds?: number
  readonly signer?: typeof getSignedUrl
}

export function runSpecKey(projectId: string, runId: string): string {
  return `runs/${projectId}/${runId}/spec.json`
}

export function bundleKey(projectId: string, digest: string): string {
  // The digest is content-addressed, so the key is immutable: republishing identical
  // content is a no-op, and a run in flight can never have its bundle change underneath it.
  return `bundles/${projectId}/${digest.replace(/^sha256:/, '')}.tar.gz`
}

export class ArtifactStore {
  private readonly client: Pick<S3Client, 'send' | 'config'>
  private readonly ttl: number
  private readonly signer: typeof getSignedUrl

  constructor(private readonly opts: ArtifactStoreOptions) {
    this.client = opts.client ?? new S3Client({ region: opts.region })
    this.ttl = opts.urlTtlSeconds ?? 3600
    this.signer = opts.signer ?? getSignedUrl
  }

  /**
   * Writes the spec and returns a presigned URL for it.
   *
   * Idempotent by key: the key is derived from the run id, so a retried dispatch overwrites
   * the same object rather than creating a second one. That matters because dispatch is
   * retried on throttling, and two specs for one run would be a genuine ambiguity.
   */
  async putRunSpec(spec: RunSpec): Promise<{ key: string; url: string }> {
    const key = runSpecKey(spec.projectId, spec.runId)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: JSON.stringify(spec),
        ContentType: 'application/json',
        // Server-side encryption is enforced by the bucket policy; stating it here means a
        // bucket misconfiguration fails the write rather than silently storing plaintext.
        ServerSideEncryption: 'AES256',
        Metadata: { 'run-id': spec.runId, 'project-id': spec.projectId },
      }),
    )
    return { key, url: await this.presignGet(key) }
  }

  /** A presigned GET, valid for `urlTtlSeconds`. */
  async presignGet(key: string): Promise<string> {
    return this.signer(
      this.client as S3Client,
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      { expiresIn: this.ttl },
    )
  }
}
