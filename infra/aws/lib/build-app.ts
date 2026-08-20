import { App, Aspects } from 'aws-cdk-lib'
import { resolveEnvironment } from './config.js'
import { NoNatGateways } from './no-nat-aspect.js'
import { NetworkStack } from './network-stack.js'
import { ArtifactsStack } from './artifacts-stack.js'
import { RegistryStack } from './registry-stack.js'
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
}

export interface BuiltApp {
  readonly app: App
  readonly network: NetworkStack
  readonly artifacts: ArtifactsStack
  readonly registry: RegistryStack
  readonly runtime: RuntimeStack
  readonly smoke: SmokeStack
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
  // No-arg, so the CLI's context and output directory are picked up from the environment.
  const app = new App()

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

  for (const stack of [network, artifacts, registry, runtime, smoke]) applyTags(stack, config)
  Aspects.of(app).add(new NoNatGateways())

  return { app, network, artifacts, registry, runtime, smoke }
}
