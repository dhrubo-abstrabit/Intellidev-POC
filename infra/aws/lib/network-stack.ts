import { CfnOutput, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface NetworkStackProps extends StackProps {
  readonly environment: EnvironmentConfig
}

/**
 * The VPC, and nothing else.
 *
 * A2 adds the S3 gateway endpoint, the security groups and the egress proof. What is here
 * is only what cannot be deferred: you cannot create a VPC without choosing a subnet
 * layout, and the library's default choice is one NAT gateway per availability zone.
 *
 * Two subnet tiers:
 *  - **public** for run tasks, which reach the internet via `assignPublicIp` at RunTask
 *    time rather than through a NAT gateway. `mapPublicIpOnLaunch` stays off, because that
 *    is a per-task decision and a subnet-wide default would hand a public address to
 *    anything that ever lands here.
 *  - **private isolated** for the database tier, with no route to the internet at all.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props)
    const env = props.environment

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: resourceName(env.name, 'vpc'),
      ipAddresses: ec2.IpAddresses.cidr(env.cidr),
      maxAzs: env.azCount,
      // The single most important line in this stack. See NoNatGateways.
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 20,
          mapPublicIpOnLaunch: false,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 20,
        },
      ],
    })

    // The infrastructure-to-application seam. The control plane reads this prefix at boot;
    // it never learns a vpc id or subnet id from code, an env var baked at build time, or a
    // CloudFormation call at runtime.
    new ssm.StringParameter(this, 'VpcIdParam', {
      parameterName: ssmPath(env.name, 'network', 'vpc-id'),
      stringValue: this.vpc.vpcId,
      description: 'VPC for this environment. Written by Intellidev-<env>-Network.',
    })
    new ssm.StringListParameter(this, 'PublicSubnetIdsParam', {
      parameterName: ssmPath(env.name, 'network', 'public-subnet-ids'),
      stringListValue: this.vpc.publicSubnets.map((s) => s.subnetId),
      description: 'Subnets for run tasks, which get a public IP at RunTask time.',
    })
    new ssm.StringListParameter(this, 'IsolatedSubnetIdsParam', {
      parameterName: ssmPath(env.name, 'network', 'isolated-subnet-ids'),
      stringListValue: this.vpc.isolatedSubnets.map((s) => s.subnetId),
      description: 'Subnets with no internet route, for the database tier.',
    })

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId })
    new CfnOutput(this, 'VpcCidr', { value: this.vpc.vpcCidrBlock })
  }
}
