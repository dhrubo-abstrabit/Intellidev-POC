-- =========================================================================
-- Tenant-scoped invitations.
--
-- WHY. There was no way to onboard a billing admin. Every invitation the app
-- could create named a workspace or a client space, and accept_invitation()
-- falls through to `coalesce(v_inv.tenant_role, 'member')` — so every invitee
-- landed as tenant `member`, and the Organisation screen could only change the
-- role of someone already on the roster. Making Raj a billing_admin therefore
-- meant: invite him into a workspace or client space he has no business in,
-- have him accept, promote him at tenant level, then go back and strip the
-- membership you only created to get him through the door. Four steps, one of
-- which hands a finance person access to client Slack.
--
-- The schema already allowed this — invitations_scope_chain_chk permits a row
-- with only tenant_id set, invitations_role_depth_chk permits a bare
-- tenant_role, and accept_invitation() has always honoured it. Only
-- pending_invitations() needed teaching, because it was written when the app
-- could invite at two levels.
--
-- NOTE what a tenant invitation grants: a tenant_members row and nothing else.
-- No workspace, space or project membership is created, so the recipient sees
-- the Organisation page and no client work at all. That is exactly right for a
-- billing admin and would look broken for anyone else, which is why the UI
-- labels it.
-- =========================================================================
create or replace function public.pending_invitations(
  p_scope_level public.scope_level,
  p_scope_id    uuid
)
returns table (
  id         uuid,
  email      text,
  role_label text,
  invited_by text,
  expires_at timestamptz,
  expired    boolean
)
language sql
stable
set search_path = ''
as $$
  select
    i.id,
    i.email::text,
    coalesce(
      (select r.label from public.roles r
        where (r.scope_level = 'tenant'    and r.key = i.tenant_role    and p_scope_level = 'tenant')
           or (r.scope_level = 'workspace' and r.key = i.workspace_role and p_scope_level = 'workspace')
           or (r.scope_level = 'space'     and r.key = i.space_role     and p_scope_level = 'space')
        limit 1),
      '—'
    ),
    coalesce(u.full_name, u.email::text),
    i.expires_at,
    i.expires_at <= now()
  from public.invitations i
  left join public.users u on u.id = i.invited_by
  where i.accepted_at is null
    and i.revoked_at is null
    and (
      -- Tenant-scoped: no workspace and no space named, so this is an
      -- invitation to the organisation itself rather than to something in it.
      (p_scope_level = 'tenant'
        and i.tenant_id = p_scope_id
        and i.workspace_id is null
        and i.client_space_id is null)
      or
      (p_scope_level = 'workspace' and i.workspace_id = p_scope_id and i.client_space_id is null)
      or
      (p_scope_level = 'space' and i.client_space_id = p_scope_id)
    )
  order by i.created_at desc;
$$;

revoke execute on function public.pending_invitations(public.scope_level, uuid) from public, anon;
grant  execute on function public.pending_invitations(public.scope_level, uuid) to authenticated;
