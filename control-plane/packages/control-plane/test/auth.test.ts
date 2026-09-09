import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PostgresStore } from '../src/store/postgres.js'
import { JwtVerifier, InvalidToken } from '../src/auth/jwt.js'
import type { AuthenticatedUser } from '../src/auth/jwt.js'

/**
 * Who may reach the API, and what they may do once they are in.
 *
 * Two halves, deliberately separate. Verification is about the token being genuine, and is
 * tested against a real Supabase sign-in because a hand-rolled token proves nothing about the
 * thing that will actually arrive. Authorization is about what that person may touch, and is
 * asked of the product's own helper functions — the same ones backing every RLS policy — so a
 * change to their membership model changes this without anything here being edited.
 */
function fromEnv(key: string): string | undefined {
  const direct = process.env[key]
  if (direct) return direct
  try {
    return readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${key}=`))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

const dsn = fromEnv('SUPABASE_CONNECTION_STRING_SESSION')
const url = fromEnv('SUPABASE_URL')
const anon = fromEnv('SUPABASE_ANON_KEY')
const email = fromEnv('INTELLIDEV_DEV_EMAIL')
const password = fromEnv('INTELLIDEV_DEV_PASSWORD')
const devProjectId = fromEnv('INTELLIDEV_PROJECT_ID')

const configured = dsn && url && anon && email && password && devProjectId

if (!configured) {
  describe.skip('auth (skipped: SUPABASE_URL, credentials or project id missing)', () => {
    it('is skipped', () => {})
  })
} else {
  /** A real token, obtained the way the frontend will. */
  async function signIn(): Promise<string> {
    const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon!, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) throw new Error(`sign-in failed: ${res.status}`)
    return ((await res.json()) as { access_token: string }).access_token
  }

  describe('verifying a Supabase token', () => {
    const verifier = new JwtVerifier({ projectUrl: url! })

    it('accepts a real token and reports who it belongs to', async () => {
      const user = await verifier.verify(`Bearer ${await signIn()}`)
      expect(user.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(user.email).toBe(email)
    }, 30_000)

    it('rejects a token with a tampered payload', async () => {
      // The signature covers the payload, so changing `sub` must invalidate it — otherwise
      // anyone could become anyone by editing one base64 segment.
      const [header, payload, signature] = (await signIn()).split('.')
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<
        string,
        unknown
      >
      claims['sub'] = '00000000-0000-0000-0000-000000000000'
      const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
      await expect(verifier.verify(`Bearer ${forged}`)).rejects.toThrow(InvalidToken)
    }, 30_000)

    it('rejects an absent or malformed token', async () => {
      await expect(verifier.verify(undefined)).rejects.toThrow(InvalidToken)
      await expect(verifier.verify('Bearer not-a-jwt')).rejects.toThrow(InvalidToken)
    })

    it('rejects the anon key, which is a token but not a person', async () => {
      // It is signed by the same project, so only the audience and role claims separate it from
      // a user. Accepting it would make every visitor an authenticated one.
      await expect(verifier.verify(`Bearer ${anon}`)).rejects.toThrow(InvalidToken)
    }, 30_000)
  })

  describe('deciding what a user may do', () => {
    async function accessFor(userId: string, projectId: string) {
      const store = new PostgresStore({ connectionString: dsn!, maxConnections: 2 })
      try {
        const checker = store.projectAccess()
        // Only `sub` matters to the helper functions; the rest of a real token is irrelevant to
        // `auth.uid()`.
        const user = { id: userId, claims: { sub: userId } } as AuthenticatedUser
        return await checker.check(user, projectId)
      } finally {
        await store.close()
      }
    }

    async function userId(byEmail: string): Promise<string | undefined> {
      const store = new PostgresStore({ connectionString: dsn!, maxConnections: 1 })
      try {
        const rows = await store.findUserByEmail(byEmail)
        return rows?.id
      } finally {
        await store.close()
      }
    }

    it('gives the owner manage access to their project', async () => {
      const id = await userId(email!)
      expect(id).toBeDefined()
      expect(await accessFor(id!, devProjectId!)).toBe('manage')
    }, 30_000)

    it('gives an outsider nothing, rather than read', async () => {
      const id = await userId('dev-outsider@intellidev.test')
      expect(id).toBeDefined()
      // The fixture exists precisely so this is a real user with no membership, not a
      // made-up uuid that would pass for the wrong reason.
      expect(await accessFor(id!, devProjectId!)).toBe('none')
    }, 30_000)

    it('gives an unknown subject nothing', async () => {
      expect(await accessFor('00000000-0000-0000-0000-0000000000ff', devProjectId!)).toBe('none')
    }, 30_000)
  })
}
