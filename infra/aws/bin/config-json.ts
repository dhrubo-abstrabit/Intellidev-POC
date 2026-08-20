#!/usr/bin/env node
/**
 * Prints the resolved environment config as JSON.
 *
 * Exists so the shell scripts have exactly one source of truth for region, CIDR and stack
 * name. A preflight check that hardcoded `ap-south-1` would be a second place a region
 * lives, which is the thing the constraints forbid.
 */
import { App } from 'aws-cdk-lib'
import { resolveEnvironment } from '../lib/config.js'
import { stackName } from '../lib/naming.js'

const context = new App()
const { config, account } = resolveEnvironment(
  context.node.tryGetContext('env') ?? process.env['INTELLIDEV_ENV'],
  process.env['CDK_DEFAULT_ACCOUNT'] ?? 'unresolved',
  context.node.tryGetContext('account'),
)

process.stdout.write(
  JSON.stringify(
    {
      env: config.name,
      region: config.region,
      cidr: config.cidr,
      azCount: config.azCount,
      account,
      networkStack: stackName(config.name, 'Network'),
    },
    null,
    2,
  ) + '\n',
)
