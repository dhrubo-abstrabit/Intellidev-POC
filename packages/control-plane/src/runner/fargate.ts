import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs'
import type { Task } from '@aws-sdk/client-ecs'
import type { RunHandle, Runner, RunLaunchSpec, RunOutcome } from '@intellidev/adapter'
import type { AwsRuntimeConfig } from '../aws/config.js'

/**
 * Launches a run as an ECS Fargate task.
 *
 * Lives in the control plane rather than beside `DockerRunner` in the adapter, despite
 * implementing the same interface: the adapter package is bundled into the golden image,
 * and the adapter never calls `RunTask`. Shipping an ECS client inside a 1.5 GB run image
 * would grow every image for code that only ever executes here.
 *
 * **One task definition for every project.** Nothing project-specific is baked into it;
 * env and command arrive as `RunTask` overrides. That is what keeps onboarding a project a
 * database row rather than an infrastructure change.
 */
export interface FargateRunnerOptions {
  readonly config: AwsRuntimeConfig
  readonly client?: Pick<ECSClient, 'send'>
  /** How often to ask ECS whether the task ended. Overridden in tests. */
  readonly pollIntervalMs?: number
  readonly now?: () => number
}

export class FargateRunner implements Runner {
  readonly kind = 'fargate' as const
  private readonly client: Pick<ECSClient, 'send'>

  constructor(private readonly opts: FargateRunnerOptions) {
    this.client = opts.client ?? new ECSClient({ region: opts.config.region })
  }

  async start(spec: RunLaunchSpec): Promise<RunHandle> {
    const config = this.opts.config

    if (spec.mounts?.length || spec.cacheVolume) {
      // Failing loudly beats booting a container whose bundle silently is not there. C2
      // replaces both with S3 objects; until then this is a programming error, not a
      // runtime condition.
      throw new Error(
        'FargateRunner cannot honour mounts or a cache volume — Fargate has no bind mounts. ' +
          'The run spec and bundle must come from S3 (C2).',
      )
    }

    const command = new RunTaskCommand({
      cluster: config.clusterName,
      taskDefinition: config.taskDefinitionArn,
      launchType: 'FARGATE',
      count: 1,
      // Idempotency keyed on runId, so a retried call after a throttle or a socket timeout
      // cannot launch a second container for one run. AWS holds these for hours.
      clientToken: `run-${spec.runId}`,
      // Tagged so a stray task can be attributed to a run without reading its logs, and so
      // E3 can attribute cost per project.
      tags: [
        { key: 'intellidev:run-id', value: spec.runId },
        { key: 'intellidev:env', value: config.env },
      ],
      propagateTags: 'TASK_DEFINITION',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: [...config.subnetIds],
          securityGroups: [...config.securityGroupIds],
          // What replaces the NAT gateway. Without it the task has no route out at all.
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: config.containerName,
            command: [...spec.args],
            environment: Object.entries(spec.env ?? {}).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
    })

    spec.onArgv?.([
      'aws',
      'ecs',
      'run-task',
      '--cluster',
      config.clusterName,
      '--task-definition',
      config.taskDefinitionArn,
      '--overrides',
      JSON.stringify({ command: spec.args }),
    ])

    const response = await this.client.send(command)

    const failure = response.failures?.[0]
    if (failure) {
      throw new Error(
        `RunTask refused for ${spec.runId}: ${failure.reason ?? 'unknown'}` +
          (failure.detail ? ` (${failure.detail})` : ''),
      )
    }

    const arn = response.tasks?.[0]?.taskArn
    if (!arn) throw new Error(`RunTask returned no task ARN for ${spec.runId}`)

    return {
      runId: spec.runId,
      handle: arn,
      outcome: this.observe(spec, arn),
    }
  }

  /**
   * Waits for the task to reach STOPPED.
   *
   * Deliberately the weakest part of this class, and the reason C5 exists. Polling holds
   * the observer in this process, so a control-plane restart loses it and the run needs
   * reconciling; and a task that dies between polls is only noticed on the next one. C5
   * replaces this with `run.finished` as the primary signal plus an EventBridge rule for
   * the deaths nothing reports.
   */
  private async observe(spec: RunLaunchSpec, arn: string): Promise<RunOutcome> {
    const interval = this.opts.pollIntervalMs ?? 5_000
    const now = this.opts.now ?? (() => Date.now())
    const deadline = spec.timeoutSec ? now() + spec.timeoutSec * 1000 : Infinity
    let timedOut = false

    for (;;) {
      const task = await this.describe(arn)

      if (task?.lastStatus === 'STOPPED') {
        const container = task.containers?.find((c) => c.name === this.opts.config.containerName)
        return {
          runId: spec.runId,
          // Null rather than -1 when ECS reports none: an OOM kill or a failed image pull
          // has a reason but no exit code, and collapsing the two hides which happened.
          exitCode: container?.exitCode ?? null,
          timedOut,
          ...(task.stoppedReason ? { reason: task.stoppedReason } : {}),
        }
      }

      if (now() >= deadline && !timedOut) {
        // ECS has no task timeout of its own, so the ceiling is ours to enforce. E1 moves
        // this to a swept, out-of-process check; here it at least bounds a hung run.
        timedOut = true
        await this.stop(arn)
      }

      await new Promise((resolve) => setTimeout(resolve, interval))
    }
  }

  private async describe(arn: string): Promise<Task | undefined> {
    const response = await this.client.send(
      new DescribeTasksCommand({ cluster: this.opts.config.clusterName, tasks: [arn] }),
    )
    return response.tasks?.[0]
  }

  async stop(handle: string): Promise<void> {
    try {
      await this.client.send(
        new StopTaskCommand({
          cluster: this.opts.config.clusterName,
          task: handle,
          reason: 'stopped by the control plane',
        }),
      )
    } catch {
      // Best effort by contract: a task that has already stopped, or one reaped while the
      // call was in flight, is the outcome the caller wanted. Throwing here would turn a
      // successful cancel into a visible error.
    }
  }
}
