-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Adds user-to-user blocking and reporting, needed for Apple App Review Guideline
-- 1.2 (apps with user-to-user communication must let users block/report each other).

create table if not exists blocked_users (
  id bigint generated always as identity primary key,
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id)
);

create index if not exists blocked_users_blocker_idx on blocked_users(blocker_id);
create index if not exists blocked_users_blocked_idx on blocked_users(blocked_id);

alter table blocked_users enable row level security;

create policy "Users can view their own blocks"
  on blocked_users for select
  using (auth.uid() = blocker_id);

create policy "Users can create their own blocks"
  on blocked_users for insert
  with check (auth.uid() = blocker_id);

create policy "Users can remove their own blocks"
  on blocked_users for delete
  using (auth.uid() = blocker_id);

create table if not exists user_reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  reported_username text,
  reason text not null,
  details text,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create index if not exists user_reports_reported_idx on user_reports(reported_user_id);

alter table user_reports enable row level security;

-- Reporters can file and see their own reports. No update/delete policy for
-- regular users — review happens manually via the Supabase dashboard for now.
create policy "Users can file reports"
  on user_reports for insert
  with check (auth.uid() = reporter_id);

create policy "Users can view their own filed reports"
  on user_reports for select
  using (auth.uid() = reporter_id);
