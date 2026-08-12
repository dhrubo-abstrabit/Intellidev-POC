import { describe, expect, it } from 'vitest'
import {
  EnvSpec,
  RESERVED_ENV,
  SecretRef,
  reservedCollisions,
  secretsForStage,
  unattestedSecrets,
} from './env.js'
import { ProjectManifest } from './manifest.js'
import { MIN_REDACTABLE_LENGTH, createRedactor, noopRedactor, redactDeep } from './redact.js'
import { DEFAULT_STAGE_TEMPLATE } from './stages.js'

describe('SecretRef', () => {
  const base = { name: 'DATABASE_URL', source: 'aws-secrets' as const, ref: 'arn:aws:...' }

  it('accepts an upper-snake env var name', () => {
    expect(SecretRef.parse(base).name).toBe('DATABASE_URL')
  })

  it('rejects a name that is not a valid env var', () => {
    expect(() => SecretRef.parse({ ...base, name: 'database-url' })).toThrow()
    expect(() => SecretRef.parse({ ...base, name: '1BAD' })).toThrow()
  })

  it('never carries a value field', () => {
    // `.strict()` is what stops someone pasting a secret into the manifest.
    expect(() => SecretRef.parse({ ...base, value: 'hunter2' })).toThrow()
  })

  it('defaults to not attested, so silence is treated as production', () => {
    expect(SecretRef.parse(base).sandboxAttested).toBe(false)
  })
})

describe('secret scoping', () => {
  const env = EnvSpec.parse({
    vars: { NODE_ENV: 'test' },
    secrets: [
      {
        name: 'DATABASE_URL',
        source: 'aws-ssm',
        ref: '/db',
        stages: ['test'],
        sandboxAttested: true,
      },
      { name: 'SENTRY_DSN', source: 'aws-ssm', ref: '/dsn', sandboxAttested: true },
    ],
  })

  it('gives a stage only the secrets scoped to it', () => {
    expect(secretsForStage(env, 'test').map((s) => s.name)).toEqual(['DATABASE_URL', 'SENTRY_DSN'])
    // Design has no business holding database credentials.
    expect(secretsForStage(env, 'design').map((s) => s.name)).toEqual(['SENTRY_DSN'])
  })

  it('blocks dispatch on any secret not attested as sandbox-scoped', () => {
    expect(unattestedSecrets(env)).toEqual([])
    const risky = EnvSpec.parse({
      secrets: [{ name: 'STRIPE_KEY', source: 'aws-secrets', ref: 'arn:x' }],
    })
    expect(unattestedSecrets(risky).map((s) => s.name)).toEqual(['STRIPE_KEY'])
  })

  it('rejects names the adapter owns', () => {
    const clashing = EnvSpec.parse({
      vars: { PATH: '/nope', SAFE: 'ok' },
      secrets: [{ name: 'GITHUB_TOKEN', source: 'aws-ssm', ref: '/t', sandboxAttested: true }],
    })
    // Overriding GITHUB_TOKEN would break the credential helper in a way that looks
    // like a git failure three stages later.
    expect(reservedCollisions(clashing)).toEqual(['GITHUB_TOKEN', 'PATH'])
    expect(RESERVED_ENV.has('RUN_TOKEN')).toBe(true)
  })

  it('renders a dotenv by default, because most repos expect one', () => {
    expect(EnvSpec.parse({}).dotenvPath).toBe('.env')
    expect(EnvSpec.parse({ dotenvPath: null }).dotenvPath).toBeNull()
  })
})

describe('manifest git strategy', () => {
  const minimal = {
    version: 1,
    project: 'acme-web',
    repos: [{ url: 'github.com/acme/web' }],
    harnesses: { default: 'opencode', allowed: ['opencode'], seatPool: 'pool' },
    stageTemplate: DEFAULT_STAGE_TEMPLATE,
  }

  it('attributes commits to a bot, not a person', () => {
    const git = ProjectManifest.parse(minimal).git
    expect(git.authorName).toContain('[bot]')
    expect(git.authorEmail).toContain('[bot]')
  })

  it('defaults to a blobless clone and reports rather than rebases', () => {
    const git = ProjectManifest.parse(minimal).git
    expect(git.partialClone).toBe(true)
    // A silent rebase can turn a clean diff into a wrong one.
    expect(git.onBaseMoved).toBe('report')
  })

  it('cleans up the branch when a run fails', () => {
    expect(ProjectManifest.parse(minimal).git.deleteBranchOnFailure).toBe(true)
  })

  it('keeps lfs and submodules opt-in, since both need credentials too', () => {
    const git = ProjectManifest.parse(minimal).git
    expect(git.lfs).toBe(false)
    expect(git.submodules).toBe(false)
  })
})

describe('createRedactor', () => {
  it('replaces a secret with a named marker', () => {
    const redact = createRedactor({ DATABASE_URL: 'postgres://user:pw@host/db' })
    expect(redact('connecting to postgres://user:pw@host/db now')).toBe(
      'connecting to [redacted:DATABASE_URL] now',
    )
  })

  it('replaces every occurrence, not just the first', () => {
    const redact = createRedactor({ TOKEN: 'sk-abcdefghijkl' })
    expect(redact('sk-abcdefghijkl and sk-abcdefghijkl')).toBe(
      '[redacted:TOKEN] and [redacted:TOKEN]',
    )
    expect(redact.count()).toBeGreaterThan(0)
  })

  it('replaces the longest secret first, so no recognisable tail survives', () => {
    // If the short one went first, the long one would leave `[redacted:SHORT]-suffix`.
    const redact = createRedactor({
      SHORT: 'secretvalue',
      LONG: 'secretvalue-with-suffix',
    })
    expect(redact('here is secretvalue-with-suffix')).toBe('here is [redacted:LONG]')
  })

  it('refuses to redact values too short to be distinctive', () => {
    // Redacting `test` would turn the whole log into markers and destroy debugging.
    const redact = createRedactor({ TINY: 'test', REAL: 'long-enough-value' })
    expect(redact('this is a test of long-enough-value')).toBe('this is a test of [redacted:REAL]')
    expect(redact.skipped).toEqual(['TINY'])
    expect(MIN_REDACTABLE_LENGTH).toBeGreaterThan(4)
  })

  it('ignores empty values rather than matching everything', () => {
    const redact = createRedactor({ EMPTY: '' })
    expect(redact('untouched')).toBe('untouched')
  })

  it('does nothing when there are no secrets', () => {
    expect(noopRedactor('anything')).toBe('anything')
    expect(noopRedactor.count()).toBe(0)
  })
})

describe('redactDeep', () => {
  const redact = createRedactor({ KEY: 'supersecretvalue' })

  it('walks nested structures and preserves types', () => {
    const input = {
      text: 'leaked supersecretvalue here',
      count: 42,
      flag: true,
      nothing: null,
      list: ['supersecretvalue', 7],
      nested: { deeper: { value: 'supersecretvalue' } },
    }
    const out = redactDeep(input, redact)
    expect(out.text).toBe('leaked [redacted:KEY] here')
    // A redacted payload must still satisfy the event schema, so types cannot change.
    expect(out.count).toBe(42)
    expect(out.flag).toBe(true)
    expect(out.nothing).toBeNull()
    expect(out.list[0]).toBe('[redacted:KEY]')
    expect(out.list[1]).toBe(7)
    expect(out.nested.deeper.value).toBe('[redacted:KEY]')
  })

  it('redacts object keys too, since a secret can be used as one', () => {
    const out = redactDeep({ supersecretvalue: 'v' }, redact) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['[redacted:KEY]'])
  })

  it('leaves clean payloads untouched', () => {
    const input = { a: 'fine', b: [1, 2] }
    expect(redactDeep(input, redact)).toEqual(input)
  })
})
