import { describe, expect, it } from 'vitest'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'

const ACCOUNT = '111111111111'

/**
 * Built once.
 *
 * Synthesising the whole app takes about a second, and every assertion here reads the same
 * immutable template — rebuilding per test turned a fast file into a slow one for no isolation
 * benefit, since nothing mutates it.
 */
let cached: Template | undefined
function template(): Template {
  if (!cached) {
    const { controlPlane } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    cached = Template.fromStack(controlPlane)
  }
  return cached
}

/**
 * The hosted control plane.
 *
 * These assertions are about the settings that are wrong by default and fail in ways that look
 * like something else — a stream that dies at sixty seconds reads as the run stalling, a
 * five-minute drain reads as a slow deploy, a missing `PassRole` reads as the runner being
 * broken. None of them is visible in a template review; all of them cost an afternoon.
 */
describe('the control plane service', () => {
  it('holds an event stream far longer than the sixty-second default', () => {
    // A run can be quiet for minutes between events. At the default the balancer cuts the SSE
    // connection and a user sees a run that stopped reporting, not a network fault.
    template().hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([
        Match.objectLike({ Key: 'idle_timeout.timeout_seconds', Value: '900' }),
      ]),
    })
  })

  it('drains in seconds rather than the five-minute default', () => {
    // Otherwise every deploy waits out a delay that exists for connections this application has
    // already closed.
    template().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetGroupAttributes: Match.arrayWith([
        Match.objectLike({ Key: 'deregistration_delay.timeout_seconds', Value: '30' }),
      ]),
    })
  })

  it('health-checks the path that checks the database', () => {
    // `/healthz` asks whether this instance can reach Postgres. Checking `/` instead would keep
    // an instance in the pool that accepts requests and fails all of them.
    template().hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/healthz',
    })
  })

  it('serves HTTPS and redirects HTTP rather than answering it', () => {
    const t = template()
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    })
    // Serving anything on 80 would let a client that got the scheme wrong send a run token in
    // the clear.
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: Match.arrayWith([
        Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Port: '443' }) }),
      ]),
    })
  })

  it('reaches the task only from the load balancer', () => {
    // The task has a public IP because there is no NAT gateway; the security group is what stops
    // that from meaning "reachable from the internet".
    const groups = template().findResources('AWS::EC2::SecurityGroupIngress')
    const toTask = Object.values(groups).filter((g) => g.Properties?.ToPort === 4000)
    expect(toTask.length).toBeGreaterThan(0)
    for (const rule of toTask) {
      expect(rule.Properties?.CidrIp).toBeUndefined()
      expect(rule.Properties?.SourceSecurityGroupId).toBeDefined()
    }
  })

  it('can hand the run roles to the tasks it starts', () => {
    // `ecs:RunTask` alone is not enough: starting a task that assumes a role needs `iam:PassRole`
    // for that role, and without it every dispatch fails with an IAM error naming neither.
    const policies = template().findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties?.PolicyDocument?.Statement ?? [],
    )
    const passRole = statements.find((s: { Sid?: string }) => s.Sid === 'PassRunRoles')
    expect(passRole).toBeDefined()
    // Scoped to the run roles, so this cannot start a task as something more privileged.
    expect(passRole.Resource).not.toBe('*')
    expect(passRole.Condition?.StringEquals?.['iam:PassedToService']).toBe(
      'ecs-tasks.amazonaws.com',
    )
  })

  it('runs tasks only in the run cluster', () => {
    const policies = template().findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (p) => p.Properties?.PolicyDocument?.Statement ?? [],
    )
    const runTask = statements.find((s: { Sid?: string }) => s.Sid === 'StartAndObserveRuns')
    // The resource has to be `*` — ECS does not support resource-level permissions for RunTask
    // in the way one would hope — so the cluster condition is what bounds it.
    expect(runTask?.Condition?.ArnEquals?.['ecs:cluster']).toBeDefined()
    // Tagging is part of starting a task here: the runner labels each one with its run id, and
    // without this permission RunTask fails before a container exists, so there is nothing to
    // inspect and the error names only the missing action.
    expect(runTask?.Action).toContain('ecs:TagResource')
  })

  it('takes its secrets from Secrets Manager, never from the template', () => {
    const t = template()
    const defs = Object.values(t.findResources('AWS::ECS::TaskDefinition'))
    const container = defs[0]?.Properties?.ContainerDefinitions?.[0]
    const names = (container?.Secrets ?? []).map((s: { Name: string }) => s.Name)
    expect(names).toContain('GITHUB_APP_PRIVATE_KEY')
    // The key is a secret; the id is not, so it comes from SSM as plain environment. Both are
    // required — `gitHubAppFromEnv` returns undefined if either is missing.
    expect(names).toContain('SUPABASE_CONNECTION_STRING_SESSION')

    // And no value leaked into plain environment. A template is readable to anyone with
    // cloudformation:GetTemplate and ends up in cdk.out on whichever machine deployed.
    const environment = JSON.stringify(container?.Environment ?? [])
    expect(environment).not.toContain('BEGIN')
    expect(environment).not.toContain('postgresql://')
  })

  it('passes every variable the process refuses to start without', () => {
    /**
     * FOUND BY DEPLOYING IT. The first deploy rolled back on the circuit breaker because the
     * task exited 1 at boot — twice, for two different missing pieces. The task definition is
     * the only place these can come from, and nothing else notices they are absent until a
     * container has already been started and killed.
     *
     * `INTELLIDEV_PROJECT_ID` because a database-backed store refuses to guess one, and
     * `SUPABASE_URL` because its absence means "no authentication is possible" — which on a
     * public load balancer would leave the API open rather than merely broken.
     */
    const defs = Object.values(template().findResources('AWS::ECS::TaskDefinition'))
    const environment = defs[0]?.Properties?.ContainerDefinitions?.[0]?.Environment ?? []
    const names = environment.map((e: { Name: string }) => e.Name)
    for (const required of [
      'INTELLIDEV_ENV',
      'INTELLIDEV_MODE',
      'INTELLIDEV_PROJECT_ID',
      'INTELLIDEV_PUBLIC_URL',
      'INTELLIDEV_BIND_HOST',
      'SUPABASE_URL',
      'AWS_REGION',
      // Both halves of the App, or it is silently not configured and every push fails at the
      // very end of a run that did all its work first.
      'GITHUB_APP_ID',
      // Without this the process seals credentials with a passphrase from the source rather
      // than with KMS — it would still work, which is exactly why nothing else catches it.
      'INTELLIDEV_CREDENTIAL_KEY_ARN',
    ]) {
      expect(names).toContain(required)
    }
  })

  it('rolls back a deploy that never becomes healthy', () => {
    // Without the circuit breaker a bad image cycles tasks until someone notices.
    template().hasResourceProperties('AWS::ECS::Service', {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    })
  })
})
