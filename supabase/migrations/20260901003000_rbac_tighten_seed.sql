-- =========================================================================
-- RBAC, part 8: the behaviour change.
--
-- Everything up to here was a refactor: the seed in 20260901002200 was chosen
-- so the rewritten policies admitted exactly the same callers as the ones
-- they replaced. THIS file is the only one that changes who can do what, and
-- it does nothing else, so the diff is the changelog.
--
-- Five changes, each with the reasoning:
--
--   1. space viewer loses task.update, task.assign and sync.trigger.
--      This is the headline. `viewer` has been declared in three enums since
--      the v2 rebuild and enforced by nothing — tasks_update was
--      byte-for-byte identical to tasks_select, so a viewer could reassign,
--      reprioritise and dismiss every task in the space. Read-only now means
--      read-only.
--
--   2. project viewer loses task.update and task.assign, for the same reason
--      at the narrower scope.
--
--   3. tenant member loses billing.read. tenant_subscriptions_select keyed on
--      current_tenant_ids(), so every person on the roster could read the
--      plan, seat count and spend. That is owner and billing-admin
--      information.
--
--   4. project member loses member.manage. manageable_project_ids() included
--      pm.role = 'member', which meant anyone with a project `member`
--      override could add and remove people from that project. Managing
--      access is administrative; doing the work is not.
--
--   5. space member GAINS document.write. This is the one widening, and it is
--      deliberate: context_documents_write required manageable_* — space
--      admin and above — so an ordinary space member could not write a
--      context document for their own engagement, while a project member
--      could write one for their project. Writing a context document is
--      ordinary project work with a low blast radius; the asymmetry was an
--      artefact of which helper the policy happened to call.
--
-- NOT changed here, because it was never an RLS problem: a space member could
-- connect and disconnect providers in practice, but the policy
-- (space_connections_delete) already required admin. What defeated it was the
-- Server Action running the write through the service-role client, which
-- bypasses RLS entirely. That is fixed in the application layer, not in this
-- grid.
--
-- guard_write_implies_read() checks every statement below: removing
-- task.update while task.read remains is allowed (dropping a dependent),
-- while removing task.read while task.update remained would be refused.
-- =========================================================================

-- 1. Space viewers become genuinely read-only.
delete from public.role_permissions
where scope_level = 'space'
  and role_key    = 'viewer'
  and permission in ('task.update', 'task.assign', 'sync.trigger');

-- 2. Project viewers likewise.
delete from public.role_permissions
where scope_level = 'project'
  and role_key    = 'viewer'
  and permission in ('task.update', 'task.assign');

-- 3. Billing is owner / billing-admin information.
delete from public.role_permissions
where scope_level = 'tenant'
  and role_key    = 'member'
  and permission  = 'billing.read';

-- 4. Managing project access is administrative.
delete from public.role_permissions
where scope_level = 'project'
  and role_key    = 'member'
  and permission  = 'member.manage';

-- 5. Space members may maintain their own engagement's context documents.
insert into public.role_permissions (scope_level, role_key, permission, cascades)
values ('space', 'member', 'document.write', true);

-- =========================================================================
-- Guard rail: assert the end state rather than trusting the deltas above.
--
-- A seed is production configuration, and the failure mode of getting it
-- wrong is silent — nothing errors, some role just quietly gains or loses a
-- capability. These two checks fail the migration loudly instead.
-- =========================================================================
do $$
declare
  v_bad text;
begin
  -- No read-only role anywhere may hold a permission that is somebody's
  -- declared write dependency (i.e. a write permission).
  select string_agg(rp.scope_level || '/' || rp.role_key || ':' || rp.permission, ', ')
  into v_bad
  from public.role_permissions rp
  where rp.role_key = 'viewer'
    and rp.permission in (select key from public.permissions where requires is not null);

  if v_bad is not null then
    raise exception 'viewer roles must hold no write permissions, found: %', v_bad;
  end if;

  -- No role above the space level may read ingested client data. This is the
  -- workspace/data split, asserted rather than merely commented.
  select string_agg(rp.scope_level || '/' || rp.role_key || ':' || rp.permission, ', ')
  into v_bad
  from public.role_permissions rp
  where rp.scope_level in ('tenant', 'workspace')
    and rp.permission in ('data.read', 'task.read', 'task.update', 'task.assign',
                          'document.read', 'document.write', 'sync.trigger');

  if v_bad is not null then
    raise exception 'tenant/workspace roles must not reach client data, found: %', v_bad;
  end if;
end $$;
