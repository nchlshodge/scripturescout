-- Report alerts: tell the app owner(s) when a user or message is reported, via the existing
-- notifications -> send-push pipeline (in-app Alerts + push), and let them read reports in the app.
-- NOT YET APPLIED to the live project. Run in the Supabase SQL Editor, then add yourself as an admin
-- with the last statement (replace the username).

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.app_admins enable row level security;
-- Everyone can only see their own row, which is how the app knows whether to show the review screen.
create policy "Read own admin row" on public.app_admins for select to authenticated using (user_id = auth.uid());

-- Admins can read all reports (reporters could already insert their own).
create policy "Admins read reports" on public.user_reports for select to authenticated
  using (exists (select 1 from public.app_admins a where a.user_id = auth.uid()));

create or replace function public.notify_admins_of_report() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, type, message, data)
  select a.user_id, 'report',
         'New report: ' || new.reason || coalesce(' - "' || left(new.message_excerpt, 80) || '"', ''),
         jsonb_build_object('report_id', new.id)
  from public.app_admins a;
  return new;
end $$;

drop trigger if exists trg_notify_admins_of_report on public.user_reports;
create trigger trg_notify_admins_of_report
  after insert on public.user_reports
  for each row execute function public.notify_admins_of_report();

-- Make yourself an admin (edit the username first):
-- insert into public.app_admins (user_id) select id from public.profiles where username = 'YOUR_USERNAME';
