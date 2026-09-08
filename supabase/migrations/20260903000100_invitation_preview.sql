-- =========================================================================
-- invite_preview: read an invitation using only the token, before the
-- recipient is a member of anything.
--
-- WHY THIS EXISTS AT ALL. The accept page has to render "Dan invited you to
-- BeastSquad as a Space Admin" to someone who, by definition, holds no
-- membership yet. Every RLS policy on `invitations` requires member.invite at
-- the matching scope, and there is deliberately no policy letting an invitee
-- read their own row — verified empirically: a signed-in stranger holding a
-- valid invitation sees ZERO rows. They also cannot query by token even if a
-- policy allowed it, because the table stores only the SHA-256 hash while the
-- recipient holds the plaintext.
--
-- WHY A FUNCTION RATHER THAN THE SERVICE-ROLE CLIENT. This is a design choice,
-- not a hard requirement — a Server Component could bypass RLS with
-- createServiceClient() and no migration at all. Two reasons it lives here:
--
--   1. ONE definition of "is this invitation usable". accept_invitation()
--      already decides that in SQL — not found, revoked, accepted, expired —
--      and it is already SECURITY DEFINER taking the plaintext token and
--      hashing internally. Putting the preview anywhere else means writing
--      those four checks a second time in TypeScript, and the failure mode
--      when they drift is a page that says "valid" over an accept that throws.
--
--   2. Blast radius. The service-role client bypasses RLS for everything it
--      touches, so a mistake in that file leaks whatever the mistake reaches.
--      This function returns eight columns and cannot be made to return more.
--
-- SECURITY: possession of the token is the authorization, which is the same
-- rule accept_invitation() already runs on (see its comment on why email
-- equality was deliberately NOT required). Tokens are 256-bit, so guessing is
-- infeasible; that is what makes returning a distinct `status` safe rather
-- than an enumeration oracle. `email` is returned so the signup form can be
-- prefilled — a forwarded link therefore reveals the original recipient's
-- address to whoever opens it, which is accepted for the same reason the
-- forwarded link works at all.
--
-- NOTHING here grants access. It is strictly read-only; accept_invitation()
-- remains the only way to turn a token into membership.
-- =========================================================================
create or replace function public.invite_preview(p_token text)
returns table (
  status         text,
  email          text,
  invited_by     text,
  tenant_name    text,
  workspace_name text,
  space_name     text,
  project_name   text,
  role_labels    text[],
  expires_at     timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    case
      when i.revoked_at  is not null then 'revoked'
      when i.accepted_at is not null then 'accepted'
      when i.expires_at <= now()     then 'expired'
      else 'valid'
    end,
    i.email::text,
    coalesce(u.full_name, u.email::text),
    t.name,
    w.name,
    cs.name,
    p.name,
    -- Labels rather than keys, read from the catalog, so a role renamed or
    -- added later renders correctly here with no code change.
    (
      select coalesce(array_agg(r.label order by r.rank), array[]::text[])
      from public.roles r
      where (r.scope_level = 'tenant'    and r.key = i.tenant_role)
         or (r.scope_level = 'workspace' and r.key = i.workspace_role)
         or (r.scope_level = 'space'     and r.key = i.space_role)
         or (r.scope_level = 'project'   and r.key = i.project_role)
    ),
    i.expires_at
  from public.invitations i
  left join public.users         u  on u.id  = i.invited_by
  left join public.tenants       t  on t.id  = i.tenant_id
  left join public.workspaces    w  on w.id  = i.workspace_id
  left join public.client_spaces cs on cs.id = i.client_space_id
  left join public.projects      p  on p.id  = i.project_id
  where i.token_hash = extensions.digest(p_token, 'sha256');
$$;

-- Reachable by anon on purpose: the accept page renders for someone who has
-- no account yet, which is the whole case this function exists for. The token
-- is the credential, and an unknown token simply returns no rows.
revoke execute on function public.invite_preview(text) from public;
grant  execute on function public.invite_preview(text) to anon, authenticated;

-- =========================================================================
-- pending_invitations: the admin-side list for one scope.
--
-- SECURITY INVOKER — deliberately the opposite of invite_preview above. Here
-- the caller IS a member, so the existing invitations_select policy
-- (member.invite at the matching scope) is exactly the right gate and this
-- function should inherit it rather than bypass it. Someone without
-- member.invite gets an empty list, which is what the panel renders as "no
-- pending invitations".
--
-- `expired` is computed HERE rather than in TypeScript for two reasons. The
-- honest one: Postgres owns the clock that accept_invitation() compares
-- against, so judging expiry on the Next.js server's clock could show
-- "Expired" on an invitation that still accepts, or the reverse, whenever the
-- two drift. The incidental one: reading Date.now() during a render is an
-- impure call that React's lint rules reject, and working around it in the
-- component would have meant lying about where the answer comes from.
--
-- Role labels are resolved from the catalog, so a renamed or newly added role
-- shows correctly with no code change — same property the members screen has.
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
        where (r.scope_level = 'workspace' and r.key = i.workspace_role and p_scope_level = 'workspace')
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
      (p_scope_level = 'workspace' and i.workspace_id = p_scope_id and i.client_space_id is null)
      or
      (p_scope_level = 'space' and i.client_space_id = p_scope_id)
    )
  order by i.created_at desc;
$$;

revoke execute on function public.pending_invitations(public.scope_level, uuid) from public, anon;
grant  execute on function public.pending_invitations(public.scope_level, uuid) to authenticated;
