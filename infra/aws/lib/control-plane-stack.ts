import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface ControlPlaneStackProps extends StackProps {
  readonly environment: EnvironmentConfig
  readonly vpc: ec2.IVpc
  readonly repository: ecr.IRepository
  readonly artifacts: s3.IBucket
  readonly credentialKey: kms.IKey
  readonly taskEvents: sqs.IQueue
  /** The run cluster's roles, which this service must be able to hand to a task it starts. */
  readonly runTaskRole: iam.IRole
  readonly runExecutionRole: iam.IRole
  readonly runCluster: ecs.ICluster
  readonly secrets: {
    readonly githubAppKey: secretsmanager.ISecret
    readonly databaseUrl: secretsmanager.ISecret
    readonly supabaseServiceKey: secretsmanager.ISecret
  }
}

/**
 * The control plane, hosted.
 *
 * This is what retires the tunnel. Until now the process ran on a laptop and a run container
 * reached it through ngrok, which means the system worked exactly as long as someone's machine
 * was awake — and every credential a run needed travelled through a third party's tunnel.
 *
 * Everything that made this possible was built first and deliberately: seats and MCP tokens in
 * the database rather than on disk, run tokens durable rather than in a Map, an ordered
 * shutdown, and a health check that asks whether the database is reachable. A service is where
 * those stop being hygiene and start being load-bearing.
 */
export class ControlPlaneStack extends Stack {
  readonly service: ecs.FargateService
  readonly loadBalancer: elbv2.ApplicationLoadBalancer

  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props)
    const env = props.environment

    /**
     * The certificate and hostname, resolved from SSM rather than hardcoded.
     *
     * Both are account- and domain-specific, and neither belongs in source. `valueFromLookup`
     * is avoided on purpose — it caches into `cdk.context.json`, and a cached certificate ARN is
     * exactly the sort of stale value that deploys cleanly and serves the wrong certificate.
     */
    const certificateArn = ssm.StringParameter.valueForStringParameter(
      this,
      ssmPath(env.name, 'control-plane', 'certificate-arn'),
    )
    const hostname = ssm.StringParameter.valueForStringParameter(
      this,
      ssmPath(env.name, 'control-plane', 'hostname'),
    )

    const logGroup = new logs.LogGroup(this, 'ControlPlaneLogs', {
      logGroupName: `/intellidev/${env.name}/control-plane`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    })

    // --- identity ----------------------------------------------------------

    const executionRole = new iam.Role(this, 'ExecutionRole', {
      roleName: resourceName(env.name, 'control-plane-execution'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pulls the image and writes logs. Not the identity the process runs as.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    })
    // The execution role fetches secrets *before* the container starts, which is why it needs
    // them as well as the task role. It never sees the values; ECS injects them.
    for (const secret of Object.values(props.secrets)) secret.grantRead(executionRole)

    /**
     * What the control plane itself may do.
     *
     * Granted one capability at a time rather than by a managed policy, because this role can
     * start containers and read every stored credential — the two things worth being exact
     * about.
     */
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: resourceName(env.name, 'control-plane'),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'The control plane. Starts runs, brokers credentials, reads run lifecycle.',
    })

    props.credentialKey.grant(taskRole, 'kms:GenerateDataKey', 'kms:Decrypt')
    for (const secret of Object.values(props.secrets)) secret.grantRead(taskRole)

    // Run specs and bundles. Presigning is a local signing operation, but the object still has
    // to be readable by the signer for the URL to work.
    props.artifacts.grantReadWrite(taskRole, 'runs/*')
    props.artifacts.grantRead(taskRole, 'bundles/*')

    props.taskEvents.grantConsumeMessages(taskRole)

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartAndObserveRuns',
        actions: [
          'ecs:RunTask',
          'ecs:StopTask',
          'ecs:DescribeTasks',
          'ecs:ListTasks',
          // FOUND BY DEPLOYING IT. The runner tags every task it starts with its run id, so a
          // stray container can be attributed without reading logs and cost can be split per
          // project. Without this, `RunTask` fails with an authorization error naming
          // `ecs:TagResource` — and the run fails before a container ever exists, so there is
          // nothing to inspect.
          'ecs:TagResource',
        ],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': props.runCluster.clusterArn } },
      }),
    )

    /**
     * Handing a role to a task it starts.
     *
     * `RunTask` is not enough on its own: starting a task that assumes a role requires
     * permission to *pass* that role, and without it every dispatch fails with an IAM error that
     * names neither the role nor the missing action. Scoped to the two run roles, so this cannot
     * be used to start a task as something more privileged.
     */
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassRunRoles',
        actions: ['iam:PassRole'],
        resources: [props.runTaskRole.roleArn, props.runExecutionRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    )

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOwnConfiguration',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPath(env.name)}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPath(env.name)}/*`,
        ],
      }),
    )

    // --- the task ----------------------------------------------------------

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: resourceName(env.name, 'control-plane'),
      // Modest: this serves HTTP and holds connections. The work happens in run tasks, which
      // are sized separately and paid for only while they exist.
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    const imageDigest = ssm.StringParameter.valueForStringParameter(
      this,
      ssmPath(env.name, 'control-plane', 'image-digest'),
    )

    const container = taskDefinition.addContainer('control-plane', {
      // By digest, never by tag. A tag is a mutable pointer, so a task definition that names one
      // does not describe what will actually run, and a rollback becomes "hope the tag moved
      // back" rather than naming the digest that worked.
      image: ecs.ContainerImage.fromEcrRepository(props.repository, `sha256:${imageDigest}`),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'control-plane', logGroup }),
      environment: {
        INTELLIDEV_ENV: env.name,
        INTELLIDEV_MODE: 'fargate',
        INTELLIDEV_BIND_HOST: '0.0.0.0',
        PORT: '4000',
        AWS_REGION: this.region,
        // What a run container is told to dial back to. Wrong here means every run starts and
        // then cannot report anything, which looks like the runner failing.
        INTELLIDEV_PUBLIC_URL: `https://${hostname}`,
        /**
         * Which project this serves, and where tokens come from.
         *
         * Both are configuration rather than secrets, so they belong in SSM with every other
         * resolved name. Without them the process exits at boot — the project id because a
         * database-backed store refuses to guess one, and the Supabase URL because its absence
         * means "no authentication is possible", which would leave the API open on a public
         * load balancer.
         */
        INTELLIDEV_PROJECT_ID: ssm.StringParameter.valueForStringParameter(
          this,
          ssmPath(env.name, 'control-plane', 'project-id'),
        ),
        SUPABASE_URL: ssm.StringParameter.valueForStringParameter(
          this,
          ssmPath(env.name, 'control-plane', 'supabase-url'),
        ),
        /**
         * The App id, which is not a secret — it is printed on the App's own settings page.
         *
         * FOUND BY DEPLOYING IT. Only the private key was injected, and `gitHubAppFromEnv`
         * needs both: with one missing it returns undefined, the App is silently not
         * configured, and the broker refuses git with "no github app and no token configured"
         * — after a run has done all its work and reached the push.
         */
        GITHUB_APP_ID: ssm.StringParameter.valueForStringParameter(
          this,
          ssmPath(env.name, 'control-plane', 'github-app-id'),
        ),
      },
      secrets: {
        // Injected by ECS from Secrets Manager, so no value passes through a template, a
        // parameter, or this repository.
        GITHUB_APP_PRIVATE_KEY: ecs.Secret.fromSecretsManager(props.secrets.githubAppKey),
        SUPABASE_CONNECTION_STRING_SESSION: ecs.Secret.fromSecretsManager(
          props.secrets.databaseUrl,
        ),
        SUPABASE_SERVICE_ROLE_KEY: ecs.Secret.fromSecretsManager(props.secrets.supabaseServiceKey),
      },
      portMappings: [{ containerPort: 4000, protocol: ecs.Protocol.TCP }],
      // ECS sends SIGTERM and waits this long before SIGKILL. The application drains in
      // seconds; the margin is for in-flight requests, and it only costs anything on a deploy.
      stopTimeout: Duration.seconds(30),
    })

    // --- networking --------------------------------------------------------

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc: props.vpc,
      description: 'Public HTTPS to the control plane',
      allowAllOutbound: false,
    })
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from anywhere')
    // 80 only to redirect. Serving anything on it would mean a credential could travel in the
    // clear from a client that got the scheme wrong.
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP, redirected to 443')

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: props.vpc,
      description: 'The control plane task',
      // It must reach Supabase, GitHub, Secrets Manager and the ECS API, all over 443.
      allowAllOutbound: true,
    })
    serviceSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(4000),
      'Only from the load balancer',
    )

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      loadBalancerName: resourceName(env.name, 'control-plane'),
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      /**
       * Long enough for a run's event stream.
       *
       * The default is 60 seconds, which silently cuts an SSE connection watching a quiet stage
       * and reads to a user as the run stalling. A run can take many minutes; this must exceed
       * the longest gap between events, not the longest run.
       */
      idleTimeout: Duration.minutes(15),
    })

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'Targets', {
      vpc: props.vpc,
      port: 4000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/healthz',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      /**
       * How long the balancer waits before removing a draining target.
       *
       * The default is five minutes, which makes every deploy take five minutes. The application
       * closes its server and finishes in-flight requests in seconds, so this only has to cover
       * that — with margin for a long-lived stream to notice and reconnect.
       */
      deregistrationDelay: Duration.seconds(30),
      // The event stream is per-connection, not per-session, and any instance can serve any run
      // because the store is shared. Stickiness would concentrate load for no benefit.
      stickinessCookieDuration: undefined,
    })

    const listener = this.loadBalancer.addListener('Https', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn)],
      // TLS 1.2 as the floor. Older suites exist only for clients this has none of.
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultTargetGroups: [targetGroup],
    })

    this.loadBalancer.addListener('HttpRedirect', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true,
      }),
    })

    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: resourceName(env.name, 'control-plane'),
      cluster: props.runCluster,
      taskDefinition,
      /**
       * One task.
       *
       * Everything needed for a second exists — durable run tokens, cross-instance event
       * fan-out, an advisory lock on token refresh — but none of it is exercised yet, and a
       * second task doubles the cost for availability nothing currently depends on. Raising this
       * is a number, not a project, which is the point of having built it that way.
       */
      desiredCount: 1,
      securityGroups: [serviceSecurityGroup],
      // Public subnets with a public IP, because there is no NAT gateway and the task must reach
      // Supabase and GitHub. Its security group allows ingress only from the load balancer.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
      // Long enough for the first health check to pass without the task being killed for failing
      // one it never had time to answer.
      healthCheckGracePeriod: Duration.seconds(60),
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    })
    // Attaching is enough: CDK orders the service after the listener itself. Adding the reverse
    // dependency explicitly produced a cycle that `cdk synth` reported as success and only the
    // template assertions caught.
    this.service.attachToApplicationTargetGroup(targetGroup)
    void listener

    new ssm.StringParameter(this, 'AlbDnsName', {
      parameterName: ssmPath(env.name, 'control-plane', 'alb-dns-name'),
      stringValue: this.loadBalancer.loadBalancerDnsName,
      description: 'Point the control plane hostname at this with a CNAME',
    })

    void container
  }
}
