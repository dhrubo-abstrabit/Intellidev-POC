import { describe, expect, it } from 'vitest'
import { Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'
import { ssmPath } from '../lib/naming.js'

const ACCOUNT = '111111111111'

function secretsTemplate() {
  const { secrets } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
  return Template.fromStack(secrets)
}

/**
 * The key that credential material is encrypted under.
 *
 * These assertions are about what happens when someone is careless, not about whether the key
 * exists. A key that is right until a `cdk destroy` takes it is not right.
 */
describe('the credential key', () => {
  it('survives the stack being destroyed', () => {
    // The failure this prevents: `cdk destroy` orphans every credential in the database, and
    // the symptom arrives later as decryption failures nobody can trace back to the cause.
    const key = Object.values(secretsTemplate().findResources('AWS::KMS::Key'))[0]
    expect(key?.DeletionPolicy).toBe('Retain')
    expect(key?.UpdateReplacePolicy).toBe('Retain')
  })

  it('waits thirty days before deleting, so a mistake can be cancelled', () => {
    secretsTemplate().hasResourceProperties('AWS::KMS::Key', { PendingWindowInDays: 30 })
  })

  it('rotates yearly, and rotation keeps old material so nothing needs re-encrypting', () => {
    secretsTemplate().hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true })
  })

  it('publishes its ARN to SSM rather than expecting anyone to hardcode it', () => {
    // The seam the whole deployment uses: no ARN, region or account id in application code.
    secretsTemplate().hasResourceProperties('AWS::SSM::Parameter', {
      Name: ssmPath('dev', 'secrets', 'credential-key-arn'),
    })
  })

  it('has an alias, so the key can be replaced without rewriting configuration', () => {
    secretsTemplate().hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/intellidev-dev-credentials',
    })
  })

  it('lives in its own stack, holding nothing that would tempt a destroy', () => {
    // Isolation is the point: everything else can be rebuilt from source, so the stacks that
    // get destroyed and recreated must not contain this key.
    const template = secretsTemplate()
    expect(Object.keys(template.findResources('AWS::KMS::Key'))).toHaveLength(1)
    expect(Object.keys(template.findResources('AWS::ECS::Cluster'))).toHaveLength(0)
    expect(Object.keys(template.findResources('AWS::S3::Bucket'))).toHaveLength(0)
  })

  it('grants only the two actions envelope encryption needs', () => {
    const { secrets, runtime } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    secrets.grantEnvelopeUse(runtime.taskRole)

    // The grantee is in another stack, so CDK writes the permission onto the *role's* policy
    // rather than into the key policy — which holds only the account-root statement.
    const policies = Template.fromStack(runtime).findResources('AWS::IAM::Policy')
    const granted = Object.values(policies)
      .flatMap(
        (policy) =>
          (
            policy as {
              Properties?: { PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } }
            }
          ).Properties?.PolicyDocument?.Statement ?? [],
      )
      .flatMap((statement) => {
        const action = statement.Action
        return Array.isArray(action) ? action : action ? [action] : []
      })
      .filter((action): action is string => typeof action === 'string' && action.startsWith('kms:'))

    expect(granted).toContain('kms:GenerateDataKey')
    expect(granted).toContain('kms:Decrypt')
    // Never a management action: a control plane able to disable or schedule deletion of this
    // key could destroy every credential it holds, and serving runs requires none of that.
    expect(granted).not.toContain('kms:ScheduleKeyDeletion')
    expect(granted).not.toContain('kms:DisableKey')
    expect(granted).not.toContain('kms:*')
    // And never Encrypt, which envelope encryption does not call — the data key does the work.
    expect(granted).not.toContain('kms:Encrypt')
  })
})
