import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface RuntimeStackProps extends StackProps {
  readonly environment: EnvironmentConfig
  readonly vpc: ec2.IVpc
  readonly runnerRepository: ecr.IRepository
}

export const RUN_CONTAINER_NAME = 'adapter'

/**
 * Where runs execute: the cluster, the two roles ECS needs, and **one** task definition.
 *
 * One task definition for every project, deliberately. Nothing project-specific is baked
 * in — env and command arrive as `RunTask` overrides — which is what keeps onboarding a
 * project a database row rather than an infrastructure change.
 *
 * The image is referenced by **digest, read from SSM at deploy time**. `push-image.sh`
 * writes that parameter, so the deploy order is: registry → push → deploy. Using
 * `valueForStringParameter` rather than `valueFromLookup` is load bearing: a lookup caches
 * into `cdk.context.json`, which would pin the task definition to whatever digest was
 * current when the context was written and silently ignore every later push.
 */
export class RuntimeStack extends Stack {
  readonly cluster: ecs.Cluster
  readonly executionRole: iam.Role
  readonly taskRole: iam.Role
  readonly taskDefinition: ecs.FargateTaskDefinition
  readonly logGroup: logs.LogGroup
  readonly taskEvents: sqs.Queue

  constructor(scope: Construct, id: string, props: RuntimeStackProps) {
    super(scope, id, props)
    const env = props.environment

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: resourceName(env.name, 'runners'),
      // Container Insights bills per metric; E2 chooses observability deliberately.
      containerInsightsV2: ecs.ContainerInsights.DISABLED,
    })

    this.logGroup = new logs.LogGroup(this, 'RunLogs', {
      logGroupName: `/intellidev/${env.name}/runs`,
      // E2 revisits this alongside the run_events retention decision. Two weeks is long
      // enough to debug a failure and short enough not to accumulate cost quietly.
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    /**
     * Role 2 of 3 — the **task execution role**. It belongs to ECS, not to the run: it
     * pulls the image and opens the log stream before any of our code exists.
     *
     * Not the managed `AmazonECSTaskExecutionRolePolicy`, which grants ECR pull on `*`.
     */
    this.executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: resourceName(env.name, 'task-execution'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pulls the golden image and opens log streams. Not the run identity.',
    })
    // Cannot be resource-scoped: it mints a registry-wide token, and AWS models it as an
    // account-level action. The pull itself is scoped on the next line.
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
    )
    props.runnerRepository.grantPull(this.executionRole)
    this.logGroup.grantWrite(this.executionRole)

    /**
     * Role 3 of 3 — the **task role**, which is the run's own identity.
     *
     * Deliberately almost empty. A run must never hold a credential it did not ask the
     * broker for, so it gets no S3, no Secrets Manager and no ECR. C2 adds read on its own
     * spec and bundle prefix; C3 adds its own cache prefix; B3 gives it a run token and
     * nothing else. Starting empty means every permission it ever holds was added on
     * purpose and is visible in a diff.
     */
    this.taskRole = new iam.Role(this, 'TaskRole', {
      roleName: resourceName(env.name, 'run-task'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'The run identity. Starts with no permissions; each one is added on purpose.',
    })

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'RunTask', {
      family: resourceName(env.name, 'run'),
      // Matches the cost model in architecture.md §13: a run is 2 vCPU / 4 GB.
      cpu: 2048,
      memoryLimitMiB: 4096,
      executionRole: this.executionRole,
      taskRole: this.taskRole,
      // Sized explicitly, as architecture.md §11 requires: the default is 20 GiB, and a
      // partial clone plus node_modules plus a package cache passes that quietly.
      ephemeralStorageGiB: 40,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.of(env.architecture),
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    const digest = ssm.StringParameter.valueForStringParameter(
      this,
      ssmPath(env.name, 'runner', 'image-digest'),
    )

    this.taskDefinition.addContainer(RUN_CONTAINER_NAME, {
      containerName: RUN_CONTAINER_NAME,
      // By digest, never a tag: a tag is a mutable pointer, so two dispatches of the same
      // commit could run different code and a failure would be unattributable.
      image: ecs.ContainerImage.fromRegistry(`${props.runnerRepository.repositoryUri}@${digest}`),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'run', logGroup: this.logGroup }),
      // Command and environment arrive as RunTask overrides, per run. Nothing here.
      essential: true,
    })

    /**
     * How the control plane learns that a task ended when nothing told it.
     *
     * An OOM kill, a failed image pull or a Spot interruption reports nothing: the run sits
     * `running` for ever, holding a seat and hiding cost, and the ECS task row is the only
     * evidence. C1's poll is not enough either, because it lives in the process that
     * dispatched the run and dies with a restart or a deploy.
     *
     * **A queue rather than a webhook.** The control plane has no public endpoint yet, and
     * even once it has one a webhook would drop events during a rolling deploy — exactly
     * when a task is most likely to be orphaned. A queue buffers while nothing is
     * listening, redelivers on failure, and works with zero or many instances, which is
     * what a stateless control plane requires.
     */
    const deadLetter = new sqs.Queue(this, 'TaskEventsDlq', {
      queueName: resourceName(env.name, 'task-events-dlq'),
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    })

    this.taskEvents = new sqs.Queue(this, 'TaskEvents', {
      queueName: resourceName(env.name, 'task-events'),
      // Long enough for the consumer to look up the run and settle it, short enough that a
      // crashed consumer returns the message quickly rather than stalling a run's outcome.
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: deadLetter,
        // Three attempts, then park it. A message that cannot be processed is a bug worth
        // seeing in a DLQ rather than an infinite redelivery loop that looks like traffic.
        maxReceiveCount: 3,
      },
    })

    new events.Rule(this, 'TaskStateChange', {
      ruleName: resourceName(env.name, 'task-state-change'),
      description: 'Stopped-task reasons for runs, so a quiet death still settles the run.',
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: {
          // Scoped to this cluster: another cluster in the account is not ours to settle.
          clusterArn: [this.cluster.clusterArn],
          // Only terminal transitions. RUNNING and PENDING would be noise the consumer
          // would have to filter anyway, and every one costs a queue request.
          lastStatus: ['STOPPED'],
        },
      },
      targets: [new targets.SqsQueue(this.taskEvents)],
    })

    for (const [key, value] of [
      ['runtime/cluster-name', this.cluster.clusterName],
      ['runtime/task-events-queue-url', this.taskEvents.queueUrl],
      /**
       * The family, not a revision-pinned ARN.
       *
       * FOUND BY DEPLOYING IT. A new image means a new task definition revision, and CDK
       * deregisters the one it replaces — so every run dispatched by an already-running control
       * plane failed with `TaskDefinition is inactive`, because it had resolved the ARN at boot
       * and that revision no longer existed. Restarting it would have fixed each occurrence and
       * taught nobody anything.
       *
       * `RunTask` accepts a family and uses the latest ACTIVE revision, which is also what makes
       * an image update take effect without restarting the control plane. Reproducibility does
       * not suffer: the image inside a revision is pinned by digest, and which digest ran is
       * recorded per run.
       *
       * The parameter keeps its historical name so a deploy is not a coordinated rename with a
       * window where neither key exists.
       */
      ['runtime/run-task-definition-arn', this.taskDefinition.family],
      ['runtime/run-container-name', RUN_CONTAINER_NAME],
      ['runtime/task-execution-role-arn', this.executionRole.roleArn],
      ['runtime/task-role-arn', this.taskRole.roleArn],
      ['runtime/log-group-name', this.logGroup.logGroupName],
    ] as const) {
      new ssm.StringParameter(this, `Param${key.split('/')[1]!.replace(/-/g, '')}`, {
        parameterName: ssmPath(env.name, ...key.split('/')),
        stringValue: value,
      })
    }
  }
}
