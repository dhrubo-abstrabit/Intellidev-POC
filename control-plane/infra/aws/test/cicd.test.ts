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

  it('trusts the immutable spelling of that repository too', () => {
    /**
     * FOUND BY A DEPLOY THAT COULD NOT ASSUME THE ROLE, THREE TIMES. GitHub can issue the
     * subject with immutable identifiers — `repo:owner@321390717/name@1322693945:ref:...` — so
     * a rename cannot hand trust to whoever claims the old name. An organisation with that
     * setting on sends *only* that form, and this policy matched nothing: `Not authorized to
     * perform sts:AssumeRoleWithWebIdentity`, which names neither the claim nor the condition
     * that rejected it. Every value printable from the workflow's own context looked right;
     * it took decoding the token to see.
     *
     * Both spellings are listed so the trust survives the setting being toggled either way.
     */
    const sub = trust('owner@321390717/name@1322693945').StringEquals?.[
      'token.actions.githubusercontent.com:sub'
    ] as unknown as string[]

    expect(sub).toEqual([
      'repo:owner@321390717/name@1322693945:ref:refs/heads/main',
      'repo:owner/name:ref:refs/heads/main',
    ])
    // An IAM condition given a list matches any member, so every member has to be as tight as
    // a single value would have been: exact, and pinned to one branch.
    for (const value of sub) {
      expect(value).not.toContain('*')
      expect(value.endsWith(':ref:refs/heads/main')).toBe(true)
    }
  })

  it('does not list a second subject when there are no identifiers to strip', () => {
    // Otherwise the name-based case would carry a duplicate, which reads like two things are
    // trusted when only one is.
    const sub = trust().StringEquals?.['token.actions.githubusercontent.com:sub']
    expect(Array.isArray(sub)).toBe(false)
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
    // Allowing `@<id>` must not have opened the door to anything else.
    expect(() => cicd('owner@*/name')).toThrow(/owner\/name/)
    expect(() => cicd('owner@abc/name')).toThrow(/owner\/name/)
    expect(() => cicd('owner@/name')).toThrow(/owner\/name/)
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
 * Find the workflow that deploys this code, wherever this tree happens to be.
 *
 * Three states, and the difference between the last two is the whole reason this is a function:
 *
 * - Vendored into the app repository as a subtree, it is
 *   `.github/workflows/control-plane-deploy.yml` at that repository's root — renamed and
 *   path-filtered so an Amplify commit does not trigger a control-plane deploy. This is the
 *   pipeline that actually deploys.
 * - Standing alone as the snapshot repository, there are no workflows at all: Actions is off
 *   there, because a push to the app repository is what should deploy. Nothing to assert, so
 *   the block below skips rather than inventing a failure.
 * - A workflows directory that exists but holds no deploy workflow is the accident — a rename
 *   or a deletion — and it throws, because assertions that never run pass.
 *
 * The search stops at the repository root rather than walking to `/`, so it can never reach up
 * and grade an unrelated project's workflow.
 */
function findDeployWorkflow(): { body: string; root: string; name: string } | undefined {
  const names = ['deploy.yml', 'control-plane-deploy.yml']
  const tried: string[] = []
  let sawWorkflowsDir = false
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (;;) {
    const workflows = join(dir, '.github', 'workflows')
    if (existsSync(workflows)) sawWorkflowsDir = true
    for (const name of names) {
      const candidate = join(workflows, name)
      tried.push(candidate)
      // `root` is what an action sees as the repository root, which is what the paths inside
      // the workflow are resolved against.
      if (existsSync(candidate)) return { body: readFileSync(candidate, 'utf8'), root: dir, name }
    }
    // `.git` marks the outermost directory belonging to this checkout.
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (sawWorkflowsDir) {
    throw new Error(`a workflows directory exists but holds no deploy workflow. Looked for:
${tried.join('\n')}`)
  }
  return undefined
}

const deployWorkflow = findDeployWorkflow()

/**
 * The workflows this project owns — the deploy workflow that was found, and the check workflow
 * named the same way.
 *
 * Derived from that name rather than from a list of candidates, because the app repository's
 * `.github/workflows` belongs to the frontend too. A frontend `ci.yml` added there later is
 * none of this file's business, and demanding control-plane path filters of it would be a
 * failure about nothing.
 */
function ourWorkflows(found: {
  root: string
  name: string
}): Array<{ name: string; body: string }> {
  const names = [found.name, found.name.replace(/deploy\.yml$/, 'ci.yml')]
  const out: Array<{ name: string; body: string }> = []
  for (const name of new Set(names)) {
    const path = join(found.root, '.github', 'workflows', name)
    if (existsSync(path)) out.push({ name, body: readFileSync(path, 'utf8') })
  }
  return out
}

/** Every entry under every `paths:` key, which is what decides whether a workflow runs at all. */
function pathFilters(body: string): string[] {
  const lines = body.split('\n')
  const out: string[] = []
  lines.forEach((line, i) => {
    if (!/^\s*paths:\s*$/.test(line)) return
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!
      if (/^\s*#/.test(next)) continue
      const item = /^\s*-\s*'([^']+)'\s*$/.exec(next)
      if (!item) break
      out.push(item[1]!)
    }
  })
  return out
}

/**
 * GitHub's filter globbing, for the two constructs these filters use: `**` crosses directory
 * separators, `*` does not. Every pattern is checked against that vocabulary first, so a
 * pattern shape this cannot represent fails loudly instead of matching by accident.
 */
function matches(file: string, pattern: string): boolean {
  expect(pattern, 'a pattern shape this matcher does not implement').toMatch(
    /^[\w./-]*(\*\*|\*)?[\w./*-]*$/,
  )
  const regex = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*')
  return new RegExp(`^${regex}$`).test(file)
}

/** The jobs of a workflow, each with the `needs:` it declares and the `needs.` it reads. */
/** Each job of a workflow, with the lines belonging to it. */
function jobBlocks(body: string): Array<{ name: string; block: string }> {
  const region = body.slice(body.indexOf('\njobs:\n'))
  const jobs: Array<{ name: string; lines: string[] }> = []
  for (const line of region.split('\n')) {
    const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header) jobs.push({ name: header[1]!, lines: [] })
    else jobs[jobs.length - 1]?.lines.push(line)
  }
  return jobs.map(({ name, lines }) => ({ name, block: lines.join('\n') }))
}

function jobDependencies(
  body: string,
): Array<{ name: string; declared: string[]; read: string[] }> {
  const region = body.slice(body.indexOf('\njobs:\n'))
  const lines = region.split('\n')
  const jobs: Array<{ name: string; declared: string[]; read: string[] }> = []
  let current: { name: string; declared: string[]; read: string[] } | undefined
  for (const line of lines) {
    const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header) {
      current = { name: header[1]!, declared: [], read: [] }
      jobs.push(current)
      continue
    }
    if (!current) continue
    const needs = /^\s*needs:\s*(.+)$/.exec(line)
    if (needs) {
      current.declared.push(
        ...needs[1]!
          .replace(/[[\]]/g, '')
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean),
      )
    }
    for (const reference of line.matchAll(/needs\.([A-Za-z0-9_-]+)/g)) {
      current.read.push(reference[1]!)
    }
  }
  return jobs
}

describe.skipIf(deployWorkflow === undefined)('the deploy workflow', () => {
  const { body: workflow, root } = deployWorkflow ?? { body: '', root: '' }

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

/**
 * What may and may not start a control-plane deploy.
 *
 * The app repository hosts a Next app that Amplify redeploys on every push to `main`. Nothing
 * about a frontend commit should push a 387 MB container image or cut a new task definition
 * revision, and nothing about a control-plane commit should depend on Amplify. The `paths:`
 * filters are the entire mechanism, so they are what is asserted — against representative
 * commits from either side rather than against the list of patterns alone, because a filter can
 * be spelled correctly and still match the wrong things.
 */
describe.skipIf(deployWorkflow === undefined)('what triggers a control-plane deploy', () => {
  const located = deployWorkflow ?? { root: '', name: '' }

  // A frontend commit: the app's source, its dependencies, its build spec, its migrations, its
  // documents. Amplify's business, none of it ours.
  const FRONTEND = [
    'src/app/page.tsx',
    'src/lib/db/database.types.ts',
    'package.json',
    'package-lock.json',
    'amplify.yml',
    'next.config.ts',
    'eslint.config.mjs',
    'tsconfig.json',
    'public/logo.svg',
    'supabase/migrations/20260904000300_extraction_debounce.sql',
    'docs/frontend/Plan.md',
  ]

  /**
   * A control-plane commit: the subtree, the runner's migrations, and the workflows themselves.
   *
   * The migrations are the interesting case since the histories were merged. Both halves' now
   * sit in `supabase/migrations/`, so the filter tells them apart by the `_runner_` in the
   * name — which means the product migration in the list above and the runner migration in
   * this one live in the same directory and must still land on opposite sides.
   */
  const CONTROL_PLANE = [
    'control-plane/packages/adapter/src/stages/shell.ts',
    'control-plane/packages/control-plane/src/server.ts',
    'control-plane/infra/docker/Dockerfile',
    'control-plane/infra/aws/lib/runtime-stack.ts',
    'supabase/migrations/20260906000000_runner_something.sql',
    'supabase/verify/contract.sql',
    '.github/workflows/control-plane-deploy.yml',
  ]

  it('runs on nothing a frontend commit touches', () => {
    const workflows = ourWorkflows(located)
    expect(workflows.length).toBeGreaterThan(0)
    for (const { name, body } of workflows) {
      const filters = pathFilters(body)
      // A workflow with no filters at all runs on everything, which is the failure being
      // prevented — assert they exist before asserting what they do.
      expect(filters.length, `${name} has no path filters`).toBeGreaterThan(0)
      for (const file of FRONTEND) {
        const matched = filters.filter((pattern) => matches(file, pattern))
        expect(matched, `${name} would run for ${file}`).toEqual([])
      }
    }
  })

  it('runs on everything a control-plane commit touches', () => {
    // The other half, and the more dangerous one to get wrong: a filter that excludes something
    // the control plane is built from means a change that silently never deploys.
    for (const { name, body } of ourWorkflows(located)) {
      const filters = pathFilters(body)
      for (const file of CONTROL_PLANE) {
        expect(
          filters.some((pattern) => matches(file, pattern)),
          `${name} would not run for ${file}`,
        ).toBe(true)
      }
    }
  })

  it('deploys every dimension on a manual run', () => {
    /**
     * `workflow_dispatch` exists so a deploy can be repeated without an empty commit, and it
     * could not: the three outputs come from a diff against the previous commit, so a dispatch
     * after a frontend-only commit reported nothing changed and skipped all three deploy jobs.
     *
     * The assertion is per output rather than on the file as a whole, because getting this
     * right for `runner` and wrong for `infra` is exactly the shape the bug had.
     */
    const deploy = ourWorkflows(located).find((w) => w.name.includes('deploy'))
    expect(deploy).toBeDefined()
    for (const output of ['runner', 'controlPlane', 'infra']) {
      const line = new RegExp(
        `${output}:[\\s\\S]{0,40}?github\\.event_name == 'workflow_dispatch' && 'true'`,
      )
      expect(deploy!.body, `${output} ignores a manual run`).toMatch(line)
    }

    // And never `outputs.x || dispatch`, which cannot work: a filter output is the string
    // 'false', truthy in a GitHub expression, so the left side always wins.
    expect(deploy!.body).not.toMatch(/steps\.filter\.outputs\.\w+\s*\|\|/)
  })

  it('waits for the service in every job that deploys it', () => {
    /**
     * FOUND BY WATCHING A DEPLOY. `infra` deploys `Intellidev-dev-ControlPlane` along with the
     * other stacks, and only the `control-plane` job waited for the service to answer. A
     * circuit-breaker rollback lands *after* CloudFormation reports success, so an infra-only
     * change that broke the service would have been reported green.
     *
     * Asserted per job rather than on the file, because a `/healthz` anywhere in it was exactly
     * what made this look covered.
     */
    for (const { name, body } of ourWorkflows(located)) {
      for (const job of jobBlocks(body)) {
        if (!/cdk deploy[\s\S]*?Intellidev-dev-ControlPlane/.test(job.block)) continue
        expect(
          job.block,
          `${name}: ${job.name} deploys the control plane without waiting`,
        ).toContain('/healthz')
      }
    }
  })

  it('never guards a job on a job it does not depend on', () => {
    /**
     * FOUND BY READING IT. The `infra` job's condition ended in
     * `needs.check.result != 'failure'` while `check` was not among its `needs` — and a
     * `needs.<job>` that is not a dependency evaluates to null, so the comparison was always
     * true. A guard that cannot fail is not a guard.
     */
    for (const { name, body } of ourWorkflows(located)) {
      for (const job of jobDependencies(body)) {
        for (const read of job.read) {
          expect(
            job.declared,
            `${name}: ${job.name} reads needs.${read} without needing it`,
          ).toContain(read)
        }
      }
    }
  })
})
