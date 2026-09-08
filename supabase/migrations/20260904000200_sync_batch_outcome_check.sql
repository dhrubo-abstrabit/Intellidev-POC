-- sync_batch_members.outcome's CHECK (20260901000900_sync.sql) only allowed
-- 'succeeded' | 'failed' | 'skipped', but src/services/sync/batch.ts has
-- always written two more values it never had a slot for:
-- markMemberEnqueueFailed writes 'enqueue_failed', and
-- forceCompleteTimedOutBatch writes 'timed_out'. Neither call site checked
-- the update's error, so both writes were silently rejected (23514) and the
-- member row stayed at completed_at IS NULL forever — meaning
-- settleBatchMembership's remaining-count never reached zero and the 2-hour
-- timeout backstop never actually settled anything. Confirmed latent rather
-- than actively firing in production (zero NULL-outcome member rows there at
-- the time of writing) — but the faster tick this lands alongside makes the
-- batch-timeout backstop matter more, not less, so this is fixed first.
alter table public.sync_batch_members drop constraint sync_batch_members_outcome_check;
alter table public.sync_batch_members add constraint sync_batch_members_outcome_check
  check (outcome is null or outcome in ('succeeded', 'failed', 'skipped', 'enqueue_failed', 'timed_out'));
