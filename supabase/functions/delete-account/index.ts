// Supabase Edge Function: delete-account
//
// Called by the client (see deleteAccount() in index.html) when a signed-in
// user taps "Delete Account" in their Profile. Most tables with a user_id
// column DO have an ON DELETE CASCADE foreign key back to auth.users, so
// deleting the auth user alone would clean most of this up automatically —
// but three don't (checked directly against pg_constraint, not assumed):
// flashcard_progress.user_id, story_progress.user_id, and
// conversations.created_by are all ON DELETE "NO ACTION", meaning
// admin.deleteUser() fails outright with a foreign key violation if any rows
// referencing that user still exist there. Deleting conversations also
// cascades to conversation_members and messages for that conversation, so a
// deleted user's chats disappear for the other party too, not just for them.
// Every other table below is deleted explicitly anyway rather than relying on
// the cascade, so this keeps working even if a cascade rule ever changes.
//
// verify_jwt is left on (the default) since this is called by a real signed-in
// user, not a webhook/cron job — Supabase rejects the request before it even
// reaches this code if the bearer token isn't a valid session JWT. This
// function additionally re-derives the user from that same JWT (rather than
// trusting a user id the client could pass in) so a user can only ever delete
// their own account.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// This function is called directly from the browser/app (unlike send-push or
// send-daily-reminders, which are only ever called server-side by a webhook
// or cron job), so it needs real CORS handling or the browser blocks the
// request at the preflight stage before any of this code even runs.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// [table, column] — every place a user's own data lives outside auth.users.
const USER_DATA_TABLES: [string, string][] = [
  ["profiles", "id"],
  ["flashcard_progress", "user_id"],
  ["leaderboard", "user_id"],
  ["leaderboard_daily", "user_id"],
  ["leaderboard_memory", "user_id"],
  ["leaderboard_mia", "user_id"],
  ["leaderboard_track", "user_id"],
  ["leaderboard_trivia", "user_id"],
  ["notifications", "user_id"],
  ["push_subscriptions", "user_id"],
  ["story_progress", "user_id"],
  ["streaks", "user_id"],
  ["user_scores", "user_id"],
  ["conversation_members", "user_id"],
  ["messages", "sender_id"],
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });

  // Verify the caller against their own JWT — never trust a client-supplied user id.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser();
  if (callerError || !callerData?.user) return new Response("unauthorized", { status: 401, headers: CORS_HEADERS });
  const userId = callerData.user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  for (const [table, column] of USER_DATA_TABLES) {
    const { error } = await admin.from(table).delete().eq(column, userId);
    if (error) console.warn(`Cleanup failed on ${table}:`, error.message);
  }
  // friends and challenges each store the relationship both directions.
  await admin.from("friends").delete().eq("user_id", userId);
  await admin.from("friends").delete().eq("friend_id", userId);
  await admin.from("challenges").delete().eq("challenger_id", userId);
  await admin.from("challenges").delete().eq("opponent_id", userId);
  // conversations.created_by is ON DELETE NO ACTION — without this,
  // deleteUser() below fails for anyone who has ever started a chat.
  await admin.from("conversations").delete().eq("created_by", userId);

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    return new Response(JSON.stringify({ error: deleteError.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
