import { z } from 'zod'
import { StageId } from './ids.js'

/**
 * Project environment and secrets.
 *
 * THE UNCOMFORTABLE TRUTH THIS DESIGN IS BUILT AROUND:
 *
 * A test suite reads `process.env`. There is no way to give `pnpm test` a database
 * URL through a unix socket. So any secret a run's tests need is, by construction,
 * reachable by the model-authored code running in that container — it can read the
 * env, read a rendered `.env`, or simply write a test that prints one.
 *
 * Hiding is therefore not the control. **Scoping is.** The rule this schema exists to
 * enforce is that a run only ever receives throwaway, test-scoped credentials, and
 * the egress allowlist is what stops even those from going anywhere useful.
 *
 * Three tiers, deliberately separate:
 *
 *  1. `env`     — plaintext, versioned in the manifest, safe to read in a PR diff.
 *  2. `secrets` — names plus a *reference* to a vault entry. Values never appear in
 *                 the manifest, the bundle, git, or the event log.
 *  3. Broker credentials — GitHub tokens and seat material, which are never env vars
 *                 at all because nothing except the adapter needs them.
 */

/** Where a secret's value actually lives. Never the value itself. */
export const SecretSource = z.enum(['aws-secrets', 'aws-ssm', 'control-plane'])
export type SecretSource = z.infer<typeof SecretSource>

export const SecretRef = z
  .object({
    /** The environment variable name the project expects, e.g. `DATABASE_URL`. */
    name: z
      .string()
      .min(1)
      .regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an UPPER_SNAKE_CASE env var name'),
    source: SecretSource,
    /** ARN, parameter path, or control-plane key. Resolved at dispatch. */
    ref: z.string().min(1),
    /** Empty means every stage. Design rarely needs database credentials. */
    stages: z.array(StageId).default([]),
    /**
     * Asserts this is a sandbox or test credential, not a production one. Dispatch
     * refuses a project whose secrets are not all attested, because the container
     * cannot keep a secret from the code running inside it.
     */
    sandboxAttested: z.boolean().default(false),
    description: z.string().optional(),
  })
  .strict()
export type SecretRef = z.infer<typeof SecretRef>

export const EnvSpec = z
  .object({
    /** Plaintext, versioned, visible in the manifest. Non-secret only. */
    vars: z.record(z.string()).default({}),
    secrets: z.array(SecretRef).default([]),
    /**
     * Render the resolved set to a dotenv file in the worktree, because most repos
     * expect one. It is gitignored by the adapter before any commit.
     */
    dotenvPath: z.string().nullable().default('.env'),
  })
  .default({})
export type EnvSpec = z.infer<typeof EnvSpec>

/** Secrets in scope for a stage. Empty `stages` means all of them. */
export function secretsForStage(env: EnvSpec, stage: StageId): SecretRef[] {
  return env.secrets.filter((s) => s.stages.length === 0 || s.stages.includes(stage))
}

/**
 * Secrets that have not been attested as sandbox-scoped.
 *
 * Dispatch blocks on a non-empty result. This is the one place the design refuses to
 * be convenient: an un-attested secret is assumed to be production, and production
 * credentials do not enter a run container.
 */
export function unattestedSecrets(env: EnvSpec): SecretRef[] {
  return env.secrets.filter((s) => !s.sandboxAttested)
}

/** Env var names a project must not set, because the adapter owns them. */
export const RESERVED_ENV = new Set([
  'PATH',
  'HOME',
  'RUN_ID',
  'RUN_TOKEN',
  'CONTROL_PLANE_URL',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENCODE_SERVER_PASSWORD',
])

/**
 * Names that collide with something the adapter owns.
 *
 * A project quietly overriding `GITHUB_TOKEN` would break the credential helper in a
 * way that looks like a git failure three stages later.
 */
export function reservedCollisions(env: EnvSpec): string[] {
  const names = [...Object.keys(env.vars), ...env.secrets.map((s) => s.name)]
  return names.filter((name) => RESERVED_ENV.has(name)).sort()
}
