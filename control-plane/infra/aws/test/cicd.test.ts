import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * The deploy role's trust conditions.
 *
 * Selected by name rather than by position: creating the OIDC provider through CloudFormation
 * brings a custom resource with its own role, and `roles[0]` then silently asserted against a
 * lambda's trust policy instead of the one that matters.
 */
function trust(repo: string = REPO): Record<string, Record<string, string>> {
  const role = Object.values(cicd(repo).findResources('AWS::IAM::Role')).find((r) =>
    String(r.Properties?.RoleName ?? '').includes('github-deploy'),
  )
  if (!role) throw new Error('no github-deploy role in the template')
  return role.Properties?.AssumeRolePolicyDocument?.Statement?.[0]?.Condition ?? {}
}

/**
 * The deploy role's own policy statements, and only those.
 *
 * Creating the OIDC provider through CloudFormation brings a custom resource whose lambda role
 * legitimately holds `iam:CreateOpenIDConnectProvider`. Reading every policy in the stack would
 * therefore have the privilege assertions below describe that lambda rather than the identity
 * GitHub assumes — passing or failing for reasons unrelated to what they claim.
 */
function statements(
  repo: string = REPO,
): Array<{ Sid?: string; Action?: unknown; Resource?: unknown }> {
  const template = cicd(repo)
  const roleId = Object.entries(template.findResources('AWS::IAM::Role')).find(([, r]) =>
    String(r.Properties?.RoleName ?? '').includes('github-deploy'),
  )?.[0]
  if (!roleId) throw new Error('no github-deploy role in the template')

  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) => JSON.stringify(p.Properties?.Roles ?? []).includes(roleId))
    .flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? [])
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

  it('creates the OIDC provider rather than requiring one to exist', () => {
    /**
     * FOUND BY TRYING TO DEPLOY IT. The first version imported the provider, which made it a
     * manual prerequisite — and creating one by hand needs `iam:CreateOpenIDConnectProvider`,
     * which the deploy identity does not have. The stack could not be stood up at all without
     * an administrator running a command nobody would remember later.
     *
     * Through CloudFormation the account's own execution role creates it, so the stack is
     * self-sufficient.
     */
    const resources = cicd().toJSON().Resources as Record<string, { Type: string }>
    const kinds = Object.values(resources).map((r) => r.Type)
    expect(kinds.some((t) => t.includes('OpenIdConnectProvider') || t.includes('Custom::'))).toBe(
      true,
    )
  })

  it('adopts an existing provider when told, since an account may hold only one', () => {
    // A shared account already has one, and a second would fail the whole stack.
    const arn = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`
    const { cicd: stack } = buildApp({
      env: 'dev',
      ambientAccount: ACCOUNT,
      githubRepo: REPO,
      context: { oidcProviderArn: arn },
    })
    const resources = Template.fromStack(stack!).toJSON().Resources as Record<
      string,
      { Type: string }
    >
    // Nothing creating a provider: the role trusts the one that is already there.
    expect(Object.values(resources).some((r) => r.Type.includes('OpenIdConnect'))).toBe(false)
  })

  it('is absent unless a repository is named', () => {
    // A local `cdk synth` should neither prompt for a value nor invent a trust policy from a
    // default. There is no safe default for "who may deploy into this account".
    const { cicd: stack } = buildApp({ env: 'dev', ambientAccount: ACCOUNT })
    expect(stack).toBeUndefined()
  })
})

/**
 * The deploy workflow lives in a different place depending on which repository this tree is in:
 * on its own it is `.github/workflows/deploy.yml` at the root, and vendored into the app
 * repository as a subtree it is `.github/workflows/control-plane-deploy.yml` one level further
 * up, so that an Amplify commit does not trigger a control-plane deploy.
 *
 * So search upward for either name rather than hard-coding one layout. Throwing when neither is
 * found is the point: a workflow this file cannot see is a workflow whose assertions below would
 * otherwise pass by never running.
 */
function findDeployWorkflow(): { body: string; root: string } {
  const names = ['deploy.yml', 'control-plane-deploy.yml']
  const tried: string[] = []
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (;;) {
    for (const name of names) {
      const candidate = join(dir, '.github', 'workflows', name)
      tried.push(candidate)
      // `root` is what an action sees as the repository root, which is what the paths inside
      // the workflow are resolved against.
      if (existsSync(candidate)) return { body: readFileSync(candidate, 'utf8'), root: dir }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`no deploy workflow found. Looked for:\n${tried.join('\n')}`)
}

describe('the deploy workflow', () => {
  const { body: workflow, root } = findDeployWorkflow()

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

  it('names only files that exist', () => {
    // Every one of these is read by an action rather than by a `run:` step, so a wrong path is
    // not a failing command — it is a job that dies during setup, before any install.
    const refs = [
      ...workflow.matchAll(/(node-version-file|package_json_file|cache-dependency-path):\s*(\S+)/g),
    ]
    expect(refs.length).toBeGreaterThan(0)
    for (const [, key, value] of refs) {
      expect(existsSync(join(root, value!)), `${key} -> ${value}`).toBe(true)
    }
  })

  it('points pnpm at the workspace root when that is not the repository root', () => {
    /**
     * FOUND BY READING IT AFTER VENDORING THIS TREE INTO THE APP REPOSITORY. Every job sets
     * `defaults.run.working-directory`, but that moves `run:` steps only — an action still
     * reads the repository root. There that root is a Next app with no `packageManager` field
     * and no `pnpm-lock.yaml`, so pnpm/action-setup cannot determine a version and setup-node
     * throws `Dependencies lock file is not found`. Both jobs would fail before installing
     * anything, on every control-plane change.
     */
    // Steps, not prose: the comment explaining all this in the workflow names both actions,
    // and counting those mentions is how the first version of this test failed.
    const setups = workflow.match(/^\s*- uses: pnpm\/action-setup/gm)?.length ?? 0
    const caches = workflow.match(/^\s*cache: pnpm$/gm)?.length ?? 0
    expect(setups).toBeGreaterThan(0)

    const workspace = fileURLToPath(new URL('../../..', import.meta.url))
    if (resolve(workspace) === resolve(root)) {
      // Standing alone: the workspace *is* the repository root, so both actions find what they
      // look for by default. This is the assertion that they do.
      expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(true)
      return
    }

    // Vendored: each one has to be pointed at the workspace by hand.
    expect(workflow.match(/^\s*package_json_file:/gm)?.length ?? 0).toBe(setups)
    expect(workflow.match(/^\s*cache-dependency-path:/gm)?.length ?? 0).toBe(caches)
  })
})
