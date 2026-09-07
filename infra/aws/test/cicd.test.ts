import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Template } from 'aws-cdk-lib/assertions'
import { buildApp } from '../lib/build-app.js'

const ACCOUNT = '111111111111'
const REPO = 'ayush-abstrabit/intellidev'

function cicd(repo: string = REPO): Template {
  const { cicd: stack } = buildApp({ env: 'dev', ambientAccount: ACCOUNT, githubRepo: repo })
  if (!stack) throw new Error('the cicd stack was not built')
  return Template.fromStack(stack)
}

function trust(repo: string = REPO): Record<string, Record<string, string>> {
  const roles = Object.values(cicd(repo).findResources('AWS::IAM::Role'))
  return roles[0]?.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Condition ?? {}
}

function statements(
  repo: string = REPO,
): Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> {
  return Object.values(cicd(repo).findResources('AWS::IAM::Policy')).flatMap(
    (p) => p.Properties?.PolicyDocument?.Statement ?? [],
  )
}

/**
 * The identity GitHub Actions deploys with.
 *
 * These assertions are about the trust policy, which is the whole security boundary: a role that
 * trusts too much lets another repository deploy into this account, and one that trusts too
 * little simply fails visibly. Only the first kind is dangerous, so it is what is tested.
 */
describe('the deploy role', () => {
  it('trusts one repository, from one branch', () => {
    /**
     * The `sub` claim carries repository *and* ref. Without the ref, a workflow running from any
     * branch or a fork's pull request would satisfy the trust — meaning anyone who can open a PR
     * can deploy. That is the attack this condition exists for.
     */
    const sub = trust().StringEquals?.['token.actions.githubusercontent.com:sub']
    expect(sub).toBe(`repo:${REPO}:ref:refs/heads/main`)
    // No wildcard anywhere in it: `repo:owner/*` would trust every repository that owner has.
    expect(sub).not.toContain('*')
  })

  it('checks the audience too', () => {
    // Without it, a token minted for a different audience by another GitHub feature would be
    // accepted by this role.
    expect(trust().StringEquals?.['token.actions.githubusercontent.com:aud']).toBe(
      'sts.amazonaws.com',
    )
  })

  it('refuses a repository that is not owner/name', () => {
    // A bare `*`, or an empty half, would land in the trust policy verbatim. Failing at synth is
    // the only place this is cheap to catch.
    expect(() => cicd('*')).toThrow(/owner\/name/)
    expect(() => cicd('ayush-abstrabit')).toThrow(/owner\/name/)
    expect(() => cicd('owner/name/extra')).toThrow(/owner\/name/)
  })

  it("deploys by assuming CDK's roles rather than holding their power", () => {
    /**
     * `cdk deploy` assumes the bootstrap roles. Granting CloudFormation, S3 and IAM directly
     * instead would give CI the union of every permission every stack has ever needed — most of
     * the account — to accomplish exactly the same thing.
     */
    const assume = statements().find((s) => s.Sid === 'AssumeCdkBootstrapRoles')
    expect(assume).toBeDefined()
    expect(JSON.stringify(assume?.Resource)).toContain('cdk-hnb659fds-')
    // Nothing that would let it rewrite its own trust or mint new roles.
    const all = JSON.stringify(statements())
    expect(all).not.toContain('iam:PutRolePolicy')
    expect(all).not.toContain('iam:UpdateAssumeRolePolicy')
    expect(all).not.toContain('"*:*"')
  })

  it("can push only this environment's two images", () => {
    // A CI identity able to write any repository in the registry could replace the image another
    // environment runs.
    const push = statements().find((s) => s.Sid === 'PushRunImages')
    const resources = JSON.stringify(push?.Resource)
    expect(resources).toContain('intellidev-dev-runner')
    expect(resources).toContain('intellidev-dev-control-plane')
    expect(resources).not.toContain('repository/*')
  })

  it("can write only this environment's parameters", () => {
    // The digests it records are what the task definitions read; another environment's pointers
    // are not its business.
    const ssm = statements().find((s) => s.Sid === 'RecordImageDigests')
    expect(JSON.stringify(ssm?.Resource)).toContain('parameter/intellidev/dev/')
  })

  it('is absent unless a repository is named', () => {
    // A local `cdk synth` should neither prompt for a value nor invent a trust policy from a
    // default. There is no safe default for "who may deploy into this account".
    const { cicd: stack } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    expect(stack).toBeUndefined()
  })
})

describe('the deploy workflow', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/deploy.yml', import.meta.url),
    'utf8',
  )

  it('never separates pushing an image from deploying what pins it', () => {
    /**
     * FOUND BY DOING IT BY HAND, TWICE. `pnpm image:push` records a digest in SSM and the task
     * definition reads it at deploy time — so pushing alone leaves a run using the previous
     * image while every surface reports success. The two belong in one job.
     */
    for (const [push, stack] of [
      ['pnpm image:push', 'Intellidev-dev-Runtime'],
      ['pnpm control-plane:push', 'Intellidev-dev-ControlPlane'],
    ]) {
      const job = workflow.slice(workflow.indexOf(push!))
      expect(job).toContain(stack!)
      // And in that order: deploying before pushing pins the digest that is already there.
      expect(job.indexOf(stack!)).toBeGreaterThan(0)
    }
  })

  it('gates every deploy on the checks a pull request runs', () => {
    // A deploy that skips them is a way to ship what the suite would have caught.
    expect(workflow).toMatch(/needs:\s*(check|\[\s*changes)/)
    expect(workflow).toContain('pnpm test')
  })

  it('runs one deploy at a time', () => {
    // Two would race on the same task definition family and the same SSM digests, and the loser
    // would leave a service pointing at an image nobody chose.
    expect(workflow).toContain('group: deploy-main')
    expect(workflow).toContain('cancel-in-progress: false')
  })

  it('asks for an OIDC token and stores no key', () => {
    expect(workflow).toContain('id-token: write')
    // The failure this prevents is a long-lived credential in repository secrets.
    expect(workflow).not.toMatch(/AWS_SECRET_ACCESS_KEY|aws_access_key_id/i)
  })

  it('waits for the service to serve, not merely for CDK to return', () => {
    // A circuit-breaker rollback happens *after* CloudFormation reports success, so a deploy
    // that never became healthy would otherwise be reported as green.
    expect(workflow).toContain('/healthz')
  })

  it('never deploys its own identity', () => {
    // A role that can widen its own trust policy is not a boundary.
    expect(workflow).not.toContain('Intellidev-dev-Cicd')
  })
})
