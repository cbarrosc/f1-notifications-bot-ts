create or replace function public.cleanup_notification_storage(
  queue_retention interval default interval '90 days',
  session_cache_retention interval default interval '365 days',
  legacy_delivery_retention interval default interval '365 days',
  cron_history_retention interval default interval '30 days'
)
returns table (
  deleted_delivery_logs bigint,
  deleted_notification_queue bigint,
  deleted_f1_sessions_cache bigint,
  deleted_notification_deliveries bigint,
  deleted_cron_job_run_details bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_queue_ids bigint[];
begin
  /*
   * Keep cleanup deliberately conservative:
   * - never delete pending or processing queue items
   * - never delete future queue items
   * - delete queue rows only after the event has been terminal for a long window
   * - delivery_logs are removed explicitly so we can report counts before the FK cascade
   */
  with queue_candidates as (
    select id
    from public.notification_queue
    where status in ('sent', 'failed')
      and scheduled_for < now() - queue_retention
      and coalesce(sent_at, updated_at, scheduled_for) < now() - queue_retention
  )
  select coalesce(array_agg(id), '{}'::bigint[])
  into deleted_queue_ids
  from queue_candidates;

  delete from public.delivery_logs
  where queue_id = any(deleted_queue_ids);
  get diagnostics deleted_delivery_logs = row_count;

  delete from public.notification_queue
  where id = any(deleted_queue_ids);
  get diagnostics deleted_notification_queue = row_count;

  delete from public.f1_sessions_cache
  where coalesce(date_end, date_start) < now() - session_cache_retention;
  get diagnostics deleted_f1_sessions_cache = row_count;

  delete from public.notification_deliveries
  where sent_at < now() - legacy_delivery_retention;
  get diagnostics deleted_notification_deliveries = row_count;

  delete from cron.job_run_details
  where end_time < now() - cron_history_retention;
  get diagnostics deleted_cron_job_run_details = row_count;

  return next;
end;
$$;

revoke all on function public.cleanup_notification_storage(interval, interval, interval, interval)
  from public;
revoke all on function public.cleanup_notification_storage(interval, interval, interval, interval)
  from anon;
revoke all on function public.cleanup_notification_storage(interval, interval, interval, interval)
  from authenticated;
grant execute on function public.cleanup_notification_storage(interval, interval, interval, interval)
  to service_role;

create or replace function public.unschedule_notification_cleanup_jobs()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_job record;
begin
  for current_job in
    select jobid
    from cron.job
    where jobname in ('fn-notification-storage-cleanup-weekly')
  loop
    perform cron.unschedule(current_job.jobid);
  end loop;
end;
$$;

create or replace function public.schedule_notification_cleanup_jobs(
  cleanup_schedule text default '30 8 * * 3'
)
returns table (cleanup_job_id bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.unschedule_notification_cleanup_jobs();

  cleanup_job_id := cron.schedule(
    'fn-notification-storage-cleanup-weekly',
    cleanup_schedule,
    $job$
    select *
    from public.cleanup_notification_storage();
    $job$
  );

  return next;
end;
$$;

revoke all on function public.unschedule_notification_cleanup_jobs() from public;
revoke all on function public.unschedule_notification_cleanup_jobs() from anon;
revoke all on function public.unschedule_notification_cleanup_jobs() from authenticated;
grant execute on function public.unschedule_notification_cleanup_jobs() to service_role;

revoke all on function public.schedule_notification_cleanup_jobs(text) from public;
revoke all on function public.schedule_notification_cleanup_jobs(text) from anon;
revoke all on function public.schedule_notification_cleanup_jobs(text) from authenticated;
grant execute on function public.schedule_notification_cleanup_jobs(text) to service_role;

select *
from public.schedule_notification_cleanup_jobs();
