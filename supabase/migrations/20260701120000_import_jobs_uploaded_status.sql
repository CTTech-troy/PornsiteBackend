alter table import_jobs
  drop constraint if exists import_jobs_status_check;

alter table import_jobs
  add constraint import_jobs_status_check
  check (status in ('uploaded', 'queued', 'counting', 'processing', 'completed', 'failed', 'cancelled'));

notify pgrst, 'reload schema';
