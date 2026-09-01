-- =========================================================================
-- RBAC, part 2 of 6: the vocabulary and the grid, seeded to reproduce
-- today's behaviour.
--
-- This seed is written to be BEHAVIOUR-PRESERVING. Every grant below was
-- derived by reading the existing RLS policy it will replace and asking "who
-- passes this predicate today". The policy migrations that follow
-- (20260901002400 .. 20260901002800) can therefore be verified as pure
-- translations: if the pgTAP matrix changes at all across them, the
-- translation is wrong.
--
-- Deliberate tightening is deferred to 20260901003000_rbac_tighten_seed.sql,
-- in one reviewable diff, so "we changed who can do what" never hides inside
-- "we refactored how it is checked".
--
-- TWO DEFECTS ARE NOT REPRODUCED, because guard_write_implies_read() makes
-- them unrepresentable and reproducing them was never the point:
--
--   1. context_documents_write was gated on manageable_client_space_ids()
--      while context_documents_select was gated on current_client_space_ids(),
--      so a tenant owner or workspace admin could WRITE a context document
--      into a space whose documents they could not READ. Fixed by not
--      granting document.write above the space level.
--
--   2. projects_update was gated on manageable_project_ids() while
--      projects_select was gated on current_project_ids(), so a workspace
--      admin who was not a space member could UPDATE a project row they
--      could not SELECT. Fixed the other way — by granting project.read to
--      workspace admins and tenant owners, which is the arm that was missing.
--      This widens ROW visibility (a project's name and status), not data
--      access: no workspace-level role holds data.read.
-- =========================================================================

-- =========================================================================
-- The vocabulary. `requires` is the write-implies-read edge enforced by
-- guard_write_implies_read(); read permissions and create-something-new
-- permissions have none.
-- =========================================================================
insert into public.permissions (key, category, label, description, requires, sort_order) values
  -- Tenant ---------------------------------------------------------------
  ('tenant.read',       'tenant',      'View organisation',       'See the tenant record and its members.',                             null,              10),
  ('tenant.update',     'tenant',      'Edit organisation',       'Rename the tenant and change its settings.',                         'tenant.read',     20),

  -- Billing --------------------------------------------------------------
  ('billing.read',      'billing',     'View billing',            'See the plan, seat count, caps and billing period.',                 null,              10),
  ('billing.manage',    'billing',     'Manage billing',          'Change the plan or payment details.',                                'billing.read',    20),
  ('usage.read',        'billing',     'View usage',              'See token spend and model usage rolled up from llm_runs.',           null,              30),

  -- Audit ----------------------------------------------------------------
  ('audit.read',        'audit',       'View audit log',          'Read the append-only record of who did what.',                       null,              10),

  -- Membership -----------------------------------------------------------
  ('member.read',       'membership',  'View members',            'See who else has access at this scope.',                             null,              10),
  ('member.invite',     'membership',  'Invite members',          'Send and revoke invitations at this scope.',                         'member.read',     20),
  ('member.manage',     'membership',  'Manage members',          'Add, remove and change the role of members at this scope.',          'member.read',     30),

  -- Structure ------------------------------------------------------------
  ('workspace.create',  'structure',   'Create workspaces',       'Create a workspace. Consumes a plan cap, so it is billing-visible.', null,              10),
  ('workspace.read',    'structure',   'View workspace',          'See the workspace record.',                                          null,              11),
  ('workspace.manage',  'structure',   'Manage workspace',        'Rename the workspace and change its settings.',                      'workspace.read',  12),
  ('workspace.delete',  'structure',   'Delete workspace',        'Delete a workspace and everything beneath it.',                      'workspace.read',  13),

  ('space.create',      'structure',   'Create client spaces',    'Create a client space inside a workspace.',                          null,              20),
  ('space.read',        'structure',   'View client space',       'See the client space record — not its ingested data.',               null,              21),
  ('space.manage',      'structure',   'Manage client space',     'Rename, retimezone, edit the context profile, archive.',             'space.read',      22),
  ('space.delete',      'structure',   'Delete client space',     'Delete a client space and everything beneath it.',                   'space.read',      23),

  ('project.create',    'structure',   'Create projects',         'Create a project inside a client space.',                            null,              30),
  ('project.read',      'structure',   'View project',            'See the project record — not its ingested data.',                    null,              31),
  ('project.manage',    'structure',   'Manage project',          'Rename a project, change visibility, and scope its connectors.',     'project.read',    32),
  ('project.delete',    'structure',   'Delete project',          'Delete a project and everything beneath it.',                        'project.read',    33),

  -- Contacts (team_members: a roster of people, not app users) ------------
  ('contact.read',      'contacts',    'View contacts',           'See the workspace roster of stakeholders and client contacts.',      null,              10),
  ('contact.manage',    'contacts',    'Manage contacts',         'Add, edit and remove entries on the contact roster.',                'contact.read',    20),

  -- Connections ----------------------------------------------------------
  ('connection.read',   'connections', 'View connections',        'See which provider accounts are connected to a client space.',       null,              10),
  ('connection.manage', 'connections', 'Manage connections',      'Connect and disconnect provider accounts for a client space.',       'connection.read', 20),

  -- Data -----------------------------------------------------------------
  ('data.read',         'data',        'Read activity',           'Read ingested messages, emails, files, attachments and search.',     null,              10),
  ('sync.trigger',      'data',        'Run a sync',              'Trigger a sync outside the schedule. Costs provider quota.',         'data.read',       20),

  -- Tasks ----------------------------------------------------------------
  ('task.read',         'tasks',       'View tasks',              'See the task board and each task''s sources.',                       null,              10),
  ('task.update',       'tasks',       'Update tasks',            'Change a task''s status, priority, due date or snooze.',             'task.read',       20),
  ('task.assign',       'tasks',       'Assign tasks',            'Assign a task to a user or a contact.',                              'task.read',       30),

  -- Documents ------------------------------------------------------------
  ('document.read',     'documents',   'Read context documents',  'Read hand-written context documents.',                               null,              10),
  ('document.write',    'documents',   'Write context documents', 'Create, edit and delete context documents.',                         'document.read',   20);

-- =========================================================================
-- The roles. `rank` is authority order within a scope, lowest = strongest;
-- the members UI refuses to grant a role ranked above the actor's own. No
-- policy reads it.
--
-- Every role here is is_system = true: these eleven are the product's own
-- vocabulary and must not be deletable or renamable by any future
-- role-management UI.
--
-- NOTE what is absent: the `platform` scope gets no rows. The level exists
-- (see 20260901002100_rbac_catalog.sql) precisely so that filling it later
-- is an INSERT rather than a schema change.
-- =========================================================================
insert into public.roles (scope_level, key, label, description, rank, is_system) values
  ('tenant',    'owner',         'Owner',         'Full authority across the organisation, including billing.',                10, true),
  ('tenant',    'billing_admin', 'Billing Admin', 'Plan, seats and spend. No operational or client access.',                   20, true),
  ('tenant',    'member',        'Member',        'On the organisation roster. Grants nothing on its own.',                    30, true),

  ('workspace', 'admin',         'Admin',         'Runs the workspace: client spaces, projects, people. Reads no client data.', 10, true),
  ('workspace', 'member',        'Member',        'Sees the workspace and its contacts.',                                      20, true),
  ('workspace', 'viewer',        'Viewer',        'Read-only view of the workspace.',                                          30, true),

  ('space',     'admin',         'Admin',         'Runs one client engagement end to end, including its connections.',         10, true),
  ('space',     'member',        'Member',        'Works the engagement: activity, tasks and context documents.',              20, true),
  ('space',     'viewer',        'Viewer',        'Read-only across the whole client engagement.',                             30, true),

  ('project',   'member',        'Member',        'Full working access, confined to one project.',                             10, true),
  ('project',   'viewer',        'Viewer',        'Read-only, confined to one project.',                                       20, true);

-- =========================================================================
-- The grid, permissive — i.e. exactly who passes each existing policy today.
--
-- Read this against the policy it replaces:
--   tenant.read       <- tenants_select                 (current_tenant_ids)
--   billing.read      <- tenant_subscriptions_select    (current_tenant_ids)
--   member.read       <- {tenant,workspace,space,project}_members select
--   workspace.read    <- workspaces_select              (current_workspace_ids)
--   space.read        <- client_spaces_select           (current + manageable)
--   project.read      <- projects_select                (current_project_ids)
--   contact.read      <- team_members_select            (current_workspace_ids)
--   connection.read   <- space_connections_select       (current + manageable)
--   data.read         <- normalized_events_select et al (current_client_space_ids)
--   task.read         <- tasks_select                   (current + project)
--   task.update       <- tasks_update                   (identical to tasks_select today)
--   document.read     <- context_documents_select       (current + project)
--
-- THE `cascades` COLUMN IS LOAD-BEARING HERE. A tenant `member` holds
-- member.read so they can see the organisation roster; if that grant
-- cascaded, they would also see the roster of every client space in the
-- tenant, which sm_select_comembers does not permit today. The same applies
-- to workspace member/viewer. Authority roles — tenant owner, workspace
-- admin, space admin — DO cascade, which is exactly what
-- manageable_client_space_ids() and manageable_project_ids() encode today.
--
-- member.read is restated at every level a role can hold rather than relying
-- on the tenant grant, because guard_write_implies_read() checks a role's own
-- grant set: member.manage at space level needs member.read at space level,
-- not merely somewhere in the caller's effective access.
--
-- billing.manage / usage.read / sync.trigger gate nothing today —
-- tenant_subscriptions and llm_runs are service-role only, and a manual sync
-- runs through a Server Action rather than a policy. They are seeded at their
-- intended final values because there is no current behaviour to preserve.
-- =========================================================================
insert into public.role_permissions (scope_level, role_key, permission, cascades)
select v.scope_level::public.scope_level, v.role_key, p, v.cascades
from (values

  -- TENANT ---------------------------------------------------------------
  -- The owner is authority everywhere beneath, so every grant cascades. Note
  -- what is absent: data.read, task.*, document.*. A tenant owner reaches no
  -- ingested data without adding themselves to space_members — a visible,
  -- auditable row rather than ambient access.
  ('tenant', 'owner', true, array[
    'tenant.read', 'tenant.update',
    'billing.read', 'billing.manage', 'usage.read',
    'audit.read',
    'member.read', 'member.invite', 'member.manage',
    'workspace.create', 'workspace.read', 'workspace.manage', 'workspace.delete',
    'space.create', 'space.read', 'space.manage', 'space.delete',
    'project.create', 'project.read', 'project.manage', 'project.delete',
    'contact.read', 'contact.manage',
    'connection.read', 'connection.manage'
  ]),

  -- Non-cascading: these are statements about the organisation, not about
  -- any workspace or client space inside it. billing.read is granted to all
  -- three tenant roles because tenant_subscriptions_select keys on
  -- current_tenant_ids() today; 20260901003000 narrows it.
  ('tenant', 'billing_admin', false, array[
    'tenant.read', 'billing.read', 'billing.manage', 'usage.read', 'member.read'
  ]),
  ('tenant', 'member', false, array[
    'tenant.read', 'billing.read', 'member.read'
  ]),

  -- WORKSPACE ------------------------------------------------------------
  -- has_workspace_role('admin') plus every manageable_* arm, all cascading.
  -- project.read is the arm that was missing (see the header note).
  -- No data.read, task.* or document.* at this level, by design: workspace
  -- authority manages the shape of an engagement and reads none of it.
  ('workspace', 'admin', true, array[
    'audit.read',
    'member.read', 'member.invite', 'member.manage',
    'workspace.read', 'workspace.manage',
    'space.create', 'space.read', 'space.manage', 'space.delete',
    'project.create', 'project.read', 'project.manage', 'project.delete',
    'contact.read', 'contact.manage',
    'connection.read', 'connection.manage'
  ]),

  -- Non-cascading: a workspace member is not a space member, and must not
  -- inherit visibility into any client space's roster or records.
  ('workspace', 'member', false, array[
    'workspace.read', 'member.read', 'contact.read'
  ]),
  ('workspace', 'viewer', false, array[
    'workspace.read', 'member.read', 'contact.read'
  ]),

  -- SPACE ----------------------------------------------------------------
  -- Cascading, so these reach the projects inside the space — which is what
  -- current_project_ids() and manageable_project_ids() do today.
  ('space', 'admin', true, array[
    'member.read', 'member.invite', 'member.manage',
    'space.read', 'space.manage',
    'project.create', 'project.read', 'project.manage', 'project.delete',
    'connection.read', 'connection.manage',
    'data.read', 'sync.trigger',
    'task.read', 'task.update', 'task.assign',
    'document.read', 'document.write'
  ]),

  -- Today every space member passes tasks_update and the data policies
  -- regardless of role, so member and viewer are seeded IDENTICALLY here.
  -- 20260901003000_rbac_tighten_seed.sql is what finally makes `viewer`
  -- mean something.
  ('space', 'member', true, array[
    'member.read',
    'space.read', 'project.read',
    'connection.read',
    'data.read', 'sync.trigger',
    'task.read', 'task.update', 'task.assign',
    'document.read'
  ]),
  ('space', 'viewer', true, array[
    'member.read',
    'space.read', 'project.read',
    'connection.read',
    'data.read', 'sync.trigger',
    'task.read', 'task.update', 'task.assign',
    'document.read'
  ]),

  -- PROJECT --------------------------------------------------------------
  -- Nothing sits below a project, so `cascades` is inert here; left true for
  -- consistency. manageable_project_ids() includes pm.role = 'member', which
  -- today feeds pm_write_manager (member.manage) and projects_update
  -- (project.manage).
  ('project', 'member', true, array[
    'member.read', 'member.manage',
    'project.read', 'project.manage',
    'data.read', 'sync.trigger',
    'task.read', 'task.update', 'task.assign',
    'document.read', 'document.write'
  ]),
  ('project', 'viewer', true, array[
    'member.read',
    'project.read',
    'data.read',
    'task.read', 'task.update', 'task.assign',
    'document.read'
  ])

) as v(scope_level, role_key, cascades, perms), unnest(v.perms) as p;
