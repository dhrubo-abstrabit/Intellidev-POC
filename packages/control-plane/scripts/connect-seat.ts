#!/usr/bin/env node
/**
 * Connects a harness seat from the shell.
 *
 * The built-in UI cannot do this any more: every `/api/*` route requires a Supabase token and
 * that page has no login screen, because it was written before authentication existed. The real
 * frontend lives in another repository and will have its own; until it arrives, this is how a
 * seat gets in.
 *
 * Writes straight to the database, sealed with whichever cipher is configured — so a seat
 * connected here is one the hosted control plane can open, and one connected under the local
 * passphrase is not. That asymmetry is deliberate: a ciphertext records which key sealed it, and
 * opening it with the wrong one fails loudly rather than returning something plausible.
 *
 *   pnpm seat:connect claude-code --token "$(claude setup-token)"
 *   pnpm seat:connect codex --file ~/.codex/auth.json
 *   pnpm seat:connect --list
 */
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { HarnessId } from '@intellidev/shared'
import { PostgresStore } from '../src/store/postgres.js'
import { LocalSecretCipher } from '../src/secrets/cipher.js'
import { KmsSecretCipher } from '../src/secrets/kms-cipher.js'
import { recipeFor } from '../src/harness/accounts.js'
import type { SecretCipher } from '../src/secrets/cipher.js'

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

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const dsn = fromEnv('SUPABASE_CONNECTION_STRING_SESSION')
const projectId = fromEnv('INTELLIDEV_PROJECT_ID')
if (!dsn) throw new Error('SUPABASE_CONNECTION_STRING_SESSION is not set')
if (!projectId) throw new Error('INTELLIDEV_PROJECT_ID is not set — run `pnpm dev:seed`')

/**
 * The same choice `main.ts` makes, for the same reason.
 *
 * Sealing with a different cipher than the reader uses produces a seat that looks connected and
 * fails at the first model call — which costs a whole container to discover.
 */
const keyArn = fromEnv('INTELLIDEV_CREDENTIAL_KEY_ARN')
const cipher: SecretCipher = keyArn
  ? new KmsSecretCipher(keyArn, {
      clientConfig: { region: fromEnv('AWS_REGION') ?? 'ap-south-1' },
    })
  : new LocalSecretCipher(fromEnv('INTELLIDEV_SECRET_PASSPHRASE') ?? 'intellidev-local-development')

const store = new PostgresStore({ connectionString: dsn, maxConnections: 2 })

try {
  const project = await store.findProject(projectId)
  if (!project) throw new Error(`project ${projectId} is not in this database`)
  const scope = { clientSpaceId: project.clientSpaceId }
  const seats = store.seats(cipher)

  console.log(`\n  space   ${scope.clientSpaceId}`)
  console.log(
    `  sealing ${keyArn ? `with KMS (${keyArn.split('/').pop()})` : 'with a local passphrase'}\n`,
  )

  const positional = process.argv.slice(2).filter((a, i, all) => {
    if (a.startsWith('--')) return false
    // Skip a value that belongs to the flag before it.
    return !(i > 0 && all[i - 1]?.startsWith('--'))
  })
  const command = positional[0]

  if (!command || command === '--list' || process.argv.includes('--list')) {
    for (const seat of await seats.list(scope)) {
      console.log(`  ${seat.harness}  ${seat.files.join(', ') || seat.envVars.join(', ')}`)
      console.log(`    connected ${seat.connectedAt}  from ${seat.importedFrom ?? 'unknown'}`)
    }
    if ((await seats.list(scope)).length === 0) console.log('  no harness connected')
    console.log(
      [
        '',
        '  pnpm seat:connect claude-code --token "$(claude setup-token)"',
        '  pnpm seat:connect codex --file ~/.codex/auth.json',
        '  pnpm seat:remove claude-code',
        '',
      ].join('\n'),
    )
  } else if (process.argv.includes('--remove')) {
    const harness = HarnessId.parse(command)
    console.log(
      (await seats.remove(scope, harness))
        ? `  removed ${harness}`
        : `  ${harness} was not connected`,
    )
  } else {
    const harness = HarnessId.parse(command)
    const recipe = recipeFor(harness)
    if (!recipe) throw new Error(`no auth recipe for ${harness}`)

    const token = flag('token')
    const file = flag('file')

    /**
     * Two shapes, because the harnesses differ: some read a token from the environment, others
     * read a credential file written by their own login. The recipe knows which, so a caller
     * does not have to.
     */
    const account =
      recipe.kind === 'env'
        ? (() => {
            if (!token) {
              throw new Error(
                `${harness} authenticates by token. Run \`${recipe.command}\` and pass it:\n` +
                  `  pnpm seat:connect ${harness} --token "<the token>"`,
              )
            }
            return {
              harness,
              label: harness,
              env: { [recipe.envVar!]: token },
              connectedAt: new Date().toISOString(),
              importedFrom: recipe.command ?? 'cli',
            }
          })()
        : await (async () => {
            const path = file ?? recipe.hostPath!
            const contents = await readFile(path.replace(/^~/, process.env['HOME'] ?? '~'), 'utf8')
            // Parsed to fail here rather than inside a container: a half-written credential file
            // is a real state, and the error is far clearer now than at the first model call.
            JSON.parse(contents)
            return {
              harness,
              label: harness,
              files: [{ path: recipe.homePath!, contents }],
              connectedAt: new Date().toISOString(),
              importedFrom: path,
            }
          })()

    await seats.connect(scope, account)

    // Read it back through the same path a run uses, so "connected" means the material actually
    // decrypts rather than merely that a row was written.
    const material = await seats.material(scope, harness)
    const ok = material && Object.keys(material).length > 0
    console.log(
      `  connected ${harness}  ${ok ? '(material verified)' : '(WARNING: empty material)'}`,
    )
    console.log('\n  the hosted control plane picks this up on the next run\n')
  }
} finally {
  await store.close()
}
