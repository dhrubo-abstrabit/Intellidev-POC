-- =========================================================================
-- RBAC, part 1 of 6: the catalog tables.
--
-- The problem this solves: before this migration, authorization was written
-- as role-name string literals pasted into individual RLS policies
-- (`array['admin']::public.workspace_role[]`, twenty-odd times). Three
-- consequences, all of which actually bit:
--
--   * `viewer` was declared in three enums and enforced by nothing. A space
--     viewer could update every task in the space.
--   * Changing what a role may do meant finding and editing every policy
--     that named it.
--   * Adding a role meant `alter type ... add value` — which cannot be used
--     in the transaction that adds it (see 20260901000300_enums.sql) — and
--     removing one was impossible, since Postgres has no `drop value`.
--
-- After this migration set, policies name PERMISSIONS and never roles, and a
-- role is a row. Adding a role becomes two INSERTs; removing one becomes a
-- DELETE that the FK refuses while anyone still holds it.
--
-- Nothing reads these tables yet — 20260901002300_rbac_resolvers.sql adds the
-- functions, and the policy migrations after it switch over. This file and
-- its seed are deliberately inert so they can land and be reviewed on their
-- own.
-- =========================================================================

-- =========================================================================
-- scope_level: the hierarchy, named. This is a `create type`, not an
-- `alter type ... add value`, so it does not run into the rule that
-- 20260901000300_enums.sql sets out — the whole set of values is declared
-- here, once, and this file stays individually re-runnable.
--
-- `platform` is deliberately included even though NOTHING is seeded into it.
-- A platform-level super admin (product staff, spanning every tenant) is not
-- a role at an existing level, it is a level above tenant. Declaring it now,
-- and writing the platform arm into every resolver in
-- 20260901002300_rbac_resolvers.sql, is what keeps "adding a role is a data
-- migration" true for that case too. Retrofitting the level later would mean
-- a new table plus a rewrite of all four resolvers — a schema migration,
-- under whatever time pressure made someone suddenly need a super admin.
--
-- Ordering is shallowest-to-deepest and is load-bearing: `<` on this type
-- compares by declaration order, which is what makes "a role at or above
-- this level" expressible without a lookup table.
-- =========================================================================
create type public.scope_level as enum (
  'platform', 'tenant', 'workspace', 'space', 'project'
);

-- =========================================================================
-- permissions: the vocabulary. One row per capability the product has.
--
-- Kept as a TABLE rather than a CHECK constraint or an enum for one specific
-- reason: a mistyped permission string in a policy predicate does not error.
-- It matches nothing, denies everyone, and looks exactly like working
-- security. The FK from role_permissions.permission turns that typo into an
-- insert-time failure instead.
--
-- `requires` is the write-implies-read edge — see guard_write_implies_read()
-- below. It is a self-reference, so the catalog carries its own dependency
-- graph and no application code has to know the pairings.
-- =========================================================================
create table public.permissions (
  key         text primary key
                check (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  category    text not null check (length(btrim(category)) between 1 and 40),
  label       text not null check (length(btrim(label)) between 1 and 80),
  description text,
  -- The read permission this one depends on. NULL for read permissions
  -- themselves and for capabilities with nothing to read (e.g. space.create,
  -- which creates a row that does not exist yet).
  requires    text references public.permissions (key) on delete restrict,
  sort_order  smallint not null default 0,
  created_at  timestamptz not null default now(),
  -- A permission cannot require itself. Longer cycles are prevented by the
  -- catalog being a hand-written seed one level deep, not by a constraint —
  -- a general cycle check would need a recursive trigger for no real benefit.
  constraint permissions_no_self_require_chk check (requires is distinct from key)
);

create index permissions_category_idx on public.permissions (category, sort_order);

-- =========================================================================
-- roles: what a membership row's `role` column points at.
--
-- The PK is (scope_level, key), NOT key alone: 'admin' means different things
-- at workspace and space level, and both must be able to exist. It is also
-- the FK target for every membership table, which is why those tables carry
-- a generated constant scope column (see 20260901002900_rbac_role_columns.sql)
-- — a single `role` column cannot reference a two-column key on its own.
--
-- `tenant_id` is nullable and reserved for per-tenant custom roles: NULL
-- means a built-in available everywhere, a set value means a role owned by
-- that tenant. It is unused today. Note the consequence of the PK: role keys
-- are unique per scope_level ACROSS all tenants, so when custom roles are
-- turned on, a tenant's custom key must not collide with a built-in or with
-- another tenant's — the app should namespace them (e.g. 'acme_analyst').
-- That constraint is the price of keeping the FK two columns wide forever
-- instead of three.
--
-- `rank` orders roles by authority within a scope, lowest = most powerful.
-- It exists so the members UI can refuse to grant a role above the actor's
-- own; it is NOT consulted by any policy, because authority comes from the
-- permission grid and nowhere else.
-- =========================================================================
create table public.roles (
  scope_level public.scope_level not null,
  key         text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  tenant_id   uuid references public.tenants (id) on delete cascade,
  label       text not null check (length(btrim(label)) between 1 and 60),
  description text,
  rank        smallint not null,
  -- System roles cannot be deleted or renamed by anyone, including a future
  -- role-management UI. The seed sets this on every built-in.
  is_system   boolean not null default false,
  -- Whether the role may be handed out through the app at all. A platform
  -- role must never appear in a tenant admin's dropdown.
  assignable  boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (scope_level, key)
);

create index roles_scope_rank_idx on public.roles (scope_level, rank);

create trigger trg_roles_updated_at
  before update on public.roles
  for each row execute function public.set_updated_at();

-- =========================================================================
-- role_permissions: the grid. THIS TABLE IS THE ACCESS-CONTROL POLICY OF THE
-- PRODUCT.
--
-- Treat changes to it as schema changes in review, not as data edits: an
-- accidental DELETE here silently revokes a capability for everyone holding
-- that role, and no code change would show up in the diff.
-- =========================================================================
create table public.role_permissions (
  scope_level public.scope_level not null,
  role_key    text not null,
  permission  text not null references public.permissions (key) on delete restrict,

  -- Does this grant also apply to scopes BENEATH the one the role is held at?
  --
  -- Not a formality — getting this wrong is a data leak. Blanket downward
  -- inheritance is wrong for exactly the permissions that mean something
  -- different at each level: `member.read` held by a tenant `member` means
  -- "see the organisation roster", and must NOT expand into "see the roster
  -- of every client space in the tenant", which is precisely what a
  -- cascading grant would do. Today's sm_select_comembers requires an actual
  -- space_members row, and this flag is what preserves that.
  --
  -- It is per-GRANT rather than per-permission because the same permission
  -- legitimately differs by role: a tenant OWNER's member.read does cascade
  -- (they administer every space beneath them, matching
  -- manageable_client_space_ids), while a tenant MEMBER's does not.
  --
  -- Default true, because authority roles are the majority of the grid and
  -- their whole purpose is to reach downward.
  cascades    boolean not null default true,

  created_at  timestamptz not null default now(),
  primary key (scope_level, role_key, permission),
  foreign key (scope_level, role_key)
    references public.roles (scope_level, key) on delete cascade
);

-- The resolvers all filter on (scope_level, permission) and project role_key,
-- which is the opposite order to the PK. This index is what keeps that a
-- lookup rather than a scan of the whole grid. `cascades` is included so the
-- ancestor arms stay index-only.
create index role_permissions_lookup_idx
  on public.role_permissions (scope_level, permission, role_key, cascades);

-- =========================================================================
-- guard_write_implies_read: "someone who cannot see a resource must not be
-- able to change it", enforced rather than merely intended.
--
-- Runs in both directions:
--   INSERT/UPDATE - refuses a write grant whose read counterpart is absent.
--   DELETE        - refuses removing a read grant while a write grant that
--                   depends on it survives.
--
-- This is a CONSTRAINT TRIGGER, DEFERRABLE INITIALLY DEFERRED, on purpose. A
-- plain BEFORE ROW trigger would make the seed order-dependent: a multi-row
-- INSERT listing 'task.update' before 'task.read' would fail even though the
-- end state is valid. Deferring to commit means the check sees the finished
-- transaction, so the seed can insert grants in any order — including the
-- `insert ... select` form the seeds actually use.
--
-- It also catches a defect that already existed: manageable_client_space_ids()
-- gated context_documents_write while current_client_space_ids() gated
-- context_documents_select, so a tenant owner could write a context document
-- into a space whose contents they could not read. Under this trigger that
-- combination is not a bug to be noticed, it is an impossible row.
-- =========================================================================
create or replace function public.guard_write_implies_read()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requires text;
begin
  if tg_op in ('INSERT', 'UPDATE') then
    select p.requires into v_requires
    from public.permissions p
    where p.key = new.permission;

    if v_requires is not null and not exists (
      select 1
      from public.role_permissions rp
      where rp.scope_level = new.scope_level
        and rp.role_key    = new.role_key
        and rp.permission  = v_requires
    ) then
      raise exception
        'role %/% cannot hold % without also holding %',
        new.scope_level, new.role_key, new.permission, v_requires;
    end if;

    return new;
  end if;

  -- DELETE. Deferred to commit, so this sees the transaction's end state:
  -- dropping task.read AND task.update together is fine, dropping task.read
  -- alone is not.
  if exists (
    select 1
    from public.role_permissions rp
    join public.permissions p on p.key = rp.permission
    where rp.scope_level = old.scope_level
      and rp.role_key    = old.role_key
      and p.requires     = old.permission
  ) then
    raise exception
      'cannot revoke % from %/% while a grant that requires it remains',
      old.permission, old.scope_level, old.role_key;
  end if;

  return old;
end;
$$;

create constraint trigger trg_role_permissions_imply_read
  after insert or update or delete on public.role_permissions
  deferrable initially deferred
  for each row execute function public.guard_write_implies_read();

-- =========================================================================
-- platform_members: the empty level.
--
-- Created with no rows and no way for the application to add any. Whether a
-- super admin should exist, and what it may read, is a company decision that
-- this migration deliberately does not make — it only ensures that making it
-- later costs two INSERTs and a membership row instead of a resolver rewrite.
--
-- `expires_at` is here from the start because the defensible shape for staff
-- access to customer data is time-boxed break-glass, not a standing grant.
-- The resolvers filter on it, so an expired row stops granting on its own
-- with no reaper job required.
--
-- Default-deny, matching project_connector_cursors: RLS on, ZERO policies,
-- and every grant revoked. A missing grant fails loudly with a 403 rather
-- than silently returning [], and it survives someone adding a permissive
-- policy "just for debugging" later.
-- =========================================================================
create table public.platform_members (
  user_id    uuid primary key references public.users (id) on delete cascade,
  role       text not null,
  -- Constant generated column, purely to complete the two-column FK into
  -- roles. Verified on PG 17: a generated column is a legal FK source.
  role_scope public.scope_level
               generated always as ('platform'::public.scope_level) stored,
  granted_by uuid references public.users (id) on delete set null,
  -- Why this access was granted. An audit trail with no reason field answers
  -- "who" but never "what for", which is the question that actually gets
  -- asked in a security review.
  reason     text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (role_scope, role)
    references public.roles (scope_level, key)
);

-- No secondary index: user_id is the primary key, which is the only way the
-- resolvers look this table up. (A partial index on the unexpired rows is not
-- possible anyway — now() is not IMMUTABLE, so it cannot appear in an index
-- predicate.)

create trigger trg_platform_members_updated_at
  before update on public.platform_members
  for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS.
--
-- The three catalog tables are a VOCABULARY, not a secret — the members UI
-- has to render role names and describe what each one grants, and hiding the
-- grid from users would not make the system safer, only harder to explain.
-- They are readable by every authenticated user and writable only by the
-- service role.
--
-- Readable-by-all also keeps them clear of the RLS recursion trap the
-- existing helpers were carefully built around: the resolvers are SECURITY
-- DEFINER and query these tables, so a policy here that consulted membership
-- would be a cycle waiting to happen.
-- =========================================================================
alter table public.permissions      enable row level security;
alter table public.roles            enable row level security;
alter table public.role_permissions enable row level security;
alter table public.platform_members enable row level security;

create policy permissions_select on public.permissions for select to authenticated
  using (true);

-- Built-in roles (tenant_id is null) are visible to everyone; a future
-- per-tenant custom role is visible only inside its own tenant.
create policy roles_select on public.roles for select to authenticated
  using (tenant_id is null or tenant_id in (select public.current_tenant_ids()));

create policy role_permissions_select on public.role_permissions for select to authenticated
  using (true);

-- Table-level GRANTs are a separate lock from RLS policies and are not
-- implied by them — this project does not auto-expose new tables
-- (supabase/config.toml), so a policy with no matching GRANT fails with
-- "permission denied" before RLS is ever evaluated.
grant select on public.permissions      to authenticated;
grant select on public.roles            to authenticated;
grant select on public.role_permissions to authenticated;

revoke insert, update, delete on public.permissions      from authenticated, anon;
revoke insert, update, delete on public.roles            from authenticated, anon;
revoke insert, update, delete on public.role_permissions from authenticated, anon;

-- platform_members: no policies, no grants. See the table comment.
revoke all on public.platform_members from anon, authenticated;
