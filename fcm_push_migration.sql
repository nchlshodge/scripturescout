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

create unique index if not exists push_subscriptions_fcm_token_idx
  on push_subscriptions(fcm_token) where fcm_token is not null;
