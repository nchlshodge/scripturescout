-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Creates the table that stores each browser/device's Web Push subscription,
-- so the send-push Edge Function knows where to deliver a notification for a given user.

create table if not exists push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subscriptions_user_id_idx on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

-- A signed-in user may only see, create, and remove their own subscriptions.
-- (The send-push Edge Function reads across all users via the service_role key,
-- which bypasses RLS entirely, so no separate policy is needed for it.)
create policy "Users can view their own push subscriptions"
  on push_subscriptions for select
  using (auth.uid() = user_id);

create policy "Users can insert their own push subscriptions"
  on push_subscriptions for insert
  with check (auth.uid() = user_id);

-- Needed because re-subscribing upserts on the unique `endpoint` (insert ... on conflict do update).
create policy "Users can update their own push subscriptions"
  on push_subscriptions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own push subscriptions"
  on push_subscriptions for delete
  using (auth.uid() = user_id);
