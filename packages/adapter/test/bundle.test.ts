import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { materialiseBundle } from '../src/bootstrap/bundle.js'

/** Builds a real tar.gz of a minimal bundle and returns its bytes and digest. */
async function makeBundle(extra: Record<string, string> = {}) {
  const src = await mkdtemp(join(tmpdir(), 'bundle-src-'))
  await mkdir(join(src, 'prompts'), { recursive: true })
  await writeFile(join(src, 'prompts', 'code.md'), '# code\n')
  for (const [rel, body] of Object.entries(extra)) {
    await mkdir(join(src, rel, '..'), { recursive: true }).catch(() => {})
    await writeFile(join(src, rel), body)
  }
  const archive = join(src, '..', `${src.split('/').pop()}.tar.gz`)
  spawnSync('tar', ['-czf', archive, '-C', src, '.'], { stdio: 'ignore' })
  const bytes = await readFile(archive)
  return { archive, bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }
}

function respondWith(bytes: Buffer, status = 200): typeof fetch {
  return (async () =>
    new Response(status === 200 ? new Uint8Array(bytes) : null, {
      status,
      headers: { 'content-length': String(bytes.byteLength) },
    })) as unknown as typeof fetch
}

describe('materialiseBundle over the network', () => {
  it('extracts a bundle whose digest matches', async () => {
    const { bytes, digest } = await makeBundle()
    const dest = join(await mkdtemp(join(tmpdir(), 'bundle-dest-')), 'bundle')
    const result = await materialiseBundle({
      ref: { url: 'https://example.test/b.tar.gz', digest },
      destDir: dest,
      fetchImpl: respondWith(bytes),
    })
    expect(result.source).toBe('download')
    expect(result.digest).toBe(digest)
    expect(await readdir(join(dest, 'prompts'))).toContain('code.md')
  })

  // The done-condition for C2: a tampered bundle fails closed.
  it('refuses to extract when the digest does not match', async () => {
    const { bytes } = await makeBundle()
    const dest = join(await mkdtemp(join(tmpdir(), 'bundle-dest-')), 'bundle')
    const wrong = `sha256:${'0'.repeat(64)}`
    await expect(
      materialiseBundle({
        ref: { url: 'https://example.test/b.tar.gz', digest: wrong },
        destDir: dest,
        fetchImpl: respondWith(bytes),
      }),
    ).rejects.toThrow(/digest mismatch/)
    // Nothing may reach the filesystem — verification happens before extraction, so a
    // tampered archive never becomes files a stage prompt could read.
    await expect(readdir(dest)).rejects.toThrow()
  })

  it('rejects a remote bundle whose digest is not verifiable at all', async () => {
    // The local dev spec uses `digest: 'local'`. Pairing that sentinel with a remote URL
    // would mean verifying nothing while appearing to verify something.
    const { bytes } = await makeBundle()
    const dest = join(await mkdtemp(join(tmpdir(), 'bundle-dest-')), 'bundle')
    await expect(
      materialiseBundle({
        ref: { url: 'https://example.test/b.tar.gz', digest: 'local' },
        destDir: dest,
        fetchImpl: respondWith(bytes),
      }),
    ).rejects.toThrow(/must be sha256/)
  })

  it('does not retry a 403, because an expired URL stays expired', async () => {
    let calls = 0
    const impl = (async () => {
      calls += 1
      return new Response(null, { status: 403 })
    }) as unknown as typeof fetch
    await expect(
      materialiseBundle({
        ref: { url: 'https://example.test/b.tar.gz', digest: `sha256:${'a'.repeat(64)}` },
        destDir: join(tmpdir(), 'never'),
        fetchImpl: impl,
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/403/)
    expect(calls).toBe(1)
  })

  it('retries a transient 500 and then succeeds', async () => {
    const { bytes, digest } = await makeBundle()
    let calls = 0
    const impl = (async () => {
      calls += 1
      if (calls === 1) return new Response(null, { status: 500 })
      return new Response(new Uint8Array(bytes), {
        headers: { 'content-length': String(bytes.byteLength) },
      })
    }) as unknown as typeof fetch
    const dest = join(await mkdtemp(join(tmpdir(), 'bundle-dest-')), 'bundle')
    const result = await materialiseBundle({
      ref: { url: 'https://example.test/b.tar.gz', digest },
      destDir: dest,
      fetchImpl: impl,
    })
    expect(calls).toBe(2)
    expect(result.digest).toBe(digest)
  })

  it('refuses an oversized archive before writing it all to disk', async () => {
    const { bytes, digest } = await makeBundle()
    await expect(
      materialiseBundle({
        ref: { url: 'https://example.test/b.tar.gz', digest },
        destDir: join(tmpdir(), 'never'),
        fetchImpl: respondWith(bytes),
        maxBytes: 10,
      }),
    ).rejects.toThrow(/limit/)
  })

  it('rejects an archive with no prompts directory', async () => {
    // Otherwise this surfaces much later as a missing-file error inside the first stage,
    // which reads like a bug in the stage engine.
    const src = await mkdtemp(join(tmpdir(), 'bundle-empty-'))
    await writeFile(join(src, 'README.md'), 'no prompts here')
    const archive = join(src, '..', 'empty.tar.gz')
    spawnSync('tar', ['-czf', archive, '-C', src, '.'], { stdio: 'ignore' })
    const bytes = await readFile(archive)
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const dest = join(await mkdtemp(join(tmpdir(), 'bundle-dest-')), 'bundle')
    await expect(
      materialiseBundle({
        ref: { url: 'https://example.test/b.tar.gz', digest },
        destDir: dest,
        fetchImpl: respondWith(bytes),
      }),
    ).rejects.toThrow(/no prompts/)
  })
})

describe('materialiseBundle locally', () => {
  it('passes a file:// bundle through without hashing it', async () => {
    // The local Docker path mounts a directory the developer edits; hashing it would fail
    // on every change and teach people to bypass the check.
    const src = await mkdtemp(join(tmpdir(), 'bundle-local-'))
    await mkdir(join(src, 'prompts'), { recursive: true })
    const result = await materialiseBundle({
      ref: { url: pathToFileURL(src).href, digest: 'local' },
      destDir: join(tmpdir(), 'unused'),
      fetchImpl: (() => {
        throw new Error('must not fetch for a local bundle')
      }) as unknown as typeof fetch,
    })
    expect(result.source).toBe('file')
    expect(result.root).toBe(src)
  })
})

describe('mirrorKey', () => {
  it('gives two repositories in one project different mirrors', async () => {
    // The bug this closes: the mirror was a fixed `repo.git` inside a per-project cache, so
    // a second repository reused the first's mirror and failed on `fetch origin` with an
    // error that read like a broken remote rather than a cache collision.
    const { mirrorKey } = await import('../src/bootstrap/run.js')
    expect(mirrorKey('https://github.com/a/one.git')).not.toBe(
      mirrorKey('https://github.com/a/two.git'),
    )
  })

  it('is stable, so the second run on a repo is a cache hit', async () => {
    const { mirrorKey } = await import('../src/bootstrap/run.js')
    const url = 'https://github.com/octocat/Hello-World.git'
    expect(mirrorKey(url)).toBe(mirrorKey(url))
  })

  it('stays readable and filesystem-safe', async () => {
    const { mirrorKey } = await import('../src/bootstrap/run.js')
    expect(mirrorKey('https://github.com/octocat/Hello-World.git')).toMatch(
      /^Hello-World-[0-9a-f]{12}$/,
    )
    expect(mirrorKey('file:///tmp/weird name/../origin.git')).toMatch(/^[a-zA-Z0-9._-]+$/)
  })

  it('distinguishes URLs that differ only in credentials', async () => {
    const { mirrorKey } = await import('../src/bootstrap/run.js')
    expect(mirrorKey('https://u:p@h/r.git')).not.toBe(mirrorKey('https://h/r.git'))
  })
})
