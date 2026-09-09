import { Tags } from 'aws-cdk-lib'
import type { IConstruct } from 'constructs'
import { APP } from './naming.js'
import type { EnvironmentConfig } from './config.js'

/**
 * Tags every resource in a stack.
 *
 * Two jobs beyond tidiness: it is how "the repo has no hand-made resources" becomes a
 * query rather than a belief, and E3's per-project cost attribution needs the tags to have
 * existed since the first deploy — they cannot be backfilled onto past bills.
 */
export function applyTags(scope: IConstruct, env: EnvironmentConfig): void {
  Tags.of(scope).add('intellidev:app', APP)
  Tags.of(scope).add('intellidev:env', env.name)
  Tags.of(scope).add('intellidev:managed-by', 'cdk')
}
