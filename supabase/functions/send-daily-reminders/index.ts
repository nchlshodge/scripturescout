// Supabase Edge Function: send-daily-reminders
//
// Triggered once a day by a pg_cron job (see PUSH_NOTIFICATIONS_SETUP.md)
// that does a single pg_net HTTP POST to this function — no per-user logic
// lives in SQL. This function finds every user who:
//   1. Has at least one stored Web Push subscription, and
//   2. Has not played today (streaks.last_played_date is null or before today)
// and sends each of them a friendly reminder push. Expired/gone subscriptions
// (410/404) are deleted so they stop being retried on every future run.
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // auto-provided to every Edge Function
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;
const PUSH_WEBHOOK_SECRET = Deno.env.get("PUSH_WEBHOOK_SECRET")!; // shared secret checked against the cron job's custom header

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function serviceHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function deleteSubscription(endpoint: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers: serviceHeaders() },
  );
}

async function fetchUsersNeedingReminder() {
  const today = new Date().toISOString().split("T")[0];
  // Every subscribed user, with their streak row (if any) left-joined via a second query —
  // PostgREST can't left join, so fetch subscriptions + streaks separately and combine here.
  const [subs, streaks] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=user_id,endpoint,p256dh,auth`, { headers: serviceHeaders() }).then(r => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/streaks?select=user_id,current_streak,last_played_date`, { headers: serviceHeaders() }).then(r => r.json()),
  ]);

  const streakByUser = new Map(streaks.map((s: { user_id: string }) => [s.user_id, s]));
  const byUser = new Map<string, { subs: any[]; streak: any }>();
  for (const sub of subs) {
    const streak = streakByUser.get(sub.user_id);
    if (streak && streak.last_played_date === today) continue; // already played today
    if (!byUser.has(sub.user_id)) byUser.set(sub.user_id, { subs: [], streak });
    byUser.get(sub.user_id)!.subs.push(sub);
  }
  return byUser;
}

function reminderMessage(streak?: { current_streak: number }) {
  const n = streak?.current_streak || 0;
  if (n >= 2) {
    return `🦁 Randy's holding your ${n}-day streak — don't let it slip! Come do today's Scripture Scout.`;
  }
  return `🦁 Randy's Field Guide is waiting. Got a minute for today's Scripture Scout?`;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== PUSH_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const byUser = await fetchUsersNeedingReminder();
  let sent = 0;

  await Promise.all(Array.from(byUser.entries()).map(async ([_userId, { subs, streak }]) => {
    const payload = JSON.stringify({
      title: "Scripture Scout",
      body: reminderMessage(streak),
      data: { type: "daily_reminder" },
    });
    await Promise.all(subs.map(async (sub: { endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (err) {
        const statusCode = err?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await deleteSubscription(sub.endpoint);
        } else {
          console.warn("Daily reminder push failed:", statusCode, err?.message);
        }
      }
    }));
  }));

  return new Response(JSON.stringify({ ok: true, usersNotified: byUser.size, pushesSent: sent }), {
    headers: { "Content-Type": "application/json" },
  });
});
