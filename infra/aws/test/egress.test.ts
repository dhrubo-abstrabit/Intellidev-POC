import { describe, expect, it } from 'vitest'
import { Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'
import { ssmPath } from '../lib/naming.js'

const ACCOUNT = '111111111111'

function templates() {
  const { network, smoke } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
  return { network: Template.fromStack(network), smoke: Template.fromStack(smoke) }
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
    const { smoke } = templates()
    smoke.resourceCountIs('AWS::ECS::Cluster', 1)
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

  it('scopes the task role to one bucket', () => {
    const { smoke } = templates()
    const policies = smoke.findResources('AWS::IAM::Policy')
    const rendered = JSON.stringify(Object.values(policies))
    expect(rendered).toContain('s3:GetObject')
    // A wildcard resource would mean the probe could read every bucket in the account.
    expect(rendered).not.toContain('"Resource":"*"')
  })

  it('publishes what the smoke script needs to SSM', () => {
    const { smoke } = templates()
    for (const path of [
      ssmPath('dev', 'runtime', 'cluster-name'),
      ssmPath('dev', 'smoke', 'task-definition-arn'),
      ssmPath('dev', 'smoke', 'bucket'),
    ]) {
      smoke.hasResourceProperties('AWS::SSM::Parameter', { Name: path })
    }
  })
})
