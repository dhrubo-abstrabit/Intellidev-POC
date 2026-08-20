/**
 * The environment table.
 *
 * This file, `naming.ts` and the stacks are the only places a region, CIDR or resource
 * name is allowed to appear. Application code receives these as configuration resolved at
 * boot — read from SSM under `ssmPath(...)` — so `dev` and `prod` differ by configuration
 * and never by code path.
 */

export type EnvironmentName = 'dev' | 'prod'

export interface EnvironmentConfig {
  readonly name: EnvironmentName
  /**
   * Pinned here rather than read from the ambient session, so a stray `AWS_REGION` cannot
   * deploy an environment into the wrong region.
   */
  readonly region: string
  readonly cidr: string
  readonly azCount: number
  /**
   * `dev` deploys into whichever account you are authenticated to. `prod` must never be
   * able to land somewhere by accident, so it requires the account id to be passed
   * explicitly and checked against the session.
   */
  readonly requiresPinnedAccount: boolean
}

export const ENVIRONMENTS: Record<EnvironmentName, EnvironmentConfig> = {
  dev: {
    name: 'dev',
    region: 'ap-south-1',
    // Deliberately not overlapping the account's default VPC (172.31.0.0/16), and leaving
    // 10.21.0.0/16 free for prod so the two could ever be peered.
    cidr: '10.20.0.0/16',
    azCount: 2,
    requiresPinnedAccount: false,
  },
  prod: {
    name: 'prod',
    region: 'ap-south-1',
    cidr: '10.21.0.0/16',
    azCount: 2,
    requiresPinnedAccount: true,
  },
}

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return value === 'dev' || value === 'prod'
}

/**
 * Resolves the environment from CDK context (`-c env=dev`) and the ambient account.
 *
 * The account id is never written down — it arrives from the credentials the deploy runs
 * under. `prod` additionally has to be told which account it expects, and refuses to synth
 * if the session is pointed somewhere else.
 */
export function resolveEnvironment(
  rawEnv: unknown,
  ambientAccount: string | undefined,
  contextAccount?: unknown,
): { config: EnvironmentConfig; account: string } {
  const name = rawEnv ?? 'dev'
  if (!isEnvironmentName(name)) {
    throw new Error(
      `unknown environment ${JSON.stringify(name)}; expected one of ${Object.keys(ENVIRONMENTS).join(', ')}`,
    )
  }
  const config = ENVIRONMENTS[name]

  const account = typeof contextAccount === 'string' ? contextAccount : ambientAccount
  if (!account) {
    throw new Error(
      'no AWS account resolved; deploy with valid credentials (CDK_DEFAULT_ACCOUNT) or pass -c account=<id>',
    )
  }

  if (config.requiresPinnedAccount) {
    if (typeof contextAccount !== 'string') {
      throw new Error(
        `environment ${config.name} requires the account to be passed explicitly: -c account=<id>`,
      )
    }
    if (ambientAccount && ambientAccount !== contextAccount) {
      throw new Error(
        `refusing to synth ${config.name}: session is account ${ambientAccount} but -c account=${contextAccount}`,
      )
    }
  }

  return { config, account }
}
