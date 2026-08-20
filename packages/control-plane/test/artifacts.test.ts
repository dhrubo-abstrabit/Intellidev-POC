import { describe, expect, it } from 'vitest'
import { ArtifactStore, bundleKey, runSpecKey } from '../src/aws/artifacts.js'
import type { RunSpec } from '@intellidev/shared'

const SPEC = {
  runId: 'run_abc',
  projectId: 'acme',
  bundle: { url: 'https://signed/bundle', digest: `sha256:${'b'.repeat(64)}` },
} as unknown as RunSpec

function fakeS3() {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    store: new ArtifactStore({
      bucket: 'bkt',
      region: 'ap-south-1',
      client: {
        send: async (c: { input: Record<string, unknown> }) => {
          sent.push(c.input)
          return {}
        },
        config: {},
      } as never,
      signer: (async (_c: unknown, command: { input: Record<string, unknown> }) =>
        `https://bkt.s3/${String(command.input['Key'])}?X-Amz-Signature=stub`) as never,
    }),
  }
}

describe('artifact keys', () => {
  it('scopes every key by project, so two projects cannot collide', () => {
    expect(runSpecKey('acme', 'run_1')).toBe('runs/acme/run_1/spec.json')
    expect(bundleKey('acme', `sha256:${'a'.repeat(64)}`)).toBe(
      `bundles/acme/${'a'.repeat(64)}.tar.gz`,
    )
    expect(runSpecKey('other', 'run_1')).not.toBe(runSpecKey('acme', 'run_1'))
  })

  it('makes the bundle key content-addressed, so republishing is a no-op', () => {
    const digest = `sha256:${'c'.repeat(64)}`
    expect(bundleKey('p', digest)).toBe(bundleKey('p', digest))
    // A run in flight cannot have its bundle change underneath it, because a different
    // bundle is a different key rather than an overwrite.
    expect(bundleKey('p', digest)).not.toBe(bundleKey('p', `sha256:${'d'.repeat(64)}`))
  })
})

describe('ArtifactStore.putRunSpec', () => {
  it('writes to a key derived from the run, so a retried dispatch overwrites', async () => {
    const { sent, store } = fakeS3()
    const { key } = await store.putRunSpec(SPEC)
    expect(key).toBe('runs/acme/run_abc/spec.json')
    expect(sent[0]?.['Key']).toBe(key)
    // Dispatch is retried on throttling; two specs for one run would be a real ambiguity.
    await store.putRunSpec(SPEC)
    expect(sent[1]?.['Key']).toBe(key)
  })

  it('encrypts at rest, so a bucket misconfiguration fails the write', async () => {
    const { sent, store } = fakeS3()
    await store.putRunSpec(SPEC)
    expect(sent[0]?.['ServerSideEncryption']).toBe('AES256')
  })

  it('returns a presigned URL rather than a bucket path', async () => {
    // The run holds no S3 permission at all: one task definition serves every run, so any
    // grant on the task role would be a grant over every other run's spec.
    const { store } = fakeS3()
    const { url } = await store.putRunSpec(SPEC)
    expect(url).toContain('X-Amz-Signature')
    expect(url).toContain('runs/acme/run_abc/spec.json')
  })
})
