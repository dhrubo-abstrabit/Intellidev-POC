/**
 * The only place a resource name is formed.
 *
 * Nothing else in this app — and nothing at all in `packages/` — may write a literal
 * resource name. That is what keeps "no resource name, ARN or region in application code"
 * checkable rather than aspirational: a name either comes from here, or it comes from SSM.
 */
import type { EnvironmentName } from './config.js'

export const APP = 'intellidev'

/** A CloudFormation stack id, e.g. `Intellidev-dev-Network`. */
export function stackName(env: EnvironmentName, component: string): string {
  return `Intellidev-${env}-${component}`
}

/** A resource name, e.g. `intellidev-dev-vpc`. */
export function resourceName(env: EnvironmentName, ...parts: string[]): string {
  return [APP, env, ...parts].join('-')
}

/**
 * An SSM parameter path, e.g. `/intellidev/dev/network/vpc-id`.
 *
 * This is the seam between infrastructure and the application: stacks write here, the
 * control plane reads this prefix at boot. Deliberately not CloudFormation outputs — the
 * control plane is not a CDK process and must not call CloudFormation at runtime.
 */
export function ssmPath(env: EnvironmentName, ...parts: string[]): string {
  return ['', APP, env, ...parts].join('/')
}
