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

  /**
   * Selected by name, not by position.
   *
   * There are two buckets in this stack now, and `Object.values(...)[0]` was picking one by
   * whichever logical id sorted first — which passed by luck and would have started asserting
   * the wrong bucket's rules the moment a third was added.
   */
  function bucketNamed(t: Template, fragment: string): Record<string, unknown> {
    const found = Object.values(t.findResources('AWS::S3::Bucket')).find((b) =>
      JSON.stringify((b as Record<string, never>)['Properties']?.['BucketName']).includes(fragment),
    )
    if (!found) throw new Error(`no bucket whose name contains ${fragment}`)
    return (found as Record<string, Record<string, unknown>>)['Properties']!
  }

  it('expires run specs and aborts abandoned uploads', () => {
    const rules = JSON.stringify(
      bucketNamed(artifacts(), 'dev-artifacts')['LifecycleConfiguration'],
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

  describe('the artifact content bucket', () => {
    /**
     * A second bucket, because two of its properties are the *opposite* of the one above.
     *
     * That bucket holds run specs and bundles: reproducible, expiring, and reachable by
     * presigned URL. This one holds what a stage drew — a diagram, a note, a screenshot — which
     * is the output rather than the plumbing. These tests pin the two differences that matter,
     * because both failures are silent.
     */
    it('is retained when the stack is destroyed', () => {
      /**
       * The reason this is a separate bucket at all. The artifacts bucket is `DESTROY` with
       * `autoDeleteObjects`, which is right for a cache of reproducible objects and would take
       * every artifact in the project with it.
       */
      const t = artifacts()
      const buckets = t.findResources('AWS::S3::Bucket')
      const content = Object.entries(buckets).find(([, b]) =>
        JSON.stringify((b as Record<string, never>)['Properties']?.['BucketName']).includes(
          'artifact-content',
        ),
      )
      expect(content).toBeDefined()
      expect(content?.[1]['DeletionPolicy']).toBe('Retain')
      expect(content?.[1]['UpdateReplacePolicy']).toBe('Retain')
    })

    it('has no rule that can expire a live artifact', () => {
      /**
       * Only non-current versions expire. A prefix-scoped expiration on the shared bucket would
       * have worked until somebody widened it, and the failure mode is data loss noticed weeks
       * later — which is the whole argument for the split.
       */
      const rules = bucketNamed(artifacts(), 'artifact-content')['LifecycleConfiguration']
      const json = JSON.stringify(rules)
      expect(json).toContain('NoncurrentVersionExpiration')
      // No plain `ExpirationInDays`, which would delete the object itself.
      expect(json).not.toContain('ExpirationInDays')
      expect(json).toContain('AbortIncompleteMultipartUpload')
    })

    it('versions objects, so an overwrite or a delete is recoverable', () => {
      // Saving over a name replaces it and deleting is a button in the UI; neither should be
      // the last word on something a run spent minutes producing.
      expect(bucketNamed(artifacts(), 'artifact-content')['VersioningConfiguration']).toEqual({
        Status: 'Enabled',
      })
    })

    it('is private and TLS-only, like the other one', () => {
      expect(
        bucketNamed(artifacts(), 'artifact-content')['PublicAccessBlockConfiguration'],
      ).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      })
    })

    it('is reachable by the control plane and by nothing else', () => {
      /**
       * The control plane both writes (a stage sends bytes over its run's channel) and reads (a
       * person opens one, and the bytes are proxied). No other principal needs a grant, and in
       * particular the run task role has none — which is what stops one run reaching another
       * project's artifacts by guessing a key.
       */
      const { controlPlane, runtime } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
      const plane = JSON.stringify(
        Template.fromStack(controlPlane).findResources('AWS::IAM::Policy'),
      )
      /**
       * Matched on the export name, not the bucket name.
       *
       * A cross-stack grant references the bucket by `Fn::ImportValue`, and the export is named
       * after the construct's logical id — so `ArtifactContent` is what appears, and asserting
       * on `artifact-content` looked for a string that is never in the policy.
       */
      expect(plane).toContain('ArtifactContent')
      // Scoped to the prefix the store writes under, not the whole bucket.
      expect(plane).toContain('/artifacts/*')

      const runs = JSON.stringify(Template.fromStack(runtime).findResources('AWS::IAM::Policy'))
      expect(runs).not.toContain('ArtifactContent')
      expect(runs).not.toContain('/artifacts/*')
    })
  })
})
