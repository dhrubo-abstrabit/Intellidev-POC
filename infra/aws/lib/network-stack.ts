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
  readonly runTaskSecurityGroup: ec2.SecurityGroup
  readonly s3Endpoint: ec2.GatewayVpcEndpoint

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

    /**
     * S3 over a **gateway** endpoint, which is free and has no idle cost.
     *
     * Interface endpoints are deliberately absent: each one bills ~$7/month per AZ, and a
     * task in a public subnet with a public IP already reaches ECR, CloudWatch and the
     * model APIs over the internet for nothing. S3 gets an endpoint anyway because it is
     * the one service where per-GB data transfer would otherwise be charged, and cache
     * restore moves real volume (C3).
     */
    this.s3Endpoint = this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      // Both tiers: run tasks live in public, and the isolated tier should be able to
      // reach S3 without ever acquiring a route to the internet.
      subnets: [
        { subnetType: ec2.SubnetType.PUBLIC },
        { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    })

    /**
     * The run task security group.
     *
     * This is the egress allowlist, and the reason it is worth having: enforcement lives
     * **outside the container**, where model-authored code cannot reach it. A run that is
     * compromised still cannot open a socket the group does not permit.
     *
     * `allowAllOutbound: false` is the whole point — CDK's default is an any/any egress
     * rule, which would make the group decorative.
     */
    this.runTaskSecurityGroup = new ec2.SecurityGroup(this, 'RunTaskSg', {
      vpc: this.vpc,
      securityGroupName: resourceName(env.name, 'run-task'),
      description: 'Run tasks: no inbound at all, egress limited to HTTPS and DNS.',
      allowAllOutbound: false,
    })
    // No ingress rule of any kind. The adapter dials out; nothing connects to a run.
    this.runTaskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS: git, model APIs, ECR pull, S3, CloudWatch, the control plane',
    )
    this.runTaskSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(53), 'DNS')
    this.runTaskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(53),
      'DNS over TCP, for responses that do not fit in a UDP datagram',
    )

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

    new ssm.StringParameter(this, 'RunTaskSgParam', {
      parameterName: ssmPath(env.name, 'network', 'run-task-security-group-id'),
      stringValue: this.runTaskSecurityGroup.securityGroupId,
      description: 'Egress allowlist for run tasks. No inbound rules.',
    })
    new ssm.StringParameter(this, 'S3EndpointParam', {
      parameterName: ssmPath(env.name, 'network', 's3-endpoint-id'),
      stringValue: this.s3Endpoint.vpcEndpointId,
      description: 'Gateway endpoint so S3 traffic never leaves the AWS network.',
    })

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId })
    new CfnOutput(this, 'VpcCidr', { value: this.vpc.vpcCidrBlock })
  }
}
