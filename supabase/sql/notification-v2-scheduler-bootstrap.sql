-- One-time bootstrap for the v2 scheduler on the linked Supabase project.
--
-- Run this from the Supabase SQL Editor when you are ready to wire pg_cron to
-- the already-deployed v2 functions. Replace the SECRET_TOKEN placeholder
-- before executing.
--
-- Expected project URL for this repository:
--   https://gvtaoefszxncrhucvmbn.supabase.co
--
-- After storing the Vault secrets, this script schedules:
--   - fn-planner-v2 weekly on Monday at 06:00 UTC
--   - fn-dispatcher-v2 every minute

do $$
declare
  project_url_secret_id uuid;
  secret_token_secret_id uuid;
begin
  select id
    into project_url_secret_id
  from vault.decrypted_secrets
  where name = 'project_url'
  limit 1;

  if project_url_secret_id is null then
    perform vault.create_secret(
      'https://gvtaoefszxncrhucvmbn.supabase.co',
      'project_url',
      'Base URL for notification v2 scheduler jobs'
    );
  else
    perform vault.update_secret(
      project_url_secret_id,
      'https://gvtaoefszxncrhucvmbn.supabase.co',
      'project_url',
      'Base URL for notification v2 scheduler jobs'
    );
  end if;

  select id
    into secret_token_secret_id
  from vault.decrypted_secrets
  where name = 'secret_token'
  limit 1;

  if secret_token_secret_id is null then
    perform vault.create_secret(
      '<REPLACE_WITH_SECRET_TOKEN>',
      'secret_token',
      'Bearer token for notification v2 scheduler jobs'
    );
  else
    perform vault.update_secret(
      secret_token_secret_id,
      '<REPLACE_WITH_SECRET_TOKEN>',
      'secret_token',
      'Bearer token for notification v2 scheduler jobs'
    );
  end if;
end
$$;

select *
from public.schedule_notification_v2_jobs(
  project_url_secret_name := 'project_url',
  edge_secret_name := 'secret_token',
  planner_schedule := '0 6 * * 1',
  dispatcher_schedule := '* * * * *'
);
