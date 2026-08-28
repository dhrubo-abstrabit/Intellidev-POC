#!/usr/bin/env node
/**
 * A development workspace to test the runner in, under an existing tenant.
 *
 * Separate from the tenancy the product team set up, so exercising dispatch, connecting a
 * harness or wiping runner rows cannot disturb their work. Same tenant, because billing and
 * membership live there and a second tenant would be a lie about the org chart.
 *
 * Idempotent: safe to re-run. Every insert is `on conflict do update`, so this converges on
 * the intended state rather than failing or duplicating. Slugs are the natural keys.
 *
 * Also seeds two fixture users, because the interesting authorization questions need more than
 * one actor:
 *
 *  - a **space member** who is not an admin, to prove they can connect an MCP server to a
 *    project but cannot touch the space's shared harness seat or GitHub installation
 *  - an **outsider** in no space at all, to prove RLS returns nothing rather than everything
 *
 * A fixture with one admin in it passes policies that are wrong.
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY to create the fixture users (the Auth admin API). Without
 * it the tenancy is still seeded and user creation is skipped with a note, so the useful half
 * works with only a database connection.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

const OWNER_EMAIL = 'ayushj@abstrabit.com'

const WORKSPACE = { name: 'Ayush Dev', slug: 'ayush-dev' }
const SPACE = { name: 'Runner Dev', slug: 'runner-dev' }
const PROJECT = { name: 'Runner Sandbox', slug: 'runner-sandbox' }

/**
 * A second project, used only by the test suite.
 *
 * Separate because the contract tests call `truncateAll()`, which deletes every task in the
 * project they run against — and that destroyed a live Fargate run mid-flight when they shared
 * one. Tests need to be able to wipe freely; a project someone is dispatching into cannot be
 * wiped at all. One project cannot be both.
 */
const TEST_PROJECT = { name: 'Runner Tests', slug: 'runner-tests' }

/** Fixture actors. `.test` is reserved by RFC 2606, so these can never be real addresses. */
const FIXTURES = [
  {
    email: 'dev-member@intellidev.test',
    name: 'Dev Member',
    spaceRole: 'member' as const,
    // A project_members row is what makes them able to manage the *project* — connect an MCP
    // server, add a skill — while remaining unable to touch the space's shared harness seat
    // or GitHub installation. Without it they can manage nothing at all: space membership
    // alone grants reads only, because manageable_project_ids() reaches a project either
    // through a manageable space or through this row.
    projectRole: 'member' as const,
  },
  {
    email: 'dev-outsider@intellidev.test',
    name: 'Dev Outsider',
    spaceRole: null,
    projectRole: null,
  },
]

function fromEnvOrDotEnv(key: string): string | undefined {
  const direct = process.env[key]
  if (direct) return direct
  try {
    const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    return env
      .split('\n')
      .find((l) => l.trim().startsWith(`${key}=`))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

const dsn = fromEnvOrDotEnv('SUPABASE_CONNECTION_STRING_SESSION')
if (!dsn) throw new Error('SUPABASE_CONNECTION_STRING_SESSION is not set')

const serviceKey = fromEnvOrDotEnv('SUPABASE_SERVICE_ROLE_KEY')
const projectUrl = fromEnvOrDotEnv('SUPABASE_URL')

const pool = new pg.Pool({
  connectionString: dsn,
  max: 1,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})

/**
 * Creates an auth user, or returns the existing one.
 *
 * `email_confirm` is set because an unconfirmed fixture account exists but cannot sign in,
 * which is the most confusing possible half-state for something whose only purpose is to be
 * signed in as. No password is set: these are for RLS tests driven through the database, and
 * a fixture that cannot log in cannot leak.
 */
async function ensureAuthUser(email: string, fullName: string): Promise<string | undefined> {
  if (!serviceKey || !projectUrl) return undefined
  const headers = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
  }
  const listed = (await (
    await fetch(`${projectUrl}/auth/v1/admin/users?page=1&per_page=200`, { headers })
  ).json()) as { users?: Array<{ id: string; email?: string }> }
  const existing = listed.users?.find((u) => u.email?.toLowerCase() === email)
  if (existing) return existing.id

  const res = await fetch(`${projectUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, email_confirm: true, user_metadata: { full_name: fullName } }),
  })
  if (!res.ok) {
    console.log(`  ! could not create ${email}: ${res.status} ${(await res.text()).slice(0, 160)}`)
    return undefined
  }
  return ((await res.json()) as { id: string }).id
}

const client = await pool.connect()
try {
  const owner = await client.query<{ id: string }>('select id from public.users where email = $1', [
    OWNER_EMAIL,
  ])
  if (owner.rows.length === 0) {
    throw new Error(`no account for ${OWNER_EMAIL} — create it before seeding`)
  }
  const ownerId = owner.rows[0]!.id

  // The tenant they already own. Not created here: a tenant is an organisation, and inventing
  // one would misrepresent who this work belongs to.
  const tenant = await client.query<{ id: string; name: string }>(
    `select t.id, t.name from public.tenants t
      join public.tenant_members tm on tm.tenant_id = t.id
     where tm.user_id = $1 and tm.role = 'owner' order by t.created_at limit 1`,
    [ownerId],
  )
  if (tenant.rows.length === 0) throw new Error(`${OWNER_EMAIL} does not own a tenant`)
  const tenantId = tenant.rows[0]!.id
  console.log(`\n  tenant     ${tenant.rows[0]!.name}  ${tenantId}`)

  await client.query('begin')

  const ws = await client.query<{ id: string }>(
    `insert into public.workspaces (tenant_id, name, slug) values ($1, $2, $3)
     on conflict (tenant_id, slug) do update set name = excluded.name
     returning id`,
    [tenantId, WORKSPACE.name, WORKSPACE.slug],
  )
  const workspaceId = ws.rows[0]!.id
  console.log(`  workspace  ${WORKSPACE.name}  ${workspaceId}`)

  const cs = await client.query<{ id: string }>(
    `insert into public.client_spaces (tenant_id, workspace_id, name, slug, created_by)
     values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, slug) do update set name = excluded.name
     returning id`,
    [tenantId, workspaceId, SPACE.name, SPACE.slug, ownerId],
  )
  const spaceId = cs.rows[0]!.id
  console.log(`  space      ${SPACE.name}  ${spaceId}`)

  const pr = await client.query<{ id: string }>(
    `insert into public.projects
       (workspace_id, client_space_id, name, slug, visibility, created_by)
     values ($1, $2, $3, $4, 'space', $5)
     on conflict (client_space_id, slug) do update set name = excluded.name
     returning id`,
    [workspaceId, spaceId, PROJECT.name, PROJECT.slug, ownerId],
  )
  const projectId = pr.rows[0]!.id
  console.log(`  project    ${PROJECT.name}  ${projectId}`)

  const tpr = await client.query<{ id: string }>(
    `insert into public.projects
       (workspace_id, client_space_id, name, slug, visibility, created_by)
     values ($1, $2, $3, $4, 'space', $5)
     on conflict (client_space_id, slug) do update set name = excluded.name
     returning id`,
    [workspaceId, spaceId, TEST_PROJECT.name, TEST_PROJECT.slug, ownerId],
  )
  const testProjectId = tpr.rows[0]!.id
  console.log(`  tests      ${TEST_PROJECT.name}  ${testProjectId}`)

  /**
   * Memberships, inserted explicitly.
   *
   * `handle_new_client_space` would add the creator automatically, but it returns early when
   * `auth.uid()` is null — which it is here, because this connects as the service role. So the
   * trigger that normally does this is deliberately inert for provisioning, and the rows have
   * to be written by hand.
   *
   * Order matters: workspace_members and space_members carry composite foreign keys onto
   * tenant_members, and project_members onto space_members.
   */
  await client.query(
    `insert into public.workspace_members (workspace_id, tenant_id, user_id, role)
     values ($1, $2, $3, 'admin')
     on conflict (workspace_id, user_id) do update set role = 'admin'`,
    [workspaceId, tenantId, ownerId],
  )
  await client.query(
    `insert into public.space_members (client_space_id, tenant_id, user_id, role)
     values ($1, $2, $3, 'admin')
     on conflict (client_space_id, user_id) do update set role = 'admin'`,
    [spaceId, tenantId, ownerId],
  )
  for (const id of [projectId, testProjectId]) {
    await client.query(
      `insert into public.project_members (project_id, client_space_id, user_id, role)
       values ($1, $2, $3, 'member')
       on conflict (project_id, user_id) do update set role = 'member'`,
      [id, spaceId, ownerId],
    )
  }
  console.log(`  ${OWNER_EMAIL}: workspace=admin space=admin project=member`)

  await client.query('commit')

  // Fixture users, after the tenancy commits so a failure here leaves a usable workspace.
  if (!serviceKey || !projectUrl) {
    console.log('\n  fixture users skipped (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)')
  } else {
    console.log('')
    for (const fixture of FIXTURES) {
      const id = await ensureAuthUser(fixture.email, fixture.name)
      if (!id) continue
      if (fixture.spaceRole) {
        await client.query(
          `insert into public.tenant_members (tenant_id, user_id, role)
           values ($1, $2, 'member') on conflict (tenant_id, user_id) do nothing`,
          [tenantId, id],
        )
        await client.query(
          `insert into public.space_members (client_space_id, tenant_id, user_id, role)
           values ($1, $2, $3, $4)
           on conflict (client_space_id, user_id) do update set role = excluded.role`,
          [spaceId, tenantId, id, fixture.spaceRole],
        )
        if (fixture.projectRole) {
          await client.query(
            `insert into public.project_members (project_id, client_space_id, user_id, role)
             values ($1, $2, $3, $4)
             on conflict (project_id, user_id) do update set role = excluded.role`,
            [projectId, spaceId, id, fixture.projectRole],
          )
        }
        console.log(
          `  ${fixture.email}: space=${fixture.spaceRole}` +
            (fixture.projectRole ? ` project=${fixture.projectRole}` : ''),
        )
      } else {
        // Deliberately no membership anywhere. This is the actor that proves RLS denies.
        console.log(`  ${fixture.email}: no membership (outsider fixture)`)
      }
    }
  }

  console.log(`\n  put these in .env:\n`)
  console.log(`  INTELLIDEV_CLIENT_SPACE_ID='${spaceId}'`)
  console.log(`  INTELLIDEV_PROJECT_ID='${projectId}'`)
  console.log(`  INTELLIDEV_TEST_PROJECT_ID='${testProjectId}'\n`)
} catch (error) {
  await client.query('rollback').catch(() => undefined)
  throw error
} finally {
  client.release()
  await pool.end()
}
