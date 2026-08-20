import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface SmokeStackProps extends StackProps {
  readonly environment: EnvironmentConfig
  readonly vpc: ec2.IVpc
  readonly securityGroup: ec2.ISecurityGroup
}

/**
 * The egress proof for A2, kept as permanent infrastructure rather than a throwaway.
 *
 * A2's claim — "a task in this VPC reaches the internet and S3 with no NAT gateway" — is
 * not something a template can demonstrate. It needs a container that actually resolves
 * DNS, completes a TLS handshake, clones over HTTPS and round-trips an S3 object. Keeping
 * the task definition deployed means that claim is re-checkable in one command any time
 * the network changes, which is worth more than the zero dollars it costs to leave here
 * (task definitions, clusters and log groups are all free when nothing is running).
 *
 * The ECS cluster lives here because it is the first thing that needs one; C1 registers
 * the real run task definition against this same cluster rather than creating a second.
 */
export class SmokeStack extends Stack {
  readonly cluster: ecs.Cluster
  readonly bucket: s3.Bucket

  constructor(scope: Construct, id: string, props: SmokeStackProps) {
    super(scope, id, props)
    const env = props.environment

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: resourceName(env.name, 'runners'),
      // Container Insights bills per metric; E2 decides observability deliberately.
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    })

    /**
     * A bucket purely so the smoke task has something real to read and write.
     *
     * The one-day expiry rule matters: if the task dies between PUT and DELETE, a stray
     * object would otherwise block `cdk destroy` on a non-empty bucket. This self-heals
     * instead of needing an auto-delete custom resource and the Lambda that comes with it.
     */
    this.bucket = new s3.Bucket(this, 'SmokeBucket', {
      bucketName: resourceName(env.name, 'egress-smoke', this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ expiration: Duration.days(1) }],
    })

    const logGroup = new logs.LogGroup(this, 'SmokeLogs', {
      logGroupName: `/intellidev/${env.name}/egress-smoke`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    const task = new ecs.FargateTaskDefinition(this, 'SmokeTask', {
      family: resourceName(env.name, 'egress-smoke'),
      cpu: 256,
      memoryLimitMiB: 512,
    })

    // Least privilege: this bucket, these two verbs, nothing else. A run must never hold a
    // permission it did not ask for.
    this.bucket.grantReadWrite(task.taskRole)

    task.addContainer('probe', {
      containerName: 'probe',
      // A public image, so this proves egress without depending on A3's ECR work.
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/alpine:3.20'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'probe', logGroup }),
      environment: {
        SMOKE_BUCKET: this.bucket.bucketName,
        AWS_DEFAULT_REGION: env.region,
      },
      entryPoint: ['/bin/sh', '-c'],
      command: [SMOKE_SCRIPT],
    })

    new ssm.StringParameter(this, 'ClusterParam', {
      parameterName: ssmPath(env.name, 'runtime', 'cluster-name'),
      stringValue: this.cluster.clusterName,
    })
    new ssm.StringParameter(this, 'SmokeTaskParam', {
      parameterName: ssmPath(env.name, 'smoke', 'task-definition-arn'),
      stringValue: task.taskDefinitionArn,
    })
    new ssm.StringParameter(this, 'SmokeBucketParam', {
      parameterName: ssmPath(env.name, 'smoke', 'bucket'),
      stringValue: this.bucket.bucketName,
    })
  }
}

/**
 * Four independent egress checks, each of which fails the task if it cannot complete.
 *
 * `set -e` is load bearing: without it a failed clone would still exit 0 and the smoke
 * test would report success while the network was broken.
 */
const SMOKE_SCRIPT = [
  'set -e',
  'echo "--- 1/4 DNS + HTTPS to a package mirror"',
  // Older Alpine images default to plain http, which port 443 alone would not permit.
  "sed -i 's|http://|https://|g' /etc/apk/repositories || true",
  'apk add --no-cache git aws-cli >/dev/null',
  'echo "--- 2/4 git clone over HTTPS"',
  'git clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/probe-repo',
  'test -d /tmp/probe-repo/.git',
  'echo "--- 3/4 S3 write over the gateway endpoint"',
  'echo "intellidev-egress-probe" >/tmp/probe.txt',
  'aws s3 cp /tmp/probe.txt "s3://$SMOKE_BUCKET/probe.txt"',
  'echo "--- 4/4 S3 read back, then clean up"',
  'aws s3 cp "s3://$SMOKE_BUCKET/probe.txt" - | grep -q intellidev-egress-probe',
  'aws s3 rm "s3://$SMOKE_BUCKET/probe.txt"',
  // The smoke script greps for this exact string; a zero exit code alone is too weak a
  // signal, because a shell that never ran the checks also exits zero.
  'echo EGRESS_SMOKE_OK',
].join('\n')
