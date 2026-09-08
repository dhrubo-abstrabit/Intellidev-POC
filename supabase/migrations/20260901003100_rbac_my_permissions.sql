-- =========================================================================
-- RBAC, part 9: the application layer's entry points.
--
-- Three functions the UI and Server Actions call. Definition order matters:
-- `language sql` bodies are parsed and validated at CREATE time, so a
-- function must exist before anything references it.
-- =========================================================================

-- =========================================================================
-- my_permissions: every permission the caller holds at one scope, in a single
-- round trip, so a page can gate several controls without a query per check.
--
-- Deliberately implemented as a loop over can() rather than as its own
-- hand-written join. A bespoke query here would be faster by a hair and would
-- be a SECOND implementation of the inheritance rules — one used by RLS and
-- one used by the UI, free to drift, with the drift showing up as a button
-- that is enabled and then fails on click, or disabled when it should not be.
-- There is one source of truth for "who can do what" and it is the resolver
-- set; this function only asks it 32 questions.
--
-- Cost is bounded and small: one indexed lookup per permission against tables
-- with tens to hundreds of rows, on a call made once per request.
--
-- SECURITY: auth.uid()-scoped like every resolver, and reports only the
-- CALLER's own permissions. There is no parameter for whose permissions to
-- read, so it cannot enumerate anyone else's access.
-- =========================================================================
create or replace function public.my_permissions(
  p_scope_level public.scope_level,
  p_scope_id    uuid
)
returns setof text
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select p.key
  from public.permissions p
  where public.can(p_scope_level, p_scope_id, p.key)
  order by p.key;
$$;

-- =========================================================================
-- caller_rank: the caller's own authority at a scope, as a rank number
-- (lower = more powerful), or NULL when they hold no DIRECT role there.
--
-- NULL is meaningful, not missing: it says the caller reaches this scope by
-- inheritance from above — a workspace admin acting on a client space, say —
-- and someone administering a scope from outside it outranks every role
-- defined inside it. assignable_roles() reads NULL as "no ceiling".
-- =========================================================================
create or replace function public.caller_rank(
  p_scope_level public.scope_level,
  p_scope_id    uuid
)
returns smallint
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select r.rank
  from public.roles r
  where r.scope_level = p_scope_level
    and r.key = case p_scope_level
      when 'tenant' then (
        select tm.role from public.tenant_members tm
        where tm.tenant_id = p_scope_id and tm.user_id = auth.uid()
      )
      when 'workspace' then (
        select wm.role from public.workspace_members wm
        where wm.workspace_id = p_scope_id and wm.user_id = auth.uid()
      )
      when 'space' then (
        select sm.role from public.space_members sm
        where sm.client_space_id = p_scope_id and sm.user_id = auth.uid()
      )
      when 'project' then (
        select pm.role from public.project_members pm
        where pm.project_id = p_scope_id and pm.user_id = auth.uid()
      )
    end;
$$;

-- =========================================================================
-- assignable_roles: what the members UI may offer.
--
-- Three filters, all of which have to live server-side because a client-side
-- role picker is a suggestion, not a control:
--
--   * member.manage at the scope — returns nothing at all otherwise, so
--     calling this in the wrong place yields an empty list rather than a
--     leaked vocabulary.
--   * `assignable` — excludes roles that must never be handed out through the
--     app. This is what keeps a platform role out of a tenant admin's
--     dropdown once one exists.
--   * `rank` — a caller may only grant roles at or below their own authority.
--     Without it, a space member holding member.manage could promote
--     themselves to space admin: privilege escalation dressed up as a form
--     submission.
--
-- Note this only shapes what the UI OFFERS. The actual write is still gated
-- by the sm_write / wm_write / pm_write policies, which is what stops a
-- hand-crafted request from setting a role this function would not have
-- listed.
-- =========================================================================
create or replace function public.assignable_roles(
  p_scope_level public.scope_level,
  p_scope_id    uuid
)
returns table (key text, label text, description text, rank smallint)
language sql
security definer
stable
parallel safe
set search_path = ''
as $$
  select r.key, r.label, r.description, r.rank
  from public.roles r
  where r.scope_level = p_scope_level
    and r.assignable
    and (r.tenant_id is null or r.tenant_id in (select public.tenant_ids_with('tenant.read')))
    and public.can(p_scope_level, p_scope_id, 'member.manage')
    and (
      public.caller_rank(p_scope_level, p_scope_id) is null
      or r.rank >= public.caller_rank(p_scope_level, p_scope_id)
    )
  order by r.rank;
$$;

revoke execute on function public.my_permissions(public.scope_level, uuid)   from public, anon;
revoke execute on function public.caller_rank(public.scope_level, uuid)      from public, anon;
revoke execute on function public.assignable_roles(public.scope_level, uuid) from public, anon;

grant  execute on function public.my_permissions(public.scope_level, uuid)   to authenticated;
grant  execute on function public.caller_rank(public.scope_level, uuid)      to authenticated;
grant  execute on function public.assignable_roles(public.scope_level, uuid) to authenticated;
