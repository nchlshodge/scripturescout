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
import * as jose from "npm:jose@5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // auto-provided to every Edge Function
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;
const PUSH_WEBHOOK_SECRET = Deno.env.get("PUSH_WEBHOOK_SECRET")!; // shared secret checked against the cron job's custom header
// Same optional secret as send-push — see that function for what it's for.
const FIREBASE_SERVICE_ACCOUNT_JSON = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");

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

let cachedFcmAuth: { token: string; projectId: string; expiresAt: number } | null = null;

async function getFcmAuth(): Promise<{ token: string; projectId: string } | null> {
  if (!FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cachedFcmAuth && cachedFcmAuth.expiresAt > now + 60) return cachedFcmAuth;

  const sa = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
  const privateKey = await jose.importPKCS8(sa.private_key, "RS256");
  const jwt = await new jose.SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) {
    console.warn("FCM OAuth token fetch failed:", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  cachedFcmAuth = { token: data.access_token, projectId: sa.project_id, expiresAt: now + data.expires_in };
  return cachedFcmAuth;
}

async function deleteFcmToken(fcmToken: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?fcm_token=eq.${encodeURIComponent(fcmToken)}`,
    { method: "DELETE", headers: serviceHeaders() },
  );
}

async function sendFcm(fcmToken: string, title: string, body: string, data: Record<string, unknown>) {
  const auth = await getFcmAuth();
  if (!auth) return;
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${auth.projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title, body },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 || text.includes("UNREGISTERED") || text.includes("NOT_FOUND")) {
      await deleteFcmToken(fcmToken);
    } else {
      console.warn("Daily reminder FCM send failed:", res.status, text);
    }
  }
}

async function fetchUsersNeedingReminder() {
  // The app records last_played_date using each player's own LOCAL clock, but this
  // function only knows the server's UTC date, which can drift a day either direction
  // from a player's local date depending on their timezone (ahead of UTC → their local
  // date can already be "tomorrow"; behind UTC → it can still be "yesterday"). Treat the
  // full [yesterday, today, tomorrow] UTC window as "already played" — cheap insurance
  // against double-pinging anyone near the day boundary, regardless of timezone.
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  const yesterday = new Date(now.getTime() - 86400000).toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().split("T")[0];

  // Every subscribed user, with their streak row (if any) left-joined via a second query —
  // PostgREST can't left join, so fetch subscriptions + streaks separately and combine here.
  const [subs, streaks] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=user_id,platform,endpoint,p256dh,auth,fcm_token`, { headers: serviceHeaders() }).then(r => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/streaks?select=user_id,current_streak,last_played_date`, { headers: serviceHeaders() }).then(r => r.json()),
  ]);

  const streakByUser = new Map(streaks.map((s: { user_id: string }) => [s.user_id, s]));
  const byUser = new Map<string, { subs: any[]; streak: any }>();
  for (const sub of subs) {
    const streak = streakByUser.get(sub.user_id);
    if (streak && [yesterday, today, tomorrow].includes(streak.last_played_date)) continue; // already played today (allowing for UTC/local date drift)
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
    const title = "Scripture Scout";
    const body = reminderMessage(streak);
    const payload = JSON.stringify({ title, body, data: { type: "daily_reminder" } });
    await Promise.all(subs.map(async (sub: { platform: string; endpoint: string; p256dh: string; auth: string; fcm_token: string }) => {
      if (sub.platform === "android") {
        await sendFcm(sub.fcm_token, title, body, { type: "daily_reminder" });
        sent++;
        return;
      }
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
