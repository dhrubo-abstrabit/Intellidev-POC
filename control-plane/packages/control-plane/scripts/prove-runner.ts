#!/usr/bin/env node
/**
 * C1's proving signal: launch a real Fargate task through the real `FargateRunner`.
 *
 * Not a unit test with a fake ECS client — those already exist. This is the claim the unit
 * tests cannot make: that the resolved SSM config, the deployed task definition, the
 * subnets, the security group and the execution role actually work together, and that the
 * handle comes back while the task is alive rather than after it has finished.
 *
 * Runs `intellidev-adapter --help`, which needs no run spec, because the spec and bundle
 * still arrive over bind mounts today. C2 replaces those with S3 and makes a full run
 * possible from here.
 */
import { loadAwsConfig } from '../src/aws/config.js'
import { FargateRunner } from '../src/runner/fargate.js'

const env = process.env['INTELLIDEV_ENV'] ?? 'dev'
const region = process.env['AWS_REGION'] ?? 'ap-south-1'

const config = await loadAwsConfig({ env, region })
console.log(`config resolved from /intellidev/${env}/`)
console.log(`  cluster       ${config.clusterName}`)
console.log(`  taskdef       ${config.taskDefinitionArn.split('/').pop()}`)
console.log(`  subnets       ${config.subnetIds.join(', ')}`)
console.log(`  security grp  ${config.securityGroupIds.join(', ')}`)

const runner = new FargateRunner({ config, pollIntervalMs: 4000 })
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// --- 1. a task starts, and the handle is an ARN available immediately ---
console.log('\n1/3 start returns a task ARN before the run ends')
const runId = `run_prove_${Date.now().toString(36)}`
const startedAt = Date.now()
const handle = await runner.start({
  runId,
  image: 'from the task definition',
  // `run --help` exits 0 without needing a spec. A bare `--help` is a usage error and
  // exits 2, which is the correct CLI convention and not what we want to assert against.
  args: ['run', '--help'],
  env: { INTELLIDEV_PROVE: runId },
  timeoutSec: 300,
})
const elapsed = Date.now() - startedAt
check('handle is a task ARN', /^arn:aws:ecs:.+:task\//.test(handle.handle), handle.handle)
check('returned without waiting for the run', elapsed < 15_000, `${elapsed}ms`)

// --- 2. the outcome resolves with the container's exit code ---
console.log('\n2/3 the outcome resolves when the task stops')
const outcome = await handle.outcome
check(
  'exit code 0',
  outcome.exitCode === 0,
  `exitCode=${outcome.exitCode} reason=${outcome.reason ?? '-'}`,
)
check('not reported as timed out', outcome.timedOut === false)

// --- 3. stop() cancels a live task ---
console.log('\n3/3 stop cancels a task that is still starting')
const cancelId = `run_cancel_${Date.now().toString(36)}`
const doomed = await runner.start({ runId: cancelId, image: 'x', args: ['run', '--help'] })
await runner.stop(doomed.handle)
const cancelled = await doomed.outcome
check(
  'stopped by us, with our reason recorded',
  (cancelled.reason ?? '').includes('control plane'),
  cancelled.reason ?? '(no reason)',
)

console.log(failures === 0 ? '\nprove-runner: ok' : `\nprove-runner: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
