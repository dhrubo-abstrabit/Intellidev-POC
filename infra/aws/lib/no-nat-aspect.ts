import { CfnEIP, CfnNatGateway } from 'aws-cdk-lib/aws-ec2'
import type { IAspect } from 'aws-cdk-lib'
import type { IConstruct } from 'constructs'

/**
 * Fails synth if a NAT gateway or Elastic IP is ever added, to any stack, in any
 * environment.
 *
 * A NAT gateway bills hourly whether or not a run happens, so a single one silently
 * deletes scale-to-zero — the property the whole runtime design rests on. E2 puts an alarm
 * on one appearing; this refuses to synth at all, which is strictly better because the fix
 * costs nothing now and a month of billing later.
 *
 * `ec2.Vpc` creates one NAT per availability zone by default, so this guards against the
 * library's default rather than against anybody's carelessness.
 *
 * **Throws rather than using `Annotations.addError`.** An error annotation only makes the
 * CDK CLI refuse to deploy; it does not fail an in-process `app.synth()`, which means the
 * rule could not be tested and would hold only as long as every path went through the CLI.
 * A hard rule should be hard.
 */
export class NoNatGateways implements IAspect {
  visit(node: IConstruct): void {
    if (node instanceof CfnNatGateway) {
      throw new Error(
        `NAT gateway is forbidden (${node.node.path}): it bills hourly and removes ` +
          'scale-to-zero. Use a public subnet with assignPublicIp plus VPC endpoints ' +
          '(architecture.md §11).',
      )
    }
    if (node instanceof CfnEIP) {
      throw new Error(
        `Elastic IP is forbidden (${node.node.path}): nothing in this design needs a ` +
          'static address, and an unattached EIP bills hourly.',
      )
    }
  }
}
