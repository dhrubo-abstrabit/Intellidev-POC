#!/usr/bin/env node
/**
 * C5's proving signal: a task killed from outside still settles its run.
 *
 * The unit tests already cover the logic against a fake ECS client. What they cannot show
 * is that the sweep reads *real* ECS and turns a *real* stop into a reason a human can act
 * on — which is the whole done-condition: "killing a task from the AWS console, with no
 * cooperation from the adapter, moves the run to failed with a reason a human can act on."
 *
 * `StopTask` is used rather than a console click because it is the same API call the console
 * makes. Nothing in the adapter participates either way.
 */
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'
import { loadAwsConfig } from '../src/aws/config.js'
import { LifecycleReconciler } from '../src/lifecycle/reconciler.js'
import { InMemoryStore } from '../src/store.js'
import { allowTestRepo, TEST_SCOPE, TEST_REPO_URL } from '../test/fixtures.js'

const env = process.env['INTELLIDEV_ENV'] ?? 'dev'
const region = process.env['AWS_REGION'] ?? 'ap-south-1'

const config = await loadAwsConfig({ env, region })
const ecs = new ECSClient({ region })

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** A store holding one run that believes it is still going, as an orphan would. */
async function orphanedRun(handle: string) {
  const store = new InMemoryStore()
  const task = await store.createTask(
    {
      title: 'c5 orphan',
      description: 'killed from outside with no adapter cooperation',
      acceptanceCriteria: ['settles'],
      harness: 'claude-code',
      repoUrl: TEST_REPO_URL,
      baseBranch: 'master',
      mcpServerIds: [],
    },
    TEST_SCOPE,
  )
  await store.setTaskStatus(task.id, 'dispatched')
  await store.setTaskStatus(task.id, 'running')
  const run = await store.createRun(task.id, 'claude-code', 'feat/c5')
  await store.updateRun(run.id, { handle, status: 'running' })
  return { store, runId: run.id }
}

console.log(`config resolved from /intellidev/${env}/`)
console.log(`  cluster ${config.clusterName}`)

// --- 1. a task killed mid-flight settles with the reason we gave ---
console.log('\n1/2 a task stopped from outside settles the run')
const started = await ecs.send(
  new RunTaskCommand({
    cluster: config.clusterName,
    taskDefinition: config.taskDefinitionArn,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: [...config.subnetIds],
        securityGroups: [...config.securityGroupIds],
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: { containerOverrides: [{ name: config.containerName, command: ['run', '--help'] }] },
  }),
)
const arn = started.tasks?.[0]?.taskArn
if (!arn) throw new Error('RunTask returned no ARN')
console.log(`  launched ${arn.split('/').pop()}`)

await ecs.send(
  new StopTaskCommand({
    cluster: config.clusterName,
    task: arn,
    reason: 'killed from outside, as a console click would',
  }),
)
console.log('  stopped it from outside; nothing in the adapter was involved')

// Wait for ECS to record the stop. The reconciler is not being tested on its patience.
for (let i = 0; i < 30; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const { store, runId } = await orphanedRun(arn)
  const settled = await new LifecycleReconciler({
    store,
    clusterName: config.clusterName,
    queueUrl: config.taskEventsQueueUrl,
    region,
  }).sweep()

  if (settled.length > 0) {
    const run = await store.getRun(runId)
    check('run moved off running', run?.status === 'failed', `status=${run?.status}`)
    check(
      'reason is actionable, not just "it stopped"',
      (run?.failureReason ?? '').length > 20,
      run?.failureReason ?? '(none)',
    )
    break
  }
  if (i === 29) check('sweep settled the orphaned run', false, 'still running after 120s')
}

// --- 2. a run whose task ECS has forgotten still settles ---
console.log('\n2/2 a run whose task ECS never knew still settles')
const { store, runId } = await orphanedRun(
  `arn:aws:ecs:${region}:523366816420:task/${config.clusterName}/${'0'.repeat(32)}`,
)
const settled = await new LifecycleReconciler({
  store,
  clusterName: config.clusterName,
  queueUrl: config.taskEventsQueueUrl,
  region,
}).sweep()
check('settled rather than left running forever', settled.length === 1)
check(
  'says why no reason is available',
  ((await store.getRun(runId))?.failureReason ?? '').includes('no longer known to ECS'),
  (await store.getRun(runId))?.failureReason ?? '(none)',
)

console.log(failures === 0 ? '\nprove-reconciler: ok' : `\nprove-reconciler: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
