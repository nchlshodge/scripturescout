// Supabase Edge Function: send-push
//
// Triggered by two Database Webhooks (set up in the Supabase Dashboard, see
// ../../../PUSH_NOTIFICATIONS_SETUP.md for exact steps):
//   1. `notifications` table, INSERT  → covers friend requests, friend accepts,
//      challenges, and challenge results (createNotification() in index.html).
//   2. `messages` table, INSERT       → covers new chat messages, which never
//      touch the `notifications` table at all — sendMessage() in index.html
//      writes straight to `messages`, so it needs its own trigger.
//
// For each event this resolves who should be notified, looks up their stored
// Web Push subscriptions (push_subscriptions table), and sends a push to each
// one via VAPID. Expired/gone subscriptions (410/404) are deleted so they stop
// being retried on every future notification.
//
// Deno + npm compatibility (supported by Supabase Edge Functions) is used here
// so we can reuse the same "web-push" package used to generate the VAPID keys,
// plus "jose" to sign the JWT needed to get an FCM v1 OAuth access token below.
import webpush from "npm:web-push@3.6.7";
import * as jose from "npm:jose@5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // auto-provided to every Edge Function
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!; // e.g. "mailto:you@example.com"
const PUSH_WEBHOOK_SECRET = Deno.env.get("PUSH_WEBHOOK_SECRET")!; // shared secret checked against the webhook's custom header
// The full Firebase service account JSON (Project Settings → Service accounts →
// Generate new private key), used only to mint short-lived FCM send tokens.
// Optional: android subscriptions are just skipped until this secret is set.
const FIREBASE_SERVICE_ACCOUNT_JSON = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Cached across invocations within the same warm function instance so we're
// not re-signing a JWT and round-tripping to Google on every single push.
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

async function sendFcm(fcmToken: string, payload: { title: string; body: string; data?: Record<string, unknown> }) {
  const auth = await getFcmAuth();
  if (!auth) return; // FIREBASE_SERVICE_ACCOUNT_JSON not set yet — nothing to do until it is.
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${auth.projectId}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token: fcmToken,
        notification: { title: payload.title, body: payload.body },
        // FCM data payload values must all be strings.
        data: Object.fromEntries(Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])),
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 404 || text.includes("UNREGISTERED") || text.includes("NOT_FOUND")) {
      await deleteFcmToken(fcmToken);
    } else {
      console.warn("FCM send failed:", res.status, text);
    }
  }
}

async function deleteFcmToken(fcmToken: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?fcm_token=eq.${encodeURIComponent(fcmToken)}`,
    { method: "DELETE", headers: serviceHeaders() },
  );
}

function serviceHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function fetchSubscriptions(userId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${userId}&select=platform,endpoint,p256dh,auth,fcm_token`,
    { headers: serviceHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

async function deleteSubscription(endpoint: string) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
    { method: "DELETE", headers: serviceHeaders() },
  );
}

async function fetchOtherConversationMembers(conversationId: string, excludeUserId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/conversation_members?conversation_id=eq.${conversationId}&user_id=neq.${excludeUserId}&select=user_id`,
    { headers: serviceHeaders() },
  );
  if (!res.ok) return [];
  return res.json();
}

async function pushToUser(userId: string, payload: { title: string; body: string; data?: Record<string, unknown> }) {
  const subs = await fetchSubscriptions(userId);
  await Promise.all(subs.map(async (sub: { platform: string; endpoint: string; p256dh: string; auth: string; fcm_token: string }) => {
    if (sub.platform === "android") {
      await sendFcm(sub.fcm_token, payload);
      return;
    }
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
    } catch (err) {
      const statusCode = err?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await deleteSubscription(sub.endpoint);
      } else {
        console.warn("Push send failed:", statusCode, err?.message);
      }
    }
  }));
}

function messagePreview(record: { type: string; content: string }) {
  if (record.type === "score") return "🏆 Shared a score with you";
  if (record.type === "verse") return "📖 Shared a verse with you";
  return record.content;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-webhook-secret") !== PUSH_WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const payload = await req.json();
  const table = payload.table;
  const record = payload.record;

  if (table === "notifications") {
    await pushToUser(record.user_id, {
      title: "Scripture Scout",
      body: record.message,
      data: { type: record.type, ...record.data },
    });
  } else if (table === "messages") {
    const members = await fetchOtherConversationMembers(record.conversation_id, record.sender_id);
    const senderName = record.data?.username || "Someone";
    const body = messagePreview(record);
    await Promise.all(members.map((m: { user_id: string }) =>
      pushToUser(m.user_id, {
        title: senderName,
        body,
        data: { type: "message", conversation_id: record.conversation_id },
      })
    ));
  } else {
    return new Response("ignored: unhandled table", { status: 200 });
  }

  return new Response("ok", { status: 200 });
});
