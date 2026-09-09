import { Stack } from 'aws-cdk-lib'
import type { StackProps } from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.js'
import { resourceName, ssmPath } from './naming.js'

export interface CicdStackProps extends StackProps {
  readonly environment: EnvironmentConfig
  /**
   * The GitHub repository allowed to assume the deploy role, as `owner/name`.
   *
   * Required, and passed in rather than guessed. The trust policy is the entire security
   * boundary of this stack: a wrong value either locks out the pipeline or — far worse — lets
   * another repository deploy into this account. Supplied at deploy time with
   * `-c githubRepo=owner/name`, so it is a decision somebody made rather than a default nobody
   * noticed.
   */
  readonly githubRepo: string
}

/**
 * The identity GitHub Actions deploys with.
 *
 * Every deploy so far has come off a laptop, and the two most expensive mistakes in this project
 * were sequencing rather than code: an image pushed without deploying the stack that reads its
 * digest, so a run silently used the previous image; and a stack deployed while the control plane
 * held a task definition revision that no longer existed, so every dispatch failed with
 * `TaskDefinition is inactive`. Neither is possible when the four steps are one pipeline.
 *
 * **No stored credentials.** GitHub presents a short-lived OIDC token, AWS exchanges it for this
 * role, and nothing long-lived exists to leak or rotate. An access key in repository secrets is
 * the thing this design exists to avoid.
 *
 * **The role holds almost nothing itself.** CDK's modern bootstrap already has roles for
 * deploying and for publishing assets; this one is permitted to *assume* those, plus the two
 * things our own scripts do outside CDK — push an image to ECR, and record its digest in SSM.
 * A CI identity that could edit IAM or read every secret would be a far larger prize than the
 * pipeline it serves.
 */
export class CicdStack extends Stack {
  readonly deployRole: iam.Role

  constructor(scope: Construct, id: string, props: CicdStackProps) {
    super(scope, id, props)
    const env = props.environment

    /**
     * `owner/name`, each half optionally carrying `@<id>`.
     *
     * FOUND BY A DEPLOY THAT COULD NOT ASSUME THE ROLE. GitHub can issue the subject claim with
     * immutable identifiers — `repo:owner@321390717/name@1322693945:ref:...` — so that renaming
     * a repository or an organisation cannot silently hand its trust to whoever takes the old
     * name. An organisation with that on sends *only* that form, and a policy pinned to the
     * name-based form matches nothing, failing as `Not authorized to perform
     * sts:AssumeRoleWithWebIdentity`: an error that names neither the claim nor the condition.
     */
    if (!/^[\w.-]+(@\d+)?\/[\w.-]+(@\d+)?$/.test(props.githubRepo)) {
      // Thrown at synth rather than producing a trust policy nobody meant: `*` in the wrong
      // position here would trust every repository on GitHub.
      throw new Error(
        `githubRepo must look like "owner/name", optionally "owner@id/name@id", got ` +
          `"${props.githubRepo}". Pass it with -c githubRepo=owner/name.`,
      )
    }

    /**
     * Both spellings of the subject, so the trust survives that setting being toggled.
     *
     * An IAM `StringEquals` given a list matches any member, and both members are exact — no
     * wildcard, both pinned to `main`. Listing the pair costs nothing and removes the failure
     * above, which took a decoded token to diagnose because every value that can be printed
     * from the workflow's own context looks correct.
     */
    const withoutIds = props.githubRepo.replace(/@\d+/g, '')
    const subjects = [
      `repo:${props.githubRepo}:ref:refs/heads/main`,
      ...(withoutIds === props.githubRepo ? [] : [`repo:${withoutIds}:ref:refs/heads/main`]),
    ]
    // One value stays a string rather than a list of one. They mean the same thing to IAM, and
    // a list reads as though more than one thing is trusted.
    const subject = subjects.length === 1 ? subjects[0]! : subjects

    /**
     * GitHub's OIDC provider, created here unless one already exists.
     *
     * Importing it was the first attempt, and it was wrong in a way worth recording: it made the
     * provider a manual prerequisite, and creating one by hand needs
     * `iam:CreateOpenIDConnectProvider`, which the deploy identity does not have. The stack was
     * therefore undeployable without an administrator running one command first — a step nobody
     * would remember a year from now.
     *
     * Created through CloudFormation instead, the account's own execution role does it, and the
     * stack stands up on its own.
     *
     * An account may hold exactly one provider per issuer, so a second would fail. Pass
     * `-c oidcProviderArn=arn:...` to adopt an existing one rather than fight it — which is also
     * what a shared account needs, since the provider is not this stack's to own there.
     */
    const existingArn = this.node.tryGetContext('oidcProviderArn') as string | undefined
    const provider = existingArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOidc', existingArn)
      : new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          // The audience GitHub's own action requests. Without it the token is rejected before
          // any condition in the trust policy is even considered.
          clientIds: ['sts.amazonaws.com'],
        })

    /**
     * Trusted for one repository, and only from its default branch.
     *
     * `sub` carries the repository *and* the ref, so scoping to `refs/heads/main` means a pull
     * request from a fork — which runs with the same workflow file if it is on main — still
     * cannot deploy. That is the attack this condition exists for: without the ref, anyone who
     * can open a PR can run a deploy.
     *
     * `aud` is checked too. Without it, a token minted for a different audience by another
     * GitHub feature would satisfy the trust.
     */
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: resourceName(env.name, 'github-deploy'),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subject,
        },
      }),
      description: `Deploys ${env.name} from GitHub Actions in ${props.githubRepo}`,
    })

    /**
     * Assume CDK's own bootstrap roles, and nothing broader.
     *
     * This is what `cdk deploy` actually needs: it assumes the deploy role to change a stack and
     * the publishing roles to upload assets. Granting CloudFormation and S3 directly instead
     * would hand CI the union of every permission every stack has ever needed, which is most of
     * the account.
     *
     * The qualifier is the default `hnb659fds`, confirmed against
     * `/cdk-bootstrap/hnb659fds/version` in this account rather than assumed.
     */
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::${this.account}:role/cdk-hnb659fds-*-${this.account}-*`],
      }),
    )

    /**
     * Push our own images.
     *
     * The runner and control-plane images are built by scripts rather than as CDK assets, so
     * they do not travel through the publishing role above. Scoped to this environment's two
     * repositories: a CI identity able to write any repository in the registry could replace an
     * image another environment runs.
     */
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PushRunImages',
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
          'ecr:BatchGetImage',
          'ecr:DescribeImages',
          'ecr:DescribeRepositories',
        ],
        resources: [
          `arn:aws:ecr:${this.region}:${this.account}:repository/${resourceName(env.name, 'runner')}`,
          `arn:aws:ecr:${this.region}:${this.account}:repository/${resourceName(env.name, 'control-plane')}`,
        ],
      }),
    )

    // The login token is account-wide by nature: there is no per-repository form of it.
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AuthenticateToRegistry',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    )

    /**
     * Record which image was pushed.
     *
     * The task definitions read these at deploy time, which is the coupling that made a
     * push-without-deploy silently use the previous image. Confined to this environment's own
     * prefix so CI cannot rewrite another environment's pointers.
     */
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RecordImageDigests',
        actions: [
          'ssm:PutParameter',
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:AddTagsToResource',
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/intellidev/${env.name}/*`,
        ],
      }),
    )

    new ssm.StringParameter(this, 'ParamDeployRoleArn', {
      parameterName: ssmPath(env.name, 'cicd', 'deploy-role-arn'),
      stringValue: this.deployRole.roleArn,
      description: 'Role GitHub Actions assumes to deploy this environment',
    })
  }
}
