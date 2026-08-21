-- =========================================================================
-- tenant_subscriptions: Stripe subscription state + the plan's caps.
--
-- The caps live here as columns rather than in a separate `plans` table.
-- Accepted consequence: changing what a plan includes means updating every
-- subscriber row, there is no FK-able plan identity, and grandfathering is
-- implicit (an old subscriber simply keeps whatever numbers their row holds).
-- `plan` is text, and this is the ONLY place it lives — see the note on
-- public.tenants for why it is deliberately not duplicated there.
--
-- One row per tenant, enforced by the unique constraint: a tenant has exactly
-- one current subscription. Superseded/cancelled history lives in Stripe and
-- in billing_invoices, not as extra rows here.
-- =========================================================================
create table public.tenant_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null unique references public.tenants (id) on delete cascade,

  stripe_customer_id     text unique,
  stripe_subscription_id text unique,

  plan                   text not null default 'free'
                           check (plan ~ '^[a-z][a-z0-9_]{1,40}$'),
  status                 public.subscription_status not null default 'trialing',

  trial_ends_at          timestamptz,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,

  -- null = unlimited, consistently, on every cap below.
  --
  -- max_members_per_ws bounds membership PER WORKSPACE, not per tenant. It is
  -- therefore not a seat cap: a tenant that creates another workspace gets
  -- another allowance, and a user in two workspaces is counted twice. See the
  -- tenant_admins comment in 20260820100400_tenancy.sql for the full note on
  -- how billable users are derived in the absence of a tenant_members table.
  max_workspaces         integer check (max_workspaces is null or max_workspaces > 0),
  max_members_per_ws     integer check (max_members_per_ws is null or max_members_per_ws > 0),
  max_client_spaces      integer check (max_client_spaces is null or max_client_spaces > 0),
  max_projects           integer check (max_projects is null or max_projects > 0),

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create trigger trg_tenant_subscriptions_updated_at
  before update on public.tenant_subscriptions
  for each row execute function public.set_updated_at();

alter table public.tenant_subscriptions enable row level security;

-- Readable by anyone who can see the tenant (the billing page renders plan +
-- period + caps). Written only by the Stripe webhook via the service-role
-- client — no insert/update/delete grant, so a member cannot PATCH their own
-- plan or caps through PostgREST.
create policy tenant_subscriptions_select on public.tenant_subscriptions for select to authenticated
  using (tenant_id in (select public.current_tenant_ids()));
grant select on public.tenant_subscriptions to authenticated;
revoke insert, update, delete on public.tenant_subscriptions from authenticated, anon;

-- =========================================================================
-- billing_invoices: local mirror of Stripe invoices, so the billing page
-- renders from Postgres instead of an API round-trip per page view.
--
-- `stripe_invoice_id` is unique because Stripe redelivers webhooks: the
-- upsert on this key is what makes redelivery a no-op instead of a duplicate
-- invoice row.
-- =========================================================================
create table public.billing_invoices (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  stripe_invoice_id text not null unique,
  amount_cents      integer not null,
  currency          text not null default 'usd' check (length(currency) = 3),
  status            public.invoice_status not null default 'draft',
  hosted_invoice_url text,
  period_start      timestamptz,
  period_end        timestamptz,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index billing_invoices_tenant_recent_idx
  on public.billing_invoices (tenant_id, created_at desc);

create trigger trg_billing_invoices_updated_at
  before update on public.billing_invoices
  for each row execute function public.set_updated_at();

alter table public.billing_invoices enable row level security;

-- Only tenant admins see invoices — an ordinary workspace member has no
-- business reading what the company pays.
create policy billing_invoices_select_admin on public.billing_invoices for select to authenticated
  using (public.has_tenant_role(
    tenant_id, array['super_admin', 'billing_admin']::public.tenant_admin_role[]
  ));
grant select on public.billing_invoices to authenticated;
revoke insert, update, delete on public.billing_invoices from authenticated, anon;

-- =========================================================================
-- usage_records: daily metering rollup, per tenant.
--
-- Pre-aggregated on purpose: a quota check must never be a count(*) over
-- normalized_events, which is the highest-volume table in the schema and
-- grows without bound.
--
-- Metrics are fixed columns rather than a (metric, value) key-value shape.
-- Accepted consequence: every new metered dimension is a migration. Adding
-- one is `alter table ... add column ... not null default 0`, which is cheap
-- on this table (one row per tenant per day), so the tradeoff is deliberate.
-- =========================================================================
create table public.usage_records (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  usage_date      date not null,
  llm_tokens_used bigint not null default 0,
  sync_jobs_run   integer not null default 0,
  storage_bytes   bigint not null default 0,
  api_calls       integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- The upsert key: increments are
  -- `insert ... on conflict (tenant_id, usage_date) do update set
  --  llm_tokens_used = usage_records.llm_tokens_used + excluded....`
  unique (tenant_id, usage_date)
);

create index usage_records_tenant_date_idx
  on public.usage_records (tenant_id, usage_date desc);

create trigger trg_usage_records_updated_at
  before update on public.usage_records
  for each row execute function public.set_updated_at();

alter table public.usage_records enable row level security;

create policy usage_records_select_admin on public.usage_records for select to authenticated
  using (public.has_tenant_role(
    tenant_id, array['super_admin', 'billing_admin']::public.tenant_admin_role[]
  ));
grant select on public.usage_records to authenticated;
revoke insert, update, delete on public.usage_records from authenticated, anon;
