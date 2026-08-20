import { describe, expect, it } from 'vitest'
import type { AwsRuntimeConfig } from '../src/aws/config.js'
import { FargateRunner } from '../src/runner/fargate.js'
import { loadAwsConfig } from '../src/aws/config.js'

const CONFIG: AwsRuntimeConfig = {
  env: 'dev',
  region: 'ap-south-1',
  clusterName: 'intellidev-dev-runners',
  taskDefinitionArn: 'arn:aws:ecs:ap-south-1:1:task-definition/intellidev-dev-run:3',
  subnetIds: ['subnet-a', 'subnet-b'],
  securityGroupIds: ['sg-1'],
  containerName: 'adapter',
  artifactBucket: 'bkt',
  taskEventsQueueUrl: 'https://sqs/q',
  bundles: {},
}

/** Records what was sent, and replies with whatever the test queued. */
function fakeEcs(replies: unknown[]) {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    client: {
      send: async (command: { input: Record<string, unknown> }) => {
        sent.push(command.input)
        return replies.shift() ?? {}
      },
    } as never,
  }
}

const RUNNING = { tasks: [{ lastStatus: 'RUNNING' }] }
const stopped = (exitCode: number | undefined, reason?: string) => ({
  tasks: [
    {
      lastStatus: 'STOPPED',
      ...(reason ? { stoppedReason: reason } : {}),
      containers: [{ name: 'adapter', ...(exitCode === undefined ? {} : { exitCode }) }],
    },
  ],
})

describe('FargateRunner.start', () => {
  it('returns the task ARN immediately, before the run finishes', async () => {
    // The entire reason `start` and the outcome are separate. On Fargate the ARN is the
    // only thing that can cancel a run, and it must be recordable while the run is alive.
    const ecs = fakeEcs([{ tasks: [{ taskArn: 'arn:aws:ecs:::task/abc' }] }, RUNNING])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client, pollIntervalMs: 1 })
    const handle = await runner.start({ runId: 'run_1', image: 'ignored', args: ['run'] })
    expect(handle.handle).toBe('arn:aws:ecs:::task/abc')
  })

  it('keys idempotency on runId, so a retry cannot launch two containers', async () => {
    const ecs = fakeEcs([{ tasks: [{ taskArn: 'arn:1' }] }, stopped(0)])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client, pollIntervalMs: 1 })
    const handle = await runner.start({ runId: 'run_dup', image: 'i', args: ['run'] })
    await handle.outcome
    expect(ecs.sent[0]?.['clientToken']).toBe('run-run_dup')
  })

  it('assigns a public IP, which is what replaces the NAT gateway', async () => {
    const ecs = fakeEcs([{ tasks: [{ taskArn: 'arn:1' }] }, stopped(0)])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client, pollIntervalMs: 1 })
    await (
      await runner.start({ runId: 'r', image: 'i', args: ['run'] })
    ).outcome
    const net = ecs.sent[0]?.['networkConfiguration'] as Record<string, never>
    expect(net['awsvpcConfiguration']?.['assignPublicIp']).toBe('ENABLED')
  })

  it('passes command and env as overrides, not as a new task definition', async () => {
    // One task definition for every project. Baking env into a per-project revision is how
    // onboarding a project stops being a database row.
    const ecs = fakeEcs([{ tasks: [{ taskArn: 'arn:1' }] }, stopped(0)])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client, pollIntervalMs: 1 })
    await (
      await runner.start({ runId: 'r', image: 'i', args: ['run', '--spec', '/s'], env: { A: '1' } })
    ).outcome
    const overrides = ecs.sent[0]?.['overrides'] as {
      containerOverrides: Array<Record<string, unknown>>
    }
    const override = overrides.containerOverrides[0]!
    expect(override['name']).toBe('adapter')
    expect(override['command']).toEqual(['run', '--spec', '/s'])
    expect(override['environment']).toEqual([{ name: 'A', value: '1' }])
    expect(ecs.sent[0]?.['taskDefinition']).toBe(CONFIG.taskDefinitionArn)
  })

  it('refuses mounts rather than booting a container with no bundle', async () => {
    // Fargate has no bind mounts. Failing loudly beats a run that starts and finds nothing.
    const ecs = fakeEcs([])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client })
    await expect(
      runner.start({
        runId: 'r',
        image: 'i',
        args: [],
        mounts: [{ source: '/a', target: '/b' }],
      }),
    ).rejects.toThrow(/no bind mounts/)
  })

  it('surfaces a RunTask refusal instead of returning a handle to nothing', async () => {
    const ecs = fakeEcs([{ failures: [{ reason: 'RESOURCE:MEMORY', detail: 'no capacity' }] }])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client })
    await expect(runner.start({ runId: 'r', image: 'i', args: [] })).rejects.toThrow(
      /RESOURCE:MEMORY.*no capacity/s,
    )
  })
})

describe('FargateRunner outcome', () => {
  it('polls until STOPPED and reports the exit code', async () => {
    const ecs = fakeEcs([{ tasks: [{ taskArn: 'arn:1' }] }, RUNNING, RUNNING, stopped(0)])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client, pollIntervalMs: 1 })
    const outcome = await (await runner.start({ runId: 'r', image: 'i', args: [] })).outcome
    expect(outcome).toMatchObject({ runId: 'r', exitCode: 0, timedOut: false })
  })

  it('reports a null exit code when ECS never gave one', async () => {
    // An OOM kill or a failed image pull has a reason but no exit code. Collapsing that to
    // -1 would make "the container failed" and "the container never ran" the same fact.
    const ecs = fakeEcs([
      { tasks: [{ taskArn: 'arn:1' }] },
      stopped(undefined, 'OutOfMemoryError: container killed'),
    ])
    const runner = new FargateRunner({ config: CONFIG, client: ecs.client, pollIntervalMs: 1 })
    const outcome = await (await runner.start({ runId: 'r', image: 'i', args: [] })).outcome
    expect(outcome.exitCode).toBeNull()
    expect(outcome.reason).toMatch(/OutOfMemoryError/)
  })

  it('stops a task that outlives its wall clock, since ECS has no task timeout', async () => {
    let clock = 0
    const ecs = fakeEcs([{ tasks: [{ taskArn: 'arn:1' }] }, RUNNING, {}, stopped(137, 'stopped')])
    const runner = new FargateRunner({
      config: CONFIG,
      client: ecs.client,
      pollIntervalMs: 1,
      now: () => (clock += 1000),
    })
    const outcome = await (
      await runner.start({ runId: 'r', image: 'i', args: [], timeoutSec: 1 })
    ).outcome
    expect(outcome.timedOut).toBe(true)
    expect(ecs.sent.some((input) => 'task' in input && 'reason' in input)).toBe(true)
  })
})

describe('FargateRunner.stop', () => {
  it('swallows a failure, because a task already gone is the outcome asked for', async () => {
    const runner = new FargateRunner({
      config: CONFIG,
      client: {
        send: async () => {
          throw new Error('InvalidParameterException: task not found')
        },
      } as never,
    })
    await expect(runner.stop('arn:gone')).resolves.toBeUndefined()
  })
})

describe('loadAwsConfig', () => {
  const page = (params: Array<[string, string]>) => ({
    Parameters: params.map(([Name, Value]) => ({ Name, Value })),
  })

  it('names the missing parameter rather than surfacing ParameterNotFound', async () => {
    const client = { send: async () => page([['/intellidev/dev/network/vpc-id', 'vpc-1']]) }
    await expect(
      loadAwsConfig({ env: 'dev', region: 'ap-south-1', client: client as never }),
    ).rejects.toThrow(/runtime\/cluster-name/)
  })

  it('splits StringList parameters, which SSM returns comma-joined', async () => {
    const client = {
      send: async () =>
        page([
          ['/intellidev/dev/runtime/cluster-name', 'c'],
          ['/intellidev/dev/runtime/run-task-definition-arn', 'arn:td'],
          ['/intellidev/dev/runtime/run-container-name', 'adapter'],
          ['/intellidev/dev/network/public-subnet-ids', 'subnet-a,subnet-b'],
          ['/intellidev/dev/network/run-task-security-group-id', 'sg-1'],
          ['/intellidev/dev/artifacts/bucket', 'bkt'],
          ['/intellidev/dev/runtime/task-events-queue-url', 'https://sqs/q'],
        ]),
    }
    const config = await loadAwsConfig({
      env: 'dev',
      region: 'ap-south-1',
      client: client as never,
    })
    expect(config.subnetIds).toEqual(['subnet-a', 'subnet-b'])
    expect(config.securityGroupIds).toEqual(['sg-1'])
  })

  const COMPLETE: Array<[string, string]> = [
    ['/intellidev/dev/runtime/cluster-name', 'c'],
    ['/intellidev/dev/runtime/run-task-definition-arn', 'arn:td'],
    ['/intellidev/dev/runtime/run-container-name', 'adapter'],
    ['/intellidev/dev/network/public-subnet-ids', 'subnet-a'],
    ['/intellidev/dev/network/run-task-security-group-id', 'sg-1'],
    ['/intellidev/dev/artifacts/bucket', 'bkt'],
    ['/intellidev/dev/runtime/task-events-queue-url', 'https://sqs/q'],
  ]

  it('collects bundles per project, so two projects cannot share one', async () => {
    const client = {
      send: async () =>
        page([
          ...COMPLETE,
          ['/intellidev/dev/bundle/acme/key', 'bundles/acme/aa.tar.gz'],
          ['/intellidev/dev/bundle/acme/digest', 'sha256:aa'],
          ['/intellidev/dev/bundle/other/key', 'bundles/other/bb.tar.gz'],
          ['/intellidev/dev/bundle/other/digest', 'sha256:bb'],
        ]),
    }
    const config = await loadAwsConfig({ env: 'dev', region: 'r', client: client as never })
    expect(config.bundles['acme']).toEqual({
      key: 'bundles/acme/aa.tar.gz',
      digest: 'sha256:aa',
    })
    expect(config.bundles['other']?.digest).toBe('sha256:bb')
  })

  it('rejects half a bundle reference', async () => {
    // Worse than none: dispatch would build a spec naming an object with no digest to
    // verify it against, and the run would extract whatever the URL served.
    const client = {
      send: async () => page([...COMPLETE, ['/intellidev/dev/bundle/acme/key', 'k']]),
    }
    await expect(
      loadAwsConfig({ env: 'dev', region: 'r', client: client as never }),
    ).rejects.toThrow(/incomplete/)
  })

  it('allows a project with no bundle yet, rather than blocking every other project', async () => {
    const client = { send: async () => page(COMPLETE) }
    const config = await loadAwsConfig({ env: 'dev', region: 'r', client: client as never })
    expect(config.bundles).toEqual({})
  })
})
