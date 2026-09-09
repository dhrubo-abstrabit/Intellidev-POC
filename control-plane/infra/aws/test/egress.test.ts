import { describe, expect, it } from 'vitest'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'
import { ssmPath } from '../lib/naming.js'

const ACCOUNT = '111111111111'

function templates() {
  const { network, runtime, smoke } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
  return {
    network: Template.fromStack(network),
    runtime: Template.fromStack(runtime),
    smoke: Template.fromStack(smoke),
  }
}

describe('reaching the internet without paying for idle', () => {
  it('routes S3 through a free gateway endpoint', () => {
    const endpoints = templates().network.findResources('AWS::EC2::VPCEndpoint')
    const [endpoint] = Object.values(endpoints)
    expect(endpoint?.['Properties']?.['VpcEndpointType']).toBe('Gateway')
    // The service name renders as an Fn::Join around the region token, so match the
    // assembled string rather than a literal.
    expect(JSON.stringify(endpoint?.['Properties']?.['ServiceName'])).toContain('.s3')
  })

  it('attaches the endpoint to both subnet tiers', () => {
    // One route table per subnet, so all four must be associated — otherwise the isolated
    // tier silently has no path to S3 at all, and the public tier pays for data transfer.
    const endpoints = templates().network.findResources('AWS::EC2::VPCEndpoint')
    const [endpoint] = Object.values(endpoints)
    expect(endpoint?.['Properties']?.['RouteTableIds']).toHaveLength(4)
  })

  // An interface endpoint bills roughly $7/month per AZ, every month, running or not. A
  // task in a public subnet already reaches ECR and CloudWatch over the internet for free,
  // so one appearing here means somebody added an idle cost by reflex.
  it('adds no interface endpoints', () => {
    const endpoints = templates().network.findResources('AWS::EC2::VPCEndpoint')
    for (const endpoint of Object.values(endpoints)) {
      expect(endpoint['Properties']?.['VpcEndpointType']).not.toBe('Interface')
    }
  })

  it('still has no NAT gateway once the endpoint and cluster exist', () => {
    const { network, smoke } = templates()
    network.resourceCountIs('AWS::EC2::NatGateway', 0)
    smoke.resourceCountIs('AWS::EC2::NatGateway', 0)
  })
})

describe('the egress allowlist', () => {
  it('gives run tasks no inbound rules at all', () => {
    // The adapter dials out. Nothing should ever connect *to* a run.
    const groups = templates().network.findResources('AWS::EC2::SecurityGroup')
    const runTask = Object.values(groups).find((g) =>
      String(g['Properties']?.['GroupDescription']).includes('Run tasks'),
    )
    expect(runTask).toBeDefined()
    expect(runTask?.['Properties']?.['SecurityGroupIngress']).toBeUndefined()
  })

  it('permits only HTTPS and DNS outbound', () => {
    const groups = templates().network.findResources('AWS::EC2::SecurityGroup')
    const runTask = Object.values(groups).find((g) =>
      String(g['Properties']?.['GroupDescription']).includes('Run tasks'),
    )
    const egress = (runTask?.['Properties']?.['SecurityGroupEgress'] ?? []) as Array<
      Record<string, unknown>
    >
    expect(egress.length).toBeGreaterThan(0)
    // CDK's default is a single allow-all rule, which would make the group decorative.
    for (const rule of egress) {
      expect(rule['IpProtocol']).not.toBe('-1')
      expect([443, 53]).toContain(rule['FromPort'])
    }
    // Numeric sort: the default is lexicographic, which orders 443 before 53.
    const ports = egress.map((r) => Number(r['FromPort'])).sort((a, b) => a - b)
    expect(ports).toEqual([53, 53, 443])
  })
})

describe('the egress proof', () => {
  it('runs a real container, not a template assertion', () => {
    const { runtime, smoke } = templates()
    // One cluster, in the runtime stack, shared with real runs — so there is one place to
    // look for tasks and the probe exercises the same permissions a run does.
    runtime.resourceCountIs('AWS::ECS::Cluster', 1)
    smoke.resourceCountIs('AWS::ECS::Cluster', 0)
    smoke.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
    })
  })

  it('fails the task if any single check fails', () => {
    // Without `set -e` a failed clone still exits 0, and the smoke test would report
    // success while the network was broken.
    const { smoke } = templates()
    const defs = smoke.findResources('AWS::ECS::TaskDefinition')
    const command = JSON.stringify(Object.values(defs)[0]?.['Properties']?.['ContainerDefinitions'])
    expect(command).toContain('set -e')
    expect(command).toContain('EGRESS_SMOKE_OK')
    expect(command).toContain('git clone')
  })

  it('grants no wildcard resource except where AWS makes it impossible to scope', () => {
    // A blanket "no Resource: *" assertion is too blunt: ecr:GetAuthorizationToken mints a
    // registry-wide token and AWS models it as an account-level action, so it genuinely
    // cannot be scoped. Every *other* wildcard is a mistake, and this is what catches one.
    const UNSCOPEABLE = new Set(['ecr:GetAuthorizationToken'])
    const { runtime, smoke } = templates()
    const policies = {
      ...runtime.findResources('AWS::IAM::Policy'),
      ...smoke.findResources('AWS::IAM::Policy'),
    }

    for (const policy of Object.values(policies)) {
      const statements = (policy['Properties']?.['PolicyDocument']?.['Statement'] ?? []) as Array<
        Record<string, unknown>
      >
      for (const statement of statements) {
        const resources = [statement['Resource']].flat()
        if (!resources.includes('*')) continue
        const actions = [statement['Action']].flat().filter((a) => typeof a === 'string')
        for (const action of actions) {
          expect(UNSCOPEABLE, `unscoped wildcard on ${String(action)}`).toContain(action)
        }
      }
    }
  })

  it('scopes the probe task role to exactly one bucket', () => {
    const { smoke } = templates()
    const rendered = JSON.stringify(Object.values(smoke.findResources('AWS::IAM::Policy')))
    expect(rendered).toContain('s3:GetObject')
    // The bucket ARN arrives as a Fn::GetAtt, which is what a scoped grant looks like.
    expect(rendered).toContain('SmokeBucket')
  })

  it('gives ECS a pull-and-log role that is not the run identity', () => {
    // The plan calls for three separate roles; this is the execution role, which acts
    // before any of our code exists and so must not be able to do what a run can.
    const { runtime } = templates()
    const rendered = JSON.stringify(runtime.findResources('AWS::IAM::Policy'))
    expect(rendered).toContain('ecr:BatchGetImage')
    expect(rendered).toContain('logs:PutLogEvents')
    runtime.hasResourceProperties('AWS::IAM::Role', {
      Description: Match.stringLikeRegexp('Not the run identity'),
    })
  })

  it('publishes what the smoke script needs to SSM', () => {
    const { runtime, smoke } = templates()
    runtime.hasResourceProperties('AWS::SSM::Parameter', {
      Name: ssmPath('dev', 'runtime', 'cluster-name'),
    })
    for (const path of [
      ssmPath('dev', 'smoke', 'task-definition-arn'),
      ssmPath('dev', 'smoke', 'bucket'),
    ]) {
      smoke.hasResourceProperties('AWS::SSM::Parameter', { Name: path })
    }
  })
})
