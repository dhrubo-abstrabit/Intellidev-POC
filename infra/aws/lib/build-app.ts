import { App, Aspects } from 'aws-cdk-lib'
import { resolveEnvironment } from './config.js'
import { NoNatGateways } from './no-nat-aspect.js'
import { NetworkStack } from './network-stack.js'
import { ArtifactsStack } from './artifacts-stack.js'
import { RegistryStack } from './registry-stack.js'
import { SecretsStack } from './secrets-stack.js'
import { AppSecretsStack } from './app-secrets-stack.js'
import { ControlPlaneStack } from './control-plane-stack.js'
import { CicdStack } from './cicd-stack.js'
import { RuntimeStack } from './runtime-stack.js'
import { SmokeStack } from './smoke-stack.js'
import { stackName } from './naming.js'
import { applyTags } from './tags.js'

export interface BuildAppOverrides {
  /** Overrides `-c env=`. Tests pass this; the CLI does not. */
  readonly env?: unknown
  /** Overrides `-c account=`. */
  readonly account?: unknown
  /** Overrides `CDK_DEFAULT_ACCOUNT`, so tests need no credentials. */
  readonly ambientAccount?: string | undefined
  /** Overrides `-c githubRepo=`. Tests pass this; the CLI does not. */
  readonly githubRepo?: unknown
  /**
   * Extra context, for values read with `tryGetContext` rather than taken as an override.
   *
   * Tests only. A `-c` flag reaches the app through the CLI's own context, which a test has no
   * way to set — and reading these from `process.env` instead would make the test's setup
   * invisible in the test.
   */
  readonly context?: Record<string, unknown>
}

export interface BuiltApp {
  readonly app: App
  readonly network: NetworkStack
  readonly artifacts: ArtifactsStack
  readonly secrets: SecretsStack
  readonly appSecrets: AppSecretsStack
  readonly registry: RegistryStack
  readonly runtime: RuntimeStack
  readonly smoke: SmokeStack
  readonly controlPlane: ControlPlaneStack
  /**
   * Only when `-c githubRepo=owner/name` is given.
   *
   * Absent otherwise, so a developer synthesising locally is not asked for a value that only
   * matters to the pipeline — and so nothing invents a trust policy from a default.
   */
  readonly cicd?: CicdStack
}

/**
 * Assembles the whole app.
 *
 * Deliberately not inline in `bin/app.ts`: the guardrail tests must assert against the
 * template that actually deploys. If the wiring lived in the entry script the tests would
 * have to rebuild it by hand, and a NAT gateway could then be added to the real app while
 * a hand-built copy in the test still passed.
 *
 * Exactly one `App` is constructed here. Two would each auto-synth into `CDK_OUTDIR` and
 * the last writer would win, which presents as the CLI reporting "this app contains no
 * stacks".
 */
export function buildApp(overrides: BuildAppOverrides = {}): BuiltApp {
  // Context is passed only when a caller supplied some. Otherwise no-arg, so the CLI's own
  // context and output directory are picked up from the environment exactly as before.
  const app = overrides.context ? new App({ context: overrides.context }) : new App()

  const { config, account } = resolveEnvironment(
    overrides.env ?? app.node.tryGetContext('env'),
    'ambientAccount' in overrides ? overrides.ambientAccount : process.env['CDK_DEFAULT_ACCOUNT'],
    overrides.account ?? app.node.tryGetContext('account'),
  )

  // Region from config, account from the ambient session. Neither appears in application
  // code, and the region cannot be overridden by the environment.
  const network = new NetworkStack(app, stackName(config.name, 'Network'), {
    environment: config,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} network (${config.cidr})`,
  })

  const artifacts = new ArtifactsStack(app, stackName(config.name, 'Artifacts'), {
    environment: config,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} run specs and project bundles`,
  })

  const secrets = new SecretsStack(app, stackName(config.name, 'Secrets'), {
    environment: config,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} credential encryption key`,
  })

  const appSecrets = new AppSecretsStack(app, stackName(config.name, 'AppSecrets'), {
    environment: config,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} deployment-wide secrets`,
  })

  const registry = new RegistryStack(app, stackName(config.name, 'Registry'), {
    environment: config,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} golden-image registry`,
  })

  const runtime = new RuntimeStack(app, stackName(config.name, 'Runtime'), {
    environment: config,
    vpc: network.vpc,
    runnerRepository: registry.repository,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} run cluster, roles and task definition`,
  })

  const smoke = new SmokeStack(app, stackName(config.name, 'Smoke'), {
    environment: config,
    vpc: network.vpc,
    securityGroup: network.runTaskSecurityGroup,
    cluster: runtime.cluster,
    executionRole: runtime.executionRole,
    logGroup: runtime.logGroup,
    env: { account, region: config.region },
    description: `Intellidev ${config.name} egress proof`,
  })

  const controlPlane = new ControlPlaneStack(app, stackName(config.name, 'ControlPlane'), {
    environment: config,
    vpc: network.vpc,
    repository: registry.controlPlaneRepository,
    artifacts: artifacts.bucket,
    credentialKey: secrets.key,
    taskEvents: runtime.taskEvents,
    runTaskRole: runtime.taskRole,
    runExecutionRole: runtime.executionRole,
    runCluster: runtime.cluster,
    secrets: {
      githubAppKey: appSecrets.githubAppKey,
      databaseUrl: appSecrets.databaseUrl,
      supabaseServiceKey: appSecrets.supabaseServiceKey,
    },
    env: { account, region: config.region },
    description: `Intellidev ${config.name} hosted control plane`,
  })

  for (const stack of [
    network,
    artifacts,
    secrets,
    appSecrets,
    registry,
    runtime,
    smoke,
    controlPlane,
  ])
    applyTags(stack, config)
  Aspects.of(app).add(new NoNatGateways())

  /**
   * The pipeline's identity, only where one was asked for.
   *
   * Built last and depends on nothing: it grants permission to deploy the others rather than
   * consuming anything they produce. Skipped entirely without `-c githubRepo=`, so a local
   * `cdk synth` neither prompts for a value nor fabricates a trust policy.
   */
  const githubRepo = overrides.githubRepo ?? app.node.tryGetContext('githubRepo')
  const cicd =
    typeof githubRepo === 'string' && githubRepo.length > 0
      ? new CicdStack(app, stackName(config.name, 'Cicd'), {
          environment: config,
          githubRepo,
          env: { account, region: config.region },
        })
      : undefined

  return {
    app,
    network,
    artifacts,
    secrets,
    appSecrets,
    registry,
    runtime,
    smoke,
    controlPlane,
    ...(cicd ? { cicd } : {}),
  }
}
