import { createHash, randomBytes } from 'node:crypto'
import { decryptWithDataKey, encryptWithDataKey, KEY_BYTES } from './envelope.js'

/**
 * Envelope encryption for credential material.
 *
 * Two things are stored per secret: the ciphertext, and the data key that encrypted it, itself
 * encrypted by a master key held elsewhere. Reading a secret therefore takes two steps — unwrap
 * the data key, then decrypt — and the first of those is the one that can be taken away. Revoke
 * access to the master key and every ciphertext in the database becomes inert, without touching
 * the database.
 *
 * **Why not just rely on the database being encrypted at rest.** At-rest encryption protects
 * against someone taking the disk. It does nothing about a database dump, a leaked connection
 * string, an over-broad `select`, or SQL injection — in all of which the rows come back
 * decrypted, because the database is doing its job. Envelope encryption moves the boundary to a
 * key the database never has.
 *
 * **Why not Secrets Manager per credential.** It bills per secret per month, which does not
 * survive one row per project per integration, and it cannot be updated in the same transaction
 * as the row pointing at it — which matters, because rotating an OAuth refresh token is exactly
 * a read-modify-write that must not half-happen.
 *
 * **AAD binds a ciphertext to its row.** Every seal carries an encryption context, and opening
 * requires the same one. A ciphertext copied from one integration's row into another's fails to
 * decrypt rather than quietly yielding someone else's credential — the mistake that would
 * otherwise be invisible.
 */

export interface SealedSecret {
  /** AES-256-GCM ciphertext, with the IV and auth tag packed in. Base64. */
  readonly ciphertext: string
  /** The data key, encrypted by the master key. Base64. */
  readonly wrappedKey: string
  /** Which master key wrapped it, so a rotation can find what still needs re-wrapping. */
  readonly keyArn: string
}

/**
 * What a ciphertext is bound to.
 *
 * Free-form rather than a fixed shape because the useful binding differs by secret: an
 * integration's credential binds to its integration id, and something project-wide would bind to
 * the project. What matters is that the same context is present on open.
 */
export type EncryptionContext = Readonly<Record<string, string>>

export interface SecretCipher {
  seal(plaintext: string, context: EncryptionContext): Promise<SealedSecret>
  open(sealed: SealedSecret, context: EncryptionContext): Promise<string>
}

/** Raised when a ciphertext cannot be opened. Deliberately says nothing about why. */
export class SecretOpenFailed extends Error {
  constructor(detail: string) {
    // No plaintext, no key material, no context values — an error string is the one place
    // secrets leak by accident, and "which byte differed" helps an attacker more than a
    // developer.
    super(`could not open the sealed secret: ${detail}`)
  }
}

/**
 * The local implementation, for development and tests.
 *
 * A real master key, held in this process, rather than a no-op. Storing plaintext locally and
 * ciphertext in production would mean the dev loop never exercised the path that matters: a
 * context mismatch, a corrupted ciphertext and a rotated key would all be discovered in
 * production for the first time.
 *
 * The master key derives from a passphrase so a developer's stored credentials survive a
 * restart. That is a development convenience and nothing more — it offers no protection against
 * anyone who can read the machine, which is why production uses KMS.
 */
export class LocalSecretCipher implements SecretCipher {
  private readonly masterKey: Buffer
  readonly keyArn: string

  constructor(passphrase = 'intellidev-local-development') {
    this.masterKey = createHash('sha256').update(passphrase).digest()
    // Shaped like an ARN so nothing downstream has to special-case it, and unmistakable so a
    // local ciphertext is never taken for a production one.
    this.keyArn = 'local:dev-master-key'
  }

  async seal(plaintext: string, context: EncryptionContext): Promise<SealedSecret> {
    const dataKey = randomBytes(KEY_BYTES)
    return {
      ciphertext: encryptWithDataKey(dataKey, plaintext, context),
      // The data key is itself sealed under the same context, so a wrapped key lifted from
      // another row is as useless as the ciphertext it came with.
      wrappedKey: encryptWithDataKey(this.masterKey, dataKey.toString('base64'), context),
      keyArn: this.keyArn,
    }
  }

  async open(sealed: SealedSecret, context: EncryptionContext): Promise<string> {
    if (sealed.keyArn !== this.keyArn) {
      throw new SecretOpenFailed(`sealed by ${sealed.keyArn}, which this cipher cannot unwrap`)
    }
    const dataKey = Buffer.from(
      decryptWithDataKey(this.masterKey, sealed.wrappedKey, context),
      'base64',
    )
    if (dataKey.length !== KEY_BYTES) throw new SecretOpenFailed('unwrapped key is the wrong size')
    return decryptWithDataKey(dataKey, sealed.ciphertext, context)
  }
}
