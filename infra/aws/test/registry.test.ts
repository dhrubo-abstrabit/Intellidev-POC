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
    //
    // Asserted on the *names* rather than the count, which is what the rule actually means.
    // Counting broke the moment the control plane got its own repository — a second image, not
    // a second project — and a count cannot tell those apart.
    const names = Object.values(registry().findResources('AWS::ECR::Repository')).map(
      (r) => r['Properties']?.['RepositoryName'] as string,
    )
    expect(new Set(names)).toEqual(
      new Set([resourceName('dev', 'runner'), resourceName('dev', 'control-plane')]),
    )
    // Nothing project-scoped: a name carrying a project id is the shape this forbids.
    for (const name of names) expect(name).toBe(name.toLowerCase())
    expect(names.some((n) => /[0-9a-f]{8}-[0-9a-f]{4}/.test(n))).toBe(false)
  })

  it('expires untagged images and caps tagged ones', () => {
    const repos = registry().findResources('AWS::ECR::Repository')
    // Every repository, not just the first: they are separate precisely so one image's pushes
    // cannot expire another's, and a rule that only holds for one of them is the bug.
    for (const repo of Object.values(repos)) {
      const policy = JSON.parse(
        String(repo['Properties']?.['LifecyclePolicy']?.['LifecyclePolicyText']),
      )
      const rules = policy.rules as Array<Record<string, never>>
      expect(rules).toHaveLength(2)
      // Untagged images are rebuild garbage and would otherwise accumulate storage cost.
      expect(JSON.stringify(rules)).toContain('untagged')
      // Rollback needs somewhere to go, so tagged images are capped rather than expired.
      expect(JSON.stringify(rules)).toContain('imageCountMoreThan')
    }
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
