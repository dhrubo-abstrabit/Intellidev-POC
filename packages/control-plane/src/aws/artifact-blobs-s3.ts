import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { ArtifactBlobs } from '../store/artifact-blobs.js'
import { artifactObjectKey } from '../store/artifact-blobs.js'

/**
 * Artifact bodies as objects, for the ones a text column cannot hold.
 *
 * Shares the bucket with run specs and bundles under its own `artifacts/` prefix. A second
 * bucket would be a second thing to provision, grant and lifecycle for no isolation gain: the
 * prefix is already project-scoped, and nothing but the control plane has any grant on this
 * bucket at all.
 *
 * **Nothing is ever presigned here, deliberately.** A run spec is presigned because a container
 * has to fetch it with no AWS credentials. An artifact is read by a *person*, through the
 * authenticated API, and the bytes are proxied — so there is no URL that grants access to an
 * artifact, and losing one cannot leak it. That costs a hop through the control plane and buys
 * the property that the whole feature was asked about.
 */
export interface S3ArtifactBlobsOptions {
  readonly bucket: string
  readonly region: string
  readonly client?: Pick<S3Client, 'send'>
}

export class S3ArtifactBlobs implements ArtifactBlobs {
  private readonly client: Pick<S3Client, 'send'>

  constructor(private readonly opts: S3ArtifactBlobsOptions) {
    this.client = opts.client ?? new S3Client({ region: opts.region })
  }

  async put(input: {
    projectId: string
    taskId: string
    /** The artifact's id, so an overwrite writes a new object rather than mutating one. */
    artifactId?: string
    name: string
    contentType: string
    bytes: Buffer
  }): Promise<string> {
    const key = artifactObjectKey({
      projectId: input.projectId,
      taskId: input.taskId,
      // An id is always supplied by the store; the fallback keeps the interface usable for a
      // caller that has not created the row yet.
      artifactId: input.artifactId ?? 'unassigned',
      name: input.name,
    })
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: input.bytes,
        ContentType: input.contentType,
        /*
         * `nosniff` at the source as well as on the response.
         *
         * These bytes were written by an agent. Whatever the content type says, no consumer of
         * this object should be guessing a different one from its first few bytes.
         */
        ContentDisposition: 'inline',
      }),
    )
    return key
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      )
      const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
      if (!body?.transformToByteArray) return undefined
      return Buffer.from(await body.transformToByteArray())
    } catch (error) {
      /**
       * A missing object reads as absent rather than as a fault.
       *
       * The row is the source of truth for whether an artifact exists, so an object that is
       * gone means the two have diverged — worth reporting as "no content" and letting the
       * caller 404, rather than a 500 that says nothing about which artifact.
       */
      if ((error as { name?: string }).name === 'NoSuchKey') return undefined
      throw error
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }))
  }
}
