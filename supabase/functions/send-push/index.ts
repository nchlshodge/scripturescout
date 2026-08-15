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
// so we can reuse the same "web-push" package used to generate the VAPID keys.
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // auto-provided to every Edge Function
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!; // e.g. "mailto:you@example.com"
const PUSH_WEBHOOK_SECRET = Deno.env.get("PUSH_WEBHOOK_SECRET")!; // shared secret checked against the webhook's custom header

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function serviceHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function fetchSubscriptions(userId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${userId}&select=endpoint,p256dh,auth`,
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
  await Promise.all(subs.map(async (sub: { endpoint: string; p256dh: string; auth: string }) => {
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
