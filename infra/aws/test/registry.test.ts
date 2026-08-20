import { describe, expect, it } from 'vitest'
import { Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'
import { ENVIRONMENTS } from '../lib/config.js'
import { resourceName, ssmPath } from '../lib/naming.js'

const ACCOUNT = '111111111111'

function registry(): Template {
  const { registry } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
  return Template.fromStack(registry)
}

describe('the golden image registry', () => {
  it('is one repository per environment, not per project', () => {
    // A project is a manifest fetched at boot, not a baked layer. Per-project repositories
    // would quietly undo that and make onboarding an image build again.
    const t = registry()
    t.resourceCountIs('AWS::ECR::Repository', 1)
    t.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: resourceName('dev', 'runner'),
    })
  })

  it('expires untagged images and caps tagged ones', () => {
    const repos = registry().findResources('AWS::ECR::Repository')
    const policy = JSON.parse(
      String(Object.values(repos)[0]?.['Properties']?.['LifecyclePolicy']?.['LifecyclePolicyText']),
    )
    const rules = policy.rules as Array<Record<string, never>>
    expect(rules).toHaveLength(2)
    // Untagged images are rebuild garbage and would otherwise accumulate storage cost.
    expect(JSON.stringify(rules)).toContain('untagged')
    // Rollback needs somewhere to go, so tagged images are capped rather than expired.
    expect(JSON.stringify(rules)).toContain('imageCountMoreThan')
  })

  it('scans on push, since the image vendors three harnesses', () => {
    registry().hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: { ScanOnPush: true },
    })
  })

  it('empties on delete, so cdk destroy stays clean', () => {
    // Every phase so far has been held to leaving nothing behind. An ECR repository with
    // images in it would block the stack delete.
    const repos = registry().findResources('AWS::ECR::Repository')
    expect(Object.values(repos)[0]?.['DeletionPolicy']).toBe('Delete')
    expect(JSON.stringify(Object.values(repos)[0])).toContain('EmptyOnDelete')
  })

  it('publishes the repository and architecture, but never the digest', () => {
    const t = registry()
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: ssmPath('dev', 'runner', 'repository-uri'),
    })
    t.hasResourceProperties('AWS::SSM::Parameter', {
      Name: ssmPath('dev', 'runner', 'architecture'),
      Value: ENVIRONMENTS.dev.architecture,
    })
    // CDK cannot know a digest at synth time; a parameter it owned would be reset to a
    // stale value on every deploy. push-image.sh writes it instead.
    const params = JSON.stringify(t.findResources('AWS::SSM::Parameter'))
    expect(params).not.toContain('image-digest')
  })

  it('targets arm64, because the image is arm64 and Graviton is cheaper', () => {
    expect(ENVIRONMENTS.dev.architecture).toBe('ARM64')
    expect(ENVIRONMENTS.prod.architecture).toBe('ARM64')
  })
})

describe('the artifacts bucket', () => {
  function artifacts(): Template {
    const { artifacts } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    return Template.fromStack(artifacts)
  }

  it('is private and TLS-only', () => {
    const t = artifacts()
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
    // A presigned URL is a bearer token for one object; an unencrypted-transport path to
    // the same object would undo the point.
    expect(JSON.stringify(t.findResources('AWS::S3::BucketPolicy'))).toContain(
      'aws:SecureTransport',
    )
  })

  it('versions objects, so a run in flight cannot have its bundle moved', () => {
    artifacts().hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    })
  })

  it('expires run specs and aborts abandoned uploads', () => {
    const buckets = artifacts().findResources('AWS::S3::Bucket')
    const rules = JSON.stringify(
      Object.values(buckets)[0]?.['Properties']?.['LifecycleConfiguration'],
    )
    expect(rules).toContain('runs/')
    // An abandoned multipart upload bills storage forever and never appears in the
    // console's object listing.
    expect(rules).toContain('AbortIncompleteMultipartUpload')
  })

  it('grants the run task role nothing on it', () => {
    // The security argument for this whole stack: one task definition serves every run, so
    // any S3 grant on the task role is a grant over every other run's spec.
    const { runtime } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    const policies = JSON.stringify(Template.fromStack(runtime).findResources('AWS::IAM::Policy'))
    expect(policies).not.toContain('artifacts')
    expect(policies).not.toContain('s3:GetObject')
  })
})
