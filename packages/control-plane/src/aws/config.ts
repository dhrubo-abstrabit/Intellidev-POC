import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm'

/**
 * Configuration resolved from SSM at boot.
 *
 * This is the whole point of the constraint that no resource name, ARN or region appears in
 * application code. Every value below is written by a CDK stack under
 * `/intellidev/<env>/…` and read here once, at startup — so `dev` and `prod` differ by
 * configuration and never by a code path, and a redeployed VPC does not need a code change.
 *
 * Read once rather than per dispatch on purpose: a dispatch that resolved config lazily
 * would fail halfway with a permissions error instead of refusing to start.
 */
export interface AwsRuntimeConfig {
  readonly env: string
  readonly region: string
  readonly clusterName: string
  readonly taskDefinitionArn: string
  readonly subnetIds: readonly string[]
  readonly securityGroupIds: readonly string[]
  readonly containerName: string
  readonly artifactBucket: string
  /**
   * Published bundles, keyed by project id.
   *
   * A map rather than a single value because everything is scoped by project: two projects
   * have different prompts and therefore different bundles, and one shared entry would be
   * how they silently started running each other's stage prompts.
   */
  readonly bundles: Readonly<Record<string, { key: string; digest: string }>>
}

/** Parameter names, relative to `/intellidev/<env>/`. Keep in step with the CDK stacks. */
const REQUIRED = {
  clusterName: 'runtime/cluster-name',
  taskDefinitionArn: 'runtime/run-task-definition-arn',
  containerName: 'runtime/run-container-name',
  subnetIds: 'network/public-subnet-ids',
  securityGroupIds: 'network/run-task-security-group-id',
  artifactBucket: 'artifacts/bucket',
} as const

/** `bundle/<projectId>/{key,digest}` — one pair per project that has published one. */
const BUNDLE_PATTERN = /^bundle\/(?<project>[^/]+)\/(?<field>key|digest)$/

export interface LoadAwsConfigOptions {
  env: string
  region: string
  client?: Pick<SSMClient, 'send'>
}

/**
 * Reads the environment's parameters, or explains precisely which one is missing.
 *
 * A missing parameter is nearly always "you have not deployed that stack yet" or "you have
 * not pushed an image yet", so the error names the path rather than surfacing an SDK
 * exception that says only `ParameterNotFound`.
 */
export async function loadAwsConfig(opts: LoadAwsConfigOptions): Promise<AwsRuntimeConfig> {
  const client = opts.client ?? new SSMClient({ region: opts.region })
  const prefix = `/intellidev/${opts.env}/`

  const values = new Map<string, string>()
  let nextToken: string | undefined
  do {
    const page = await client.send(
      new GetParametersByPathCommand({
        Path: `/intellidev/${opts.env}`,
        Recursive: true,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    )
    for (const param of page.Parameters ?? []) {
      if (param.Name && param.Value !== undefined) {
        values.set(param.Name.slice(prefix.length), param.Value)
      }
    }
    nextToken = page.NextToken
  } while (nextToken)

  const missing = Object.values(REQUIRED).filter((path) => !values.has(path))
  if (missing.length > 0) {
    throw new Error(
      `AWS config incomplete for env "${opts.env}". Missing ${prefix}{${missing.join(', ')}}. ` +
        'Deploy the infrastructure (pnpm infra:deploy) and push an image (pnpm image:push).',
    )
  }

  const get = (path: string): string => values.get(path)!
  // Stored as a StringList, which SSM returns comma-joined.
  const list = (path: string): string[] => get(path).split(',').filter(Boolean)

  // Collected rather than required: a project with no published bundle is a legitimate
  // state (it simply cannot dispatch yet), and failing at boot would block every other
  // project because one was not ready.
  const bundles: Record<string, { key: string; digest: string }> = {}
  for (const [path, value] of values) {
    const match = BUNDLE_PATTERN.exec(path)
    const project = match?.groups?.['project']
    const field = match?.groups?.['field']
    if (!project || !field) continue
    const entry = (bundles[project] ??= { key: '', digest: '' })
    if (field === 'key') entry.key = value
    else entry.digest = value
  }
  for (const [project, entry] of Object.entries(bundles)) {
    if (!entry.key || !entry.digest) {
      // Half a bundle reference is worse than none: dispatch would build a spec pointing at
      // an object with no digest to verify it against.
      throw new Error(
        `bundle for project "${project}" is incomplete under ${prefix}bundle/${project}/ ` +
          '(need both key and digest). Re-run pnpm bundle:push.',
      )
    }
  }

  return {
    env: opts.env,
    region: opts.region,
    clusterName: get(REQUIRED.clusterName),
    taskDefinitionArn: get(REQUIRED.taskDefinitionArn),
    containerName: get(REQUIRED.containerName),
    subnetIds: list(REQUIRED.subnetIds),
    securityGroupIds: list(REQUIRED.securityGroupIds),
    artifactBucket: get(REQUIRED.artifactBucket),
    bundles,
  }
}
