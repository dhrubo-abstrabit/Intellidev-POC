-- Lets a task be assigned to a Team Members roster entry (name/email/role,
-- no Supabase Auth account, no login) in addition to a real workspace user.
-- Purely a label: no access, no notification — team_members has neither.

-- Composite-FK target, matching the (id, workspace_id) convention
-- action_items already uses for its other tenant-scoped FKs.
alter table public.team_members
  add constraint team_members_id_workspace_id_key unique (id, workspace_id);

alter table public.action_items
  add column assignee_team_member_id uuid;

-- Composite FK scoped to workspace_id — unlike the pre-existing assignee_id
-- FK (references bare users(id), so cross-workspace assignment is only
-- blocked by the app-level check in updateActionItemAssignee, not the
-- schema), this makes an out-of-workspace or nonexistent roster id
-- structurally impossible. Not fixing the older column's gap here, just
-- not repeating it.
--
-- The column-list form of `on delete set null` is required, not the bare
-- form: action_items.workspace_id is `not null`, so nulling both
-- referencing columns on a team_members delete would itself violate that
-- not-null constraint. (The pre-existing bare-form `on delete set null` on
-- the llm_run_id FK below has this same latent bug — it just never fires
-- because llm_runs rows are only ever removed via the project cascade,
-- which deletes action_items first.)
alter table public.action_items
  add constraint action_items_assignee_team_member_id_fkey
    foreign key (assignee_team_member_id, workspace_id)
    references public.team_members (id, workspace_id)
    on delete set null (assignee_team_member_id);

-- Forces every write to set one assignee column and null the other, so
-- every reader can resolve "the assignee" with a plain `??` instead of
-- needing a documented tie-break rule for "what if both are set."
alter table public.action_items
  add constraint action_items_single_assignee_chk
    check (assignee_id is null or assignee_team_member_id is null);

comment on column public.action_items.assignee_team_member_id is
  'A team_members roster contact assigned to this task — mutually exclusive '
  'with assignee_id (see action_items_single_assignee_chk). Distinct from '
  'owner_hint (the LLM''s free-text guess, display-only, not client-writable). '
  'A roster contact has no login, so there is no "my tasks" access path for '
  'this column — deliberately no index mirroring action_items_assignee_open_idx.';

-- Supersedes (does not edit — that migration is already applied) the
-- action_items block in 20260803151100_grants_hardening.sql. Anyone copying
-- that block as a reference for a future grant should use this one instead.
revoke update on public.action_items from authenticated;
grant update (status, assignee_id, assignee_team_member_id, snoozed_until, resolved_at, priority)
  on public.action_items to authenticated;
