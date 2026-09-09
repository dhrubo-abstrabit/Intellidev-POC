import { RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface AppSecretsStackProps extends StackProps {
  readonly environment: EnvironmentConfig
}

/**
 * The handful of secrets a hosted control plane needs before it can read anything else.
 *
 * These are the *roots*, and the reason they are here rather than in the database with
 * everything else: the connection string obviously cannot live in the database it opens, and the
 * GitHub App private key is what mints access to every repository the App is installed on — a
 * Supabase dump must not contain it.
 *
 * Three secrets at ~$0.40 each. That price is exactly why the per-integration credentials went
 * to KMS-in-Postgres instead: one secret per project per integration does not survive it, and a
 * secret cannot be updated in the same transaction as the row pointing at it.
 *
 * **Created empty.** CloudFormation templates are not a place to put secret values — they are
 * readable to anyone with `cloudformation:GetTemplate`, and they end up in `cdk.out` on
 * whichever laptop ran the deploy. The values are put in afterwards, once, by a person or a
 * script; `pnpm secrets:put` does it.
 */
export class AppSecretsStack extends Stack {
  readonly githubAppKey: secretsmanager.Secret
  readonly databaseUrl: secretsmanager.Secret
  readonly supabaseServiceKey: secretsmanager.Secret

  constructor(scope: Construct, id: string, props: AppSecretsStackProps) {
    super(scope, id, props)
    const env = props.environment

    const make = (logicalId: string, name: string, description: string) =>
      new secretsmanager.Secret(this, logicalId, {
        secretName: resourceName(env.name, name),
        description,
        /**
         * Retained, like the KMS key and for the same reason.
         *
         * A `cdk destroy` that took the GitHub App key with it would mean re-uploading a private
         * key someone has to find again; taking the connection string would mean the same for a
         * password only the dashboard can reissue. Neither is recoverable from source, which is
         * the test for whether a resource should be destroyable with its stack.
         */
        removalPolicy: RemovalPolicy.RETAIN,
      })

    this.githubAppKey = make(
      'GitHubAppKey',
      'github-app-key',
      'PEM private key for the Intellidev GitHub App. Mints installation tokens; never leaves the control plane.',
    )
    this.databaseUrl = make(
      'DatabaseUrl',
      'database-url',
      'Supabase session-mode pooler connection string (port 5432 — transaction mode loses LISTEN/NOTIFY).',
    )
    this.supabaseServiceKey = make(
      'SupabaseServiceKey',
      'supabase-service-key',
      'Supabase service role key. Used only for admin operations, never for request-path queries.',
    )

    /**
     * ARNs to SSM, like every other resource name.
     *
     * The task definition needs them at synth time and the application never forms one. Only the
     * ARNs are published — an SSM parameter is not a secret store, and putting a value here
     * would undo the entire point of the stack.
     */
    for (const [key, secret] of [
      ['github-app-key', this.githubAppKey],
      ['database-url', this.databaseUrl],
      ['supabase-service-key', this.supabaseServiceKey],
    ] as const) {
      new ssm.StringParameter(this, `${key}-arn`, {
        parameterName: ssmPath(env.name, 'secrets', `${key}-arn`),
        stringValue: secret.secretArn,
        description: `ARN of the ${key} secret`,
      })
    }
  }
}
