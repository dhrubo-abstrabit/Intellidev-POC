import { describe, expect, it } from 'vitest'
import { App, Aspects } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { CfnNatGateway } from 'aws-cdk-lib/aws-ec2'
import { buildApp } from '../lib/build-app.js'
import { ENVIRONMENTS, resolveEnvironment } from '../lib/config.js'
import { NoNatGateways } from '../lib/no-nat-aspect.js'
import { resourceName, ssmPath, stackName } from '../lib/naming.js'

const ACCOUNT = '111111111111'

function devTemplate(): Template {
  const { network } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
  return Template.fromStack(network)
}

describe('cost guardrails', () => {
  // The reason this file exists. A NAT gateway bills hourly whether or not a run happens,
  // so it is the single cheapest way to lose scale-to-zero — and `ec2.Vpc` creates one per
  // AZ unless told otherwise.
  it('synthesises no NAT gateway', () => {
    devTemplate().resourceCountIs('AWS::EC2::NatGateway', 0)
  })

  it('synthesises no Elastic IP', () => {
    devTemplate().resourceCountIs('AWS::EC2::EIP', 0)
  })

  // Without this the aspect could silently become a no-op — a guardrail that never fires
  // is indistinguishable from one that is broken.
  it('the aspect fails synth when a NAT gateway is added', () => {
    const { app, network } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    new CfnNatGateway(network, 'SneakyNat', {
      subnetId: network.vpc.publicSubnets[0]!.subnetId,
    })
    expect(() => app.synth({ force: true })).toThrow(/NAT gateway is forbidden/)
  })

  it('the aspect is attached to the real app, not just the test', () => {
    const { app } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    const aspects = Aspects.of(app).all
    expect(aspects.some((a) => a instanceof NoNatGateways)).toBe(true)
  })
})

describe('network shape', () => {
  it('uses the CIDR from config, not a literal', () => {
    devTemplate().hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: ENVIRONMENTS.dev.cidr,
    })
  })

  it('creates one public and one isolated subnet per AZ', () => {
    const t = devTemplate()
    t.resourceCountIs('AWS::EC2::Subnet', ENVIRONMENTS.dev.azCount * 2)
    // An internet gateway is how the public tier reaches the internet without a NAT.
    t.resourceCountIs('AWS::EC2::InternetGateway', 1)
  })

  it('does not hand a public IP to everything landing in a public subnet', () => {
    // assignPublicIp is a per-task decision at RunTask time, not a subnet-wide default.
    const subnets = devTemplate().findResources('AWS::EC2::Subnet')
    for (const subnet of Object.values(subnets)) {
      expect(subnet['Properties']?.['MapPublicIpOnLaunch']).not.toBe(true)
    }
  })

  it('names the VPC through naming.ts', () => {
    devTemplate().hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([{ Key: 'Name', Value: resourceName('dev', 'vpc') }]),
    })
  })
})

describe('the infrastructure-to-application seam', () => {
  // The control plane learns the vpc and subnet ids from this prefix at boot. If these
  // paths move, application config breaks — so they are asserted, not assumed.
  it('publishes the vpc id to SSM', () => {
    devTemplate().hasResourceProperties('AWS::SSM::Parameter', {
      Name: ssmPath('dev', 'network', 'vpc-id'),
      Type: 'String',
    })
  })

  it('publishes both subnet tiers to SSM', () => {
    const t = devTemplate()
    for (const key of ['public-subnet-ids', 'isolated-subnet-ids']) {
      t.hasResourceProperties('AWS::SSM::Parameter', {
        Name: ssmPath('dev', 'network', key),
        Type: 'StringList',
      })
    }
  })
})

describe('tagging', () => {
  it('tags every taggable resource, so nothing hand-made can hide', () => {
    devTemplate().hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([
        { Key: 'intellidev:app', Value: 'intellidev' },
        { Key: 'intellidev:env', Value: 'dev' },
        { Key: 'intellidev:managed-by', Value: 'cdk' },
      ]),
    })
  })
})

describe('environment resolution', () => {
  it('defaults to dev and takes the account from the session', () => {
    const { config, account } = resolveEnvironment(undefined, ACCOUNT)
    expect(config.name).toBe('dev')
    expect(account).toBe(ACCOUNT)
  })

  it('pins the region in config so AWS_REGION cannot move an environment', () => {
    expect(ENVIRONMENTS.dev.region).toBe('ap-south-1')
    expect(resolveEnvironment('dev', ACCOUNT).config.region).toBe('ap-south-1')
  })

  it('rejects an unknown environment name', () => {
    expect(() => resolveEnvironment('staging', ACCOUNT)).toThrow(/unknown environment/)
  })

  it('refuses to synth without any account', () => {
    expect(() => resolveEnvironment('dev', undefined)).toThrow(/no AWS account resolved/)
  })

  // prod is the one that must never land somewhere by accident.
  it('refuses prod unless the account is passed explicitly', () => {
    expect(() => resolveEnvironment('prod', ACCOUNT)).toThrow(/requires the account/)
  })

  it('refuses prod when the session is a different account', () => {
    expect(() => resolveEnvironment('prod', ACCOUNT, '222222222222')).toThrow(/refusing to synth/)
  })

  it('allows prod when the session and the pin agree', () => {
    expect(resolveEnvironment('prod', ACCOUNT, ACCOUNT).config.name).toBe('prod')
  })

  it('gives dev and prod non-overlapping CIDRs', () => {
    expect(ENVIRONMENTS.dev.cidr).not.toBe(ENVIRONMENTS.prod.cidr)
  })
})

describe('naming', () => {
  it('forms stack, resource and SSM names one way only', () => {
    expect(stackName('dev', 'Network')).toBe('Intellidev-dev-Network')
    expect(resourceName('dev', 'vpc')).toBe('intellidev-dev-vpc')
    expect(ssmPath('dev', 'network', 'vpc-id')).toBe('/intellidev/dev/network/vpc-id')
  })
})
