import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface ArtifactsStackProps extends StackProps {
  readonly environment: EnvironmentConfig
}

/**
 * Where run specs and project bundles live, replacing the bind mounts.
 *
 * **Nothing here is readable by the run's task role.** That is deliberate and it is the
 * whole security argument for this stack: one task definition serves every run, so a task
 * role holding `s3:GetObject` on `runs/*` would let any run read any other run's spec —
 * its manifest, its task brief, its seat pool. Instead the control plane presigns a URL
 * for exactly the one object a run needs, and the run holds no S3 permission at all.
 *
 * Layout, all scoped by project so two projects can never collide:
 *
 *   bundles/<projectId>/<digest>.tar.gz   immutable, content-addressed
 *   runs/<projectId>/<runId>/spec.json    one per run, expires
 */
export class ArtifactsStack extends Stack {
  readonly bucket: s3.Bucket

  constructor(scope: Construct, id: string, props: ArtifactsStackProps) {
    super(scope, id, props)
    const env = props.environment

    this.bucket = new s3.Bucket(this, 'Artifacts', {
      bucketName: resourceName(env.name, 'artifacts', this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // A presigned URL is a bearer token for one object. Versioning means a bundle that
      // was overwritten can still be fetched by digest, so a run in flight cannot have the
      // ground move under it.
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'expire-run-specs',
          prefix: 'runs/',
          // Long enough to debug a failure from last month, short enough that specs do not
          // accumulate. Specs are reproducible from the manifest version they pin.
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(7),
        },
        {
          id: 'expire-old-bundle-versions',
          prefix: 'bundles/',
          // Bundles are content-addressed, so a non-current version is by definition an
          // overwrite of identical content. Keeping one week covers a run in flight.
          noncurrentVersionExpiration: Duration.days(7),
        },
        {
          id: 'abort-incomplete-uploads',
          // An abandoned multipart upload bills storage indefinitely and is invisible in
          // the console's object list.
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    })

    new ssm.StringParameter(this, 'ArtifactBucketParam', {
      parameterName: ssmPath(env.name, 'artifacts', 'bucket'),
      stringValue: this.bucket.bucketName,
      description: 'Run specs and project bundles. Runs reach it only by presigned URL.',
    })
  }
}
