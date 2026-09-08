-- =========================================================================
-- Seat enforcement, and a sweep for invitations nobody accepted.
-- =========================================================================

-- =========================================================================
-- Seats.
--
-- 20260901000400_tenancy.sql's ensure_tenant_membership() carries the comment
-- "Seat-cap enforcement, if it is ever added, belongs HERE — this is the one
-- chokepoint through which a new seat can be consumed." This is that.
--
-- It genuinely is the only chokepoint: workspace_members and space_members
-- both FK to tenant_members, and both fire this BEFORE INSERT trigger to
-- provision the roster row. accept_invitation() inserts tenant_members
-- directly, which the AFTER trigger below covers. So every route by which a
-- person becomes billable passes through one of the two.
--
-- Counted against tenant_members, which is exactly one row per human — the
-- reason tenant_members exists at all. Under the previous schema a seat count
-- meant DISTINCT over workspace memberships and double-counted anyone in two
-- workspaces.
--
-- `seats` is nullable and null means UNLIMITED, consistently with every other
-- cap on tenant_subscriptions. A tenant with no subscription row at all is
-- also unlimited: failing closed here would lock every existing tenant out of
-- adding people the moment this migration lands, which is a worse failure than
-- an unmetered tenant.
-- =========================================================================
create or replace function public.enforce_seat_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seats integer;
  v_used  integer;
begin
  select ts.seats into v_seats
  from public.tenant_subscriptions ts
  where ts.tenant_id = new.tenant_id;

  -- No subscription row, or no cap: unlimited.
  if v_seats is null then
    return new;
  end if;

  select count(*) into v_used
  from public.tenant_members tm
  where tm.tenant_id = new.tenant_id;

  if v_used >= v_seats then
    raise exception 'This organisation has used all % of its seats. Remove someone, or upgrade the plan.', v_seats
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- BEFORE INSERT on tenant_members itself: the single place a seat is consumed,
-- whether the row arrives from ensure_tenant_membership(), accept_invitation()
-- or a direct insert. Deliberately NOT on UPDATE — changing someone's role
-- consumes nothing.
create trigger trg_tenant_members_seat_cap
  before insert on public.tenant_members
  for each row execute function public.enforce_seat_cap();

-- =========================================================================
-- Expiry sweep.
--
-- 20260901000700_invitations.sql created invitations_expiry_idx and called it
-- "the expiry reaper's queue". Nothing has ever drained it, so expired
-- invitations accumulate in the pending list forever, each showing an
-- "Expired" badge that nobody can clear.
--
-- Marking them revoked rather than deleting them: the row is the audit record
-- of "we invited this person and they never came", which is worth keeping and
-- costs nothing. It also frees invitations_pending_uniq, so the same address
-- can be invited to the same scope again — currently a re-invite after expiry
-- collides with the stale row and the admin has to revoke it by hand first.
--
-- Returns the count so a caller can log it. SECURITY DEFINER because the
-- daily tick runs as the service role and should not depend on RLS.
-- =========================================================================
create or replace function public.sweep_expired_invitations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.invitations
  set revoked_at = now()
  where accepted_at is null
    and revoked_at is null
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.sweep_expired_invitations() from public, anon, authenticated;
-- service_role only: this is housekeeping, not a user action.
grant execute on function public.sweep_expired_invitations() to service_role;
