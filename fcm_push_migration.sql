-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Extends push_subscriptions (originally Web Push only, see push_subscriptions.sql)
-- to also store Android FCM device tokens, so send-push can deliver to the
-- native Android app as well as browsers/PWA.

alter table push_subscriptions
  add column if not exists platform text not null default 'web',
  add column if not exists fcm_token text;

-- Web Push rows don't have an fcm_token; Android rows don't have endpoint/p256dh/auth.
alter table push_subscriptions alter column endpoint drop not null;
alter table push_subscriptions alter column p256dh drop not null;
alter table push_subscriptions alter column auth drop not null;

alter table push_subscriptions
  add constraint push_subscriptions_platform_shape check (
    (platform = 'web' and endpoint is not null and p256dh is not null and auth is not null)
    or (platform = 'android' and fcm_token is not null)
  );

-- A plain unique constraint (not a partial index) — Postgres already allows multiple
-- NULLs under a unique constraint, and PostgREST's on_conflict=fcm_token upsert needs
-- a real constraint/non-partial index as its arbiter, not a `where fcm_token is not null`
-- partial index (which caused a real "no unique or exclusion constraint matching the
-- ON CONFLICT specification" 400 on every Android registration until this was fixed).
alter table push_subscriptions
  add constraint push_subscriptions_fcm_token_key unique (fcm_token);
