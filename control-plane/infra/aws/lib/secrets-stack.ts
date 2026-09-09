import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface SecretsStackProps extends StackProps {
  readonly environment: EnvironmentConfig
}

/**
 * The master key that credential material is encrypted under.
 *
 * Harness seats and MCP OAuth tokens live in Supabase, which is a database this deployment does
 * not own and cannot audit. Encrypting them under a key AWS holds moves the boundary: the rows
 * are useless without a `kms:Decrypt` call, that call is IAM-controlled, and every one of them
 * lands in CloudTrail. "Was this credential ever read, and by what?" becomes answerable, which
 * it is not for a plaintext column.
 *
 * Its own stack, because its lifecycle is not the others'. Everything else here can be destroyed
 * and rebuilt from source; this key cannot. Delete it and every stored credential is
 * unrecoverable — not corrupted, *unrecoverable* — and every person who connected an integration
 * has to reconnect it. Separating it means `cdk destroy` on the runtime stack cannot take the
 * key with it by accident.
 *
 * One key per environment rather than per project or per tenant. Per-tenant keys would give a
 * tenant its own blast radius, which is a real property — but at $1/month each plus the
 * bookkeeping of which key sealed which row, and with the encryption context already binding a
 * ciphertext to its integration, the isolation that actually matters is there without them. A
 * tenant that needs its own key wants a whole deployment, not a column.
 */
export class SecretsStack extends Stack {
  readonly key: kms.Key

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props)
    const env = props.environment

    this.key = new kms.Key(this, 'CredentialKey', {
      alias: resourceName(env.name, 'credentials'),
      description:
        'Envelope-encrypts harness seats and MCP tokens stored outside AWS. ' +
        'Deleting it makes every stored credential unrecoverable.',
      /**
       * Rotated yearly by AWS.
       *
       * Rotation keeps old key material, so ciphertexts sealed under a previous year still
       * open — nothing has to be re-encrypted, and there is no migration to forget. The
       * `keyArn` recorded on each row is what makes a *manual* re-wrap possible later if it is
       * ever wanted.
       */
      enableKeyRotation: true,
      /**
       * Retained even in dev, and with the full waiting period.
       *
       * `DESTROY` here would mean a stray `cdk destroy` silently orphans every credential in
       * the database, and the symptom arrives later as decryption failures nobody can explain.
       * Thirty days is long enough that a mistake is recoverable by cancelling the deletion.
       */
      removalPolicy: RemovalPolicy.RETAIN,
      pendingWindow: Duration.days(30),
    })

    /**
     * Published to SSM, like every other resource name.
     *
     * The application resolves this at boot and never forms it. That is the same seam the rest
     * of the infrastructure uses: no ARN, no region and no account id appears in application
     * code, so `dev` and a real deployment differ by a parameter rather than by an edit.
     */
    new ssm.StringParameter(this, 'CredentialKeyArn', {
      parameterName: ssmPath(env.name, 'secrets', 'credential-key-arn'),
      stringValue: this.key.keyArn,
      description: 'KMS key that envelope-encrypts credential material held outside AWS',
    })
  }

  /**
   * Lets a principal seal and open credentials.
   *
   * `GenerateDataKey` and `Decrypt` only — not `Encrypt`, which this design never calls, and
   * not any management action. A control plane that could disable or schedule deletion of this
   * key could destroy every credential it holds, and nothing about serving runs requires it.
   */
  grantEnvelopeUse(grantee: { grantPrincipal: import('aws-cdk-lib/aws-iam').IPrincipal }): void {
    this.key.grant(grantee, 'kms:GenerateDataKey', 'kms:Decrypt')
  }
}
