import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface RegistryStackProps extends StackProps {
  readonly environment: EnvironmentConfig
}

/**
 * The registry for the golden image.
 *
 * **One repository per environment, not per project.** Everything else in this system is
 * scoped by project, so the exception is worth stating: there is exactly one golden image
 * for every project, because a project is a manifest fetched at boot rather than a baked
 * layer. That is what makes onboarding a project a database row instead of an image build,
 * and a per-project repository would quietly undo it.
 *
 * The digest is deliberately **not** managed here. CDK cannot know it at synth time, and a
 * parameter CDK owned would be reset to a stale value on the next deploy. `push-image.sh`
 * writes it; `destroy.sh` cleans it up so the teardown stays complete.
 */
export class RegistryStack extends Stack {
  readonly repository: ecr.Repository

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props)
    const env = props.environment

    this.repository = new ecr.Repository(this, 'Runner', {
      repositoryName: resourceName(env.name, 'runner'),
      // Basic scanning is free, and a 1.5 GB image with three vendored harnesses is
      // exactly the kind of thing worth having scanned.
      imageScanOnPush: true,
      // Tags stay mutable so a rebuild at the same commit does not need a new tag. What
      // enforces "rollback is a digest change" is that nothing *references* a tag — see
      // the test asserting the recorded reference is a digest.
      imageTagMutability: ecr.TagMutability.MUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      // Keeps `cdk destroy` genuinely clean, which is the property every phase so far has
      // been held to. Safe here because the image is rebuildable from the Dockerfile.
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          description: 'Expire untagged images quickly; they are rebuild garbage.',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: Duration.days(7),
          rulePriority: 1,
        },
        {
          description: 'Keep the last 10 tagged images, so rollback has somewhere to go.',
          tagStatus: ecr.TagStatus.ANY,
          maxImageCount: 10,
          rulePriority: 2,
        },
      ],
    })

    new ssm.StringParameter(this, 'RepositoryUriParam', {
      parameterName: ssmPath(env.name, 'runner', 'repository-uri'),
      stringValue: this.repository.repositoryUri,
      description: 'ECR repository for the golden image. Reference images by digest.',
    })
    new ssm.StringParameter(this, 'ArchitectureParam', {
      parameterName: ssmPath(env.name, 'runner', 'architecture'),
      stringValue: env.architecture,
      description: 'CPU architecture run tasks must use. Must match the pushed image.',
    })
  }
}
