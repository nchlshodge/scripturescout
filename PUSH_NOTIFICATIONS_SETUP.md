# Setting up background push notifications

This wires up real Web Push notifications (friend requests, friend accepts,
challenges, challenge results, and new chat messages) that arrive even when
the browser/tab is closed. Everything on the client side (`index.html`,
`sw.js`) is already done and deployed. The remaining steps below all happen
in your Supabase project and only you can do them (they need your Supabase
account access).

Your project ref (from `SUPABASE_URL`) is: **`xzkxigwzoznefywsiwmb`**

Two secret values were generated for this and were given to you directly in
chat, NOT written into this repo (never commit them):
- `VAPID_PRIVATE_KEY`
- `PUSH_WEBHOOK_SECRET`

The matching public key is already embedded in `index.html` as
`VAPID_PUBLIC_KEY` — that one's fine to be public, it's just a normal git
commit.

## 1. Create the `push_subscriptions` table

In the Supabase Dashboard → **SQL Editor** → New query, paste and run the
contents of [`push_subscriptions.sql`](push_subscriptions.sql) from this repo.

## 2. Install the Supabase CLI

```bash
brew install supabase/tap/supabase
```

## 3. Log in and link this project

```bash
supabase login
supabase link --project-ref xzkxigwzoznefywsiwmb
```

Run this from inside the `supabase/` folder's parent directory (i.e. this
project's root, where the `supabase/functions/send-push` folder lives).

## 4. Deploy the Edge Function

```bash
supabase functions deploy send-push --no-verify-jwt
```

`--no-verify-jwt` is required because Database Webhooks (step 6) call the
function directly, without a user's Supabase Auth session — the function
instead checks the `x-webhook-secret` header against `PUSH_WEBHOOK_SECRET`
(step 5) to make sure only your webhooks can trigger it.

## 5. Set the function's secrets

```bash
supabase secrets set \
  VAPID_PUBLIC_KEY="<the public key from index.html>" \
  VAPID_PRIVATE_KEY="<the private key from chat>" \
  VAPID_SUBJECT="mailto:nick@rochesterchristian.church" \
  PUSH_WEBHOOK_SECRET="<the webhook secret from chat>"
```

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically to
every Edge Function — no need to set those.)

## 6. Create the two Database Webhooks

In the Dashboard → **Database** → **Webhooks** → *Create a new hook*, create
**two** webhooks (one per table), both pointing at the same function:

**Webhook A — friend requests / challenges / etc.**
- Table: `notifications`
- Events: `Insert`
- Type: `HTTP Request`
- Method: `POST`
- URL: `https://xzkxigwzoznefywsiwmb.supabase.co/functions/v1/send-push`
- Headers: `Content-Type: application/json`, `x-webhook-secret: <the webhook secret from chat>`

**Webhook B — new chat messages**
- Table: `messages`
- Events: `Insert`
- Type: `HTTP Request`
- Method: `POST`
- URL: `https://xzkxigwzoznefywsiwmb.supabase.co/functions/v1/send-push`
- Headers: same as above

(Messages don't go through the `notifications` table at all, so both
webhooks are needed to cover the full feature.)

## 7. Test it

1. In the app, sign in on a browser, open your Profile, and tap
   **"🔕 Enable Notifications"** — grant the permission prompt.
2. From a second account (or ask a friend), send that user a friend request,
   or send them a chat message.
3. You should get a real OS-level notification — even if you've closed the
   Scripture Scout tab entirely (the browser just needs to still be running;
   fully quitting the browser will, like any web push, queue the notification
   for delivery next time it's running, same as email/Slack notifications).

If nothing arrives, check **Database → Webhooks → (the hook) → Logs** in the
Supabase Dashboard to see whether the webhook fired and what the function
returned, and check **Edge Functions → send-push → Logs** for errors from the
function itself.

Note: in practice the `notifications`/`messages` → `send-push` wiring above
ended up done as direct SQL (a `trigger_send_push()` Postgres function using
`pg_net.http_post`, attached as an `AFTER INSERT` trigger on both tables)
rather than through the Dashboard's Webhooks UI, since that UI wasn't showing
up. Functionally identical — same headers, same secret check — just set up
via `supabase db query` instead of the Dashboard.

## 8. Daily "come play" reminder (separate from the above)

A second Edge Function, `send-daily-reminders`, sends a once-a-day nudge to
every user who has a stored push subscription but hasn't played yet today
(checked against `streaks.last_played_date`). Unlike the notifications above,
this isn't triggered by a database write — it's triggered by a `pg_cron` job
that fires on a fixed schedule and does a single `pg_net.http_post` to the
function (mirroring the same `x-webhook-secret` check as `send-push`).

- Deploy: `supabase functions deploy send-daily-reminders --no-verify-jwt`
- Uses the same `VAPID_*` and `PUSH_WEBHOOK_SECRET` secrets as `send-push` —
  nothing new to configure there.
- The `pg_cron` job (`daily-scout-reminder`) is scheduled at `0 22 * * *`
  (22:00 UTC = 6 PM Eastern **during EDT**). Because the cron schedule is a
  fixed UTC time and doesn't know about Daylight Saving, it'll effectively
  fire at 5 PM Eastern once EST resumes in November — re-run the schedule
  command below with `'0 23 * * *'` at that point if you want to hold it at
  6 PM year-round:
  ```sql
  select cron.unschedule('daily-scout-reminder');
  select cron.schedule('daily-scout-reminder', '0 23 * * *', $$select net.http_post(
    url:='https://xzkxigwzoznefywsiwmb.supabase.co/functions/v1/send-daily-reminders',
    headers:=jsonb_build_object('Content-Type','application/json','x-webhook-secret','<the webhook secret from chat>'),
    body:='{}'::jsonb
  );$$);
  ```
- Check `select * from cron.job;` and `select * from cron.job_run_details order by start_time desc limit 5;`
  in the SQL Editor to see whether it's scheduled and how recent runs went.
