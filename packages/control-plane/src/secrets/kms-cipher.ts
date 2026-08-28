import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type KMSClientConfig,
} from '@aws-sdk/client-kms'
import {
  SecretOpenFailed,
  type EncryptionContext,
  type SealedSecret,
  type SecretCipher,
} from './cipher.js'
import { decryptWithDataKey, encryptWithDataKey } from './envelope.js'

/**
 * Envelope encryption backed by KMS.
 *
 * The master key never leaves KMS: `GenerateDataKey` returns a fresh data key twice over — in
 * the clear for this process to use immediately, and wrapped for storage — and `Decrypt` is the
 * only way to get the clear one back. So the database holds nothing that can be decrypted
 * without an IAM call, and every one of those calls is recorded in CloudTrail.
 *
 * That audit trail is most of the point. "Was this credential ever read, and by what?" is
 * unanswerable when a secret sits in a column, and it is exactly the question worth being able
 * to answer.
 *
 * The plaintext data key is used and dropped. It is never stored, never logged, and not cached
 * — a cache would trade the audit trail for a round trip, and the round trip is ~10 ms against
 * a run that takes minutes.
 */
export class KmsSecretCipher implements SecretCipher {
  private readonly kms: Pick<KMSClient, 'send'>

  constructor(
    /** The customer master key. An ARN or alias; the caller resolves it, this never forms it. */
    readonly keyArn: string,
    options: { client?: Pick<KMSClient, 'send'>; clientConfig?: KMSClientConfig } = {},
  ) {
    this.kms = options.client ?? new KMSClient(options.clientConfig ?? {})
  }

  async seal(plaintext: string, context: EncryptionContext): Promise<SealedSecret> {
    const generated = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyArn,
        KeySpec: 'AES_256',
        // KMS binds the context into the wrapped key: decrypting later without exactly this
        // context fails, which is what stops a wrapped key being reused on another row.
        EncryptionContext: { ...context },
      }),
    )
    if (!generated.Plaintext || !generated.CiphertextBlob) {
      throw new Error('KMS returned a data key with no plaintext or no ciphertext blob')
    }

    const dataKey = Buffer.from(generated.Plaintext)
    try {
      return {
        ciphertext: encryptWithDataKey(dataKey, plaintext, context),
        wrappedKey: Buffer.from(generated.CiphertextBlob).toString('base64'),
        // What KMS actually used, not what was asked for: an alias resolves to a key id, and
        // recording the alias would make a rotation unable to tell what still needs re-wrapping.
        keyArn: generated.KeyId ?? this.keyArn,
      }
    } finally {
      // Overwritten rather than merely dropped. It is a short-lived buffer either way, but a
      // heap dump taken in between is exactly the case this defends against.
      dataKey.fill(0)
    }
  }

  async open(sealed: SealedSecret, context: EncryptionContext): Promise<string> {
    let decrypted
    try {
      decrypted = await this.kms.send(
        new DecryptCommand({
          CiphertextBlob: Buffer.from(sealed.wrappedKey, 'base64'),
          EncryptionContext: { ...context },
          // Named explicitly so a ciphertext cannot steer which key is used to open it.
          KeyId: sealed.keyArn,
        }),
      )
    } catch (error) {
      // KMS refuses on a context mismatch as well as on a wrong key, and the distinction is not
      // the caller's business — either way this ciphertext is not theirs to open.
      throw new SecretOpenFailed(
        error instanceof Error ? error.name : 'KMS refused to unwrap the data key',
      )
    }
    if (!decrypted.Plaintext) throw new SecretOpenFailed('KMS returned no data key')

    const dataKey = Buffer.from(decrypted.Plaintext)
    try {
      return decryptWithDataKey(dataKey, sealed.ciphertext, context)
    } finally {
      dataKey.fill(0)
    }
  }
}
