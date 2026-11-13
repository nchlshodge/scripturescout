// Chat moderation: the word filter (and that the database copy matches it), sending, showing messages,
// blocking users, reporting users and messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadApp, get, fakeIntervals } = require('./helpers');

const ME = 'me-1', THEM = 'them-2', OTHER = 'other-3';

// A signed-in app with a fake server that records every request.
function setup({ fetchStatus = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const rec = { url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(rec);
    const key = Object.keys(fetchStatus).find(k => u.includes(k));
    const status = key ? fetchStatus[key] : 200;
    return { ok: status >= 200 && status < 300, status, json: async () => [], text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  fakeIntervals(w);
  w.eval(`currentUser = { id: '${ME}' }; authToken = 'tok'; currentUsername = 'Me';`);
  w.eval('globalThis.__opened = 0; globalThis.openConversation = async () => { __opened++; };');
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute('role') === 'status').map(c => c.textContent);
  return { ...app, calls, toasts, post: (frag) => calls.filter(c => c.method === 'POST' && c.url.includes(frag)) };
}

function addInput(w, value) {
  const i = w.document.createElement('input'); i.id = 'msgInput'; i.value = value; w.document.body.appendChild(i); return i;
}

// ── The word filter and its database copy ──────────────

test('the database filter uses the same word list as the app', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'chat_moderation_migration.sql'), 'utf8');
  const sqlWords = sql.match(/\\m\(([^)]*(?:\([^)]*\)[^)]*)*)\)\\M/)[1];
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const jsWords = html.match(/OBJECTIONABLE_RE = \/\\b\(([^/]*)\)\\b\/gi/)[1];
  assert.equal(sqlWords, jsWords, 'update both lists together');
});

test('the database filter swaps the same look-alike characters as the app', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'chat_moderation_migration.sql'), 'utf8');
  const [, from, to] = sql.match(/translate\(new\.content, '([^']+)', '([^']+)'\)/);
  const app = loadApp();
  const deob = get(app.window, '_deobfuscate');
  for (let i = 0; i < from.length; i++) assert.equal(deob(from[i]), to[i], `${from[i]} -> ${to[i]}`);
  app.close();
});

test('the filter catches common evasions and leaves ordinary and Bible words alone', () => {
  const app = loadApp(); const bad = get(app.window, 'isObjectionable');
  for (const t of ['FUCK', 'fuckers', 'Shit.', 'you b1tch', 'a$$hole', 'kill  yourself', 'you are a slut', 'RETARDED'])
    assert.equal(bad(t), true, t);
  for (const t of ['', 'Hello!', 'Grape juice', 'Scunthorpe', 'Classic', 'Assyrian army', 'The Lord is my shepherd', 'Psalm 23:4', 'passion', 'Dickens', 'bitcoin', 'therapist'])
    assert.equal(bad(t), false, t);
  app.close();
});

test('the filter gives the same answer every time it is used (no leftover state)', () => {
  const app = loadApp(); const bad = get(app.window, 'isObjectionable');
  for (let i = 0; i < 5; i++) { assert.equal(bad('sh!t'), true); assert.equal(bad('hello'), false); }
  app.close();
});

// ── Sending ────────────────────────────────────────────

test('a clean message is sent to the right conversation as the right person', async () => {
  const s = setup(); const input = addInput(s.window, '  Good morning!  ');
  await get(s.window, 'sendMessage')('conv-9');
  const sent = s.post('/rest/v1/messages');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.conversation_id, 'conv-9');
  assert.equal(sent[0].body.sender_id, ME);
  assert.equal(sent[0].body.content, 'Good morning!');
  assert.equal(sent[0].body.type, 'text');
  assert.equal(sent[0].body.data.username, 'Me');
  assert.equal(input.value, '', 'box is cleared after sending');
  assert.equal(s.window.__opened, 1, 'conversation reloads');
  s.close();
});

test('a message with blocked language is not sent, and what the player typed stays in the box', async () => {
  const s = setup(); const input = addInput(s.window, 'what the f$ck');
  input.value = 'you are a b1tch';
  await get(s.window, 'sendMessage')('conv-9');
  assert.equal(s.post('/rest/v1/messages').length, 0);
  assert.equal(input.value, 'you are a b1tch');
  assert.ok(s.toasts().some(t => /language we don't allow/.test(t)));
  s.close();
});

test('empty and whitespace-only messages are ignored', async () => {
  const s = setup(); addInput(s.window, '   ');
  await get(s.window, 'sendMessage')('conv-9');
  assert.equal(s.calls.length, 0);
  s.close();
});

test('shared verses and scores skip the typed-text filter (Bible text is never blocked)', async () => {
  const s = setup();
  await get(s.window, 'sendMessage')('conv-9', 'verse', 'He cast out the bastard of the flock', { ref: 'Test 1:1' });
  assert.equal(s.post('/rest/v1/messages').length, 1);
  s.close();
});

test('if the server refuses the message for language, the text comes back and the player is told', async () => {
  const s = setup({ fetchStatus: { '/rest/v1/messages': 400 } }); const input = addInput(s.window, 'a sneaky one');
  await get(s.window, 'sendMessage')('conv-9');
  assert.equal(input.value, 'a sneaky one');
  assert.ok(s.toasts().some(t => /language we don't allow/.test(t)));
  assert.equal(s.window.__opened, 0, "doesn't pretend it was sent");
  s.close();
});

test('if sending fails for any other reason, the text comes back with a retry message', async () => {
  const s = setup({ fetchStatus: { '/rest/v1/messages': 500 } }); const input = addInput(s.window, 'hello again');
  await get(s.window, 'sendMessage')('conv-9');
  assert.equal(input.value, 'hello again');
  assert.ok(s.toasts().some(t => /Could not send/.test(t)));
  s.close();
});

// ── Showing a conversation ─────────────────────────────

async function openChat(rows) {
  const app = loadApp(); const w = app.window;
  fakeIntervals(w);
  w.__rows = rows;
  w.eval(`
    currentUser = { id: '${ME}' }; authToken = 't'; currentUsername = 'Me';
    globalThis.sbFetch = async (p) => p.startsWith('messages?') ? window.__rows : [];
  `);
  return { ...app, open: () => get(w, 'openConversation')('c1', 'Chat', 'direct') };
}
const msg = (id, sender, content, extra = {}) => ({ id, conversation_id: 'c1', sender_id: sender, content, type: 'text', data: { username: sender === ME ? 'Me' : 'Them' }, created_at: new Date().toISOString(), ...extra });
const bubbles = w => [...w.document.querySelectorAll('.msg-bubble')];

test('blocked words that got through are hidden with asterisks when shown', async () => {
  const c = await openChat([msg(1, THEM, 'you a$$hole, see you at 5')]);
  await c.open();
  assert.equal(bubbles(c.window)[0].textContent.trim(), 'you *******, see you at 5');
  c.close();
});

test('messages from someone you blocked are not shown, others are', async () => {
  const c = await openChat([msg(1, THEM, 'hi from blocked'), msg(2, OTHER, 'hi from friend'), msg(3, ME, 'my own')]);
  c.window.eval(`blockedUserIds = new Set(['${THEM}'])`);
  await c.open();
  const texts = bubbles(c.window).map(b => b.textContent.trim());
  assert.deepEqual(texts, ['hi from friend', 'my own']);
  c.close();
});

test("message text and usernames can't inject markup", async () => {
  const c = await openChat([msg(1, THEM, '<img src=x onerror="window.__xss=1">', { data: { username: '<b onmouseover=1>Evil</b>' } })]);
  await c.open();
  assert.equal(c.window.document.querySelectorAll('#msgList img, #msgList b').length, 0);
  assert.equal(c.window.__xss, undefined);
  assert.match(c.window.document.getElementById('msgList').textContent, /<img src=x/);
  c.close();
});

test('each bubble carries who sent it, so a report names the right person', async () => {
  const c = await openChat([msg(7, THEM, 'hello')]);
  await c.open();
  const b = bubbles(c.window)[0];
  assert.equal(b.dataset.msgId, '7'); assert.equal(b.dataset.sender, THEM); assert.equal(b.dataset.sname, 'Them');
  c.close();
});

// ── Blocking ───────────────────────────────────────────

test('blocking records the block, ends the friendship, and hides their messages from then on', async () => {
  const s = setup(); s.window.eval('globalThis.renderProfile = () => {};');
  await get(s.window, 'blockUser')(THEM, 'Them');
  const blocks = s.post('/rest/v1/blocked_users');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].body, { blocker_id: ME, blocked_id: THEM });
  const del = s.calls.find(c => c.method === 'DELETE' && c.url.includes('/rest/v1/friends'));
  assert.ok(del, 'friendship removed');
  assert.ok(del.url.includes(`user_id.eq.${ME}`) && del.url.includes(`friend_id.eq.${THEM}`) && del.url.includes(`user_id.eq.${THEM}`));
  assert.equal(get(s.window, 'isBlocked')(THEM), true);
  assert.equal(get(s.window, 'isBlocked')(OTHER), false);
  s.close();
});

test('you cannot block yourself', async () => {
  const s = setup();
  await get(s.window, 'blockUser')(ME, 'Me');
  assert.equal(s.calls.length, 0);
  assert.equal(get(s.window, 'isBlocked')(ME), false);
  s.close();
});

test('if the block cannot be saved, the player is told and the person is not treated as blocked', async () => {
  const s = setup({ fetchStatus: { '/rest/v1/blocked_users': 403 } }); s.window.eval('globalThis.renderProfile = () => {};');
  await get(s.window, 'blockUser')(THEM, 'Them');
  assert.equal(get(s.window, 'isBlocked')(THEM), false);
  assert.ok(s.toasts().some(t => /Could not block/.test(t)));
  s.close();
});

test('unblocking removes the block and shows their messages again', async () => {
  const s = setup(); s.window.eval(`globalThis.renderProfile = () => {}; blockedUserIds = new Set(['${THEM}']);`);
  await get(s.window, 'unblockUser')(THEM, 'Them');
  assert.ok(s.calls.some(c => c.method === 'DELETE' && c.url.includes('blocked_users') && c.url.includes(`blocked_id=eq.${THEM}`)));
  assert.equal(get(s.window, 'isBlocked')(THEM), false);
  s.close();
});

test('a failed unblock leaves the person blocked', async () => {
  const s = setup({ fetchStatus: { 'blocked_users': 500 } }); s.window.eval(`globalThis.renderProfile = () => {}; blockedUserIds = new Set(['${THEM}']);`);
  await get(s.window, 'unblockUser')(THEM, 'Them');
  assert.equal(get(s.window, 'isBlocked')(THEM), true);
  assert.ok(s.toasts().some(t => /Could not unblock/.test(t)));
  s.close();
});

test('you cannot send a friend request to someone you have blocked', async () => {
  const s = setup(); s.window.eval(`blockedUserIds = new Set(['${THEM}'])`);
  await get(s.window, 'sendFriendRequest')(THEM, 'Them');
  assert.equal(s.post('/rest/v1/friends').length, 0);
  assert.ok(s.toasts().some(t => /unblock them first/.test(t)));
  s.close();
});

test('the block list is cleared on sign-out so it never carries to the next account', async () => {
  const s = setup(); s.window.eval(`blockedUserIds = new Set(['${THEM}'])`);
  await get(s.window, 'signOut')();
  assert.equal(get(s.window, 'isBlocked')(THEM), false);
  s.close();
});

// ── Reporting ──────────────────────────────────────────

test('reporting a user sends who, why, and the details', async () => {
  const s = setup(); const w = s.window;
  get(w, 'showReportModal')(THEM, 'Them');
  w.document.getElementById('reportReasonField').value = 'Harassment';
  w.document.getElementById('reportDetailsField').value = '  keeps messaging me  ';
  await get(w, 'submitReport')(THEM, 'Them');
  const r = s.post('/rest/v1/user_reports');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].body, { reporter_id: ME, reported_user_id: THEM, reported_username: 'Them', reason: 'Harassment', details: 'keeps messaging me', message_id: null, message_excerpt: null });
  assert.equal(w.document.getElementById('reportModalOverlay'), null, 'the form closes');
  assert.ok(s.toasts().some(t => /Report submitted/.test(t)));
  s.close();
});

test('reporting a message also sends which message and what it said', async () => {
  const s = setup(); const w = s.window;
  w.document.body.insertAdjacentHTML('beforeend', `<div class="msg-bubble" data-msg-id="41" data-sender="${THEM}">  a rude thing  </div>`);
  get(w, 'showReportModal')(THEM, 'Them', 41);
  w.document.getElementById('reportReasonField').value = 'Inappropriate content';
  await get(w, 'submitReport')(THEM, 'Them');
  const body = s.post('/rest/v1/user_reports')[0].body;
  assert.equal(body.message_id, 41);
  assert.equal(body.message_excerpt, 'a rude thing');
  s.close();
});

test('the report keeps the original words even when the screen shows them masked', async () => {
  // So whoever reviews it sees what was actually said, not asterisks.
  const c = await openChat([msg(5, THEM, 'you a$$hole')]);
  c.window.eval(`globalThis.fetch = async (u, o) => { (window.__sent = window.__sent || []).push({ u: String(u), body: o && o.body }); return { ok: true, status: 201 }; };`);
  await c.open();
  get(c.window, 'showReportModal')(THEM, 'Them', 5);
  await get(c.window, 'submitReport')(THEM, 'Them');
  const sent = JSON.parse(c.window.__sent.find(x => x.u.includes('user_reports')).body);
  assert.equal(sent.message_excerpt, 'you a$$hole');
  c.close();
});

test('a report about a person after a report about a message does not reuse the old message', async () => {
  const s = setup(); const w = s.window;
  w.document.body.insertAdjacentHTML('beforeend', `<div class="msg-bubble" data-msg-id="41">text</div>`);
  get(w, 'showReportModal')(THEM, 'Them', 41);
  w.document.getElementById('reportModalOverlay').remove();             // cancelled
  get(w, 'showReportModal')(THEM, 'Them');                               // later, from their profile
  await get(w, 'submitReport')(THEM, 'Them');
  const body = s.post('/rest/v1/user_reports')[0].body;
  assert.equal(body.message_id, null); assert.equal(body.message_excerpt, null);
  s.close();
});

test('if the report cannot be sent, the form stays open and the player is told', async () => {
  const s = setup({ fetchStatus: { '/rest/v1/user_reports': 500 } }); const w = s.window;
  get(w, 'showReportModal')(THEM, 'Them');
  await get(w, 'submitReport')(THEM, 'Them');
  assert.ok(w.document.getElementById('reportModalOverlay'), 'form is still there to retry');
  assert.ok(s.toasts().some(t => /Could not submit report/.test(t)));
  assert.ok(!s.toasts().some(t => /Report submitted/.test(t)));
  s.close();
});

test('the reaction menu offers Report for other people\'s messages, never for your own', () => {
  const s = setup(); const w = s.window;
  w.document.body.insertAdjacentHTML('beforeend', `<div class="msg-bubble" data-msg-id="1" data-sender="${THEM}" data-sname="Them">hi</div><div class="msg-bubble" data-msg-id="2" data-sender="${ME}" data-sname="Me">mine</div>`);
  get(w, 'showReactionPicker')(1);
  assert.ok(w.document.querySelector('#reactionPicker button[aria-label="Report this message"]'));
  get(w, 'showReactionPicker')(2);
  assert.equal(w.document.querySelector('#reactionPicker button[aria-label="Report this message"]'), null);
  s.close();
});

test('the report form lists the expected reasons', () => {
  const s = setup(); const w = s.window;
  get(w, 'showReportModal')(THEM, 'Them');
  const reasons = [...w.document.querySelectorAll('#reportReasonField option')].map(o => o.value);
  assert.deepEqual(reasons, ['Harassment', 'Spam', 'Inappropriate content', 'Impersonation', 'Other']);
  s.close();
});
