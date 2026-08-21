-- guard_last_owner() and guard_last_tenant_admin() (20260820100400_tenancy.sql)
-- both block the exact case they aren't meant to: a CASCADING delete of the
-- parent workspace/tenant itself. Their DELETE branch fires just as much when
-- Postgres cascades `delete from tenants where id = X` down through
-- tenant_admins as it does for a standalone `delete from tenant_admins`, and
-- the guard has no way to tell those apart — so removing the sole
-- super_admin/owner is rejected even when the tenant/workspace they belonged
-- to is being deleted in the very same statement. Confirmed in practice: no
-- tenant or workspace created through this app (every one starts with
-- exactly one admin/owner, via handle_new_tenant/handle_new_workspace) can
-- ever be deleted at all, cascade or not — the delete of the LAST row always
-- looks like "removing the last owner" to this trigger.
--
-- The fix: check whether the parent row still exists before enforcing the
-- guard. If it doesn't, this delete is the tail end of a cascade from the
-- parent's own deletion — there is no "orphaned tenant/workspace with zero
-- admins" state to protect against once the parent itself is gone, so let it
-- proceed. The guard's actual purpose (block demoting/removing the last
-- admin while the tenant/workspace continues to exist) is unaffected.
create or replace function public.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_owners integer;
begin
  if (tg_op = 'DELETE' and old.role = 'owner')
     or (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    if not exists (select 1 from public.workspaces where id = old.workspace_id) then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;

    select count(*) into remaining_owners
    from public.workspace_members
    where workspace_id = old.workspace_id
      and role = 'owner'
      and user_id <> old.user_id;
    if remaining_owners = 0 then
      raise exception 'workspace % must keep at least one owner', old.workspace_id;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.guard_last_tenant_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  remaining_admins integer;
begin
  if (tg_op = 'DELETE' and old.role = 'super_admin')
     or (tg_op = 'UPDATE' and old.role = 'super_admin' and new.role <> 'super_admin') then
    if not exists (select 1 from public.tenants where id = old.tenant_id) then
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end if;

    select count(*) into remaining_admins
    from public.tenant_admins
    where tenant_id = old.tenant_id
      and role = 'super_admin'
      and user_id <> old.user_id;
    if remaining_admins = 0 then
      raise exception 'tenant % must keep at least one super_admin', old.tenant_id;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
