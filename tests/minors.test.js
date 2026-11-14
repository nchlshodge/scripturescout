// Extra limits for players aged 13-17. The rules themselves are enforced by the database (see
// minor_safety_migration.sql, checked against the live database when it was applied); these tests cover
// the app side: how it searches, what it says when the server refuses, and that the SQL keeps its guarantees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadApp, get } = require('./helpers');

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ME = 'me-1', ANN = 'ann-2';
const SQL = fs.readFileSync(path.join(ROOT, 'minor_safety_migration.sql'), 'utf8');

function setup({ rules = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    url = String(url);
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const rule = rules.find(r => url.includes(r.match) && (!r.method || r.method === (opts.method || 'GET')));
    const status = (rule && rule.status) || 200;
    const json = url.includes('/rest/v1/conversations') && opts.method === 'POST' ? [{ id: 'conv-1' }] : (rule && rule.json) || [];
    return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  w.eval(`currentUser = { id: '${ME}' }; authToken = 't'; currentUsername = 'Me';
    globalThis.renderAuthScreen = () => {}; globalThis.__toasts = []; globalThis.showStreakToast = m => __toasts.push(m);
    globalThis.__opened = []; globalThis.openConversation = async (...a) => { __opened.push(a); };`);
  return { ...app, w, calls, call: (n, ...a) => get(w, n)(...a), toasts: () => Array.from(w.eval('__toasts')) };
}

test('friend search asks the server function that leaves out players under 18, not the profiles table directly', async () => {
  const s = setup({ rules: [{ match: 'rpc/search_players', json: [{ id: ANN, username: 'Ann' }] }] });
  s.w.eval(`globalThis.getUsername = id => id; window._friendsData = {};`);
  await s.call('renderFriends', 'add');
  const input = s.w.document.getElementById('friendSearch');
  input.value = '50%_ann'; input.dispatchEvent(new s.w.Event('input'));
  await wait(60);
  const rpc = s.calls.find(c => c.url.includes('/rpc/search_players'));
  assert.ok(rpc, 'uses the function');
  assert.equal(rpc.method, 'POST');
  assert.equal(rpc.body.p_query, '50%_ann', 'sent as typed: the server escapes it');
  assert.ok(!s.calls.some(c => /profiles\?select=id,username&limit=5/.test(c.url)), 'no direct profile search');
  s.close();
});

test('an empty search result explains that players under 18 are not in search', async () => {
  const s = setup({ rules: [{ match: 'rpc/search_players', json: [] }] });
  s.w.eval(`globalThis.getUsername = id => id; window._friendsData = {};`);
  await s.call('renderFriends', 'add');
  const input = s.w.document.getElementById('friendSearch');
  input.value = 'zed'; input.dispatchEvent(new s.w.Event('input'));
  await wait(60);
  const text = s.w.document.getElementById('friendSearchResults').textContent;
  assert.match(text, /No users found for "zed"/);
  assert.match(text, /Players under 18 don't show up in search/);
  assert.match(text, /invite link/);
  s.close();
});

test('the Add Friend tab still offers the invite link, which is how players under 18 are added', async () => {
  const s = setup();
  s.w.eval(`globalThis.getUsername = id => id; window._friendsData = {};`);
  await s.call('renderFriends', 'add');
  assert.match(s.w.document.getElementById('root').innerHTML, /\?invite=me-1/);
  s.close();
});

// ── What the app says when the server refuses ────────────

test('a message the server refuses because of the friends-only rule says so, not "bad language"', async () => {
  const s = setup({ rules: [{ match: '/rest/v1/messages', status: 403 }] });
  s.w.document.body.insertAdjacentHTML('beforeend', '<input id="msgInput" value="hello there">');
  await s.call('sendMessage', 'c1');
  const t = s.toasts();
  assert.ok(t.includes('Chats with players under 18 are limited to friends.'));
  assert.ok(!t.some(x => /language/.test(x)));
  assert.equal(s.w.document.getElementById('msgInput').value, 'hello there', 'the typed text is kept');
  s.close();
});

test('the other message failures keep their own messages', async () => {
  const bad = setup({ rules: [{ match: '/rest/v1/messages', status: 400 }] });
  bad.w.document.body.insertAdjacentHTML('beforeend', '<input id="msgInput" value="hello">');
  await bad.call('sendMessage', 'c1');
  assert.ok(bad.toasts().some(x => /language we don't allow/.test(x)));
  bad.close();
  const down = setup({ rules: [{ match: '/rest/v1/messages', status: 500 }] });
  down.w.document.body.insertAdjacentHTML('beforeend', '<input id="msgInput" value="hello">');
  await down.call('sendMessage', 'c1');
  assert.ok(down.toasts().some(x => /Could not send/.test(x)));
  down.close();
});

test('starting a direct chat the server refuses explains the friends-only rule and does not open an empty chat', async () => {
  const s = setup({ rules: [{ match: '/rest/v1/conversation_members', status: 403, method: 'POST' }] });
  s.w.eval(`globalThis.sbFetch = async () => [];`);
  await s.call('openDirectMessage', ANN, 'Ann');
  await wait();
  assert.ok(s.toasts().includes('Chats with players under 18 are limited to friends.'));
  assert.equal(s.w.eval('__opened.length'), 0);
  s.close();
});

test('adding a player to a group chat is refused with a clear message, and other failures keep their message', async () => {
  const refuse = setup({ rules: [{ match: '/rest/v1/conversation_members', status: 403, method: 'POST' }] });
  refuse.w.eval(`globalThis.showTextInputModal = async () => 'Ann'; globalThis.sbFetch = async () => [{ id: '${ANN}', username: 'Ann' }];`);
  await refuse.call('addGroupMember', 'conv-1');
  assert.ok(refuse.toasts().includes('Players under 18 can only be added to a chat by their friends.'));
  refuse.close();
  const other = setup({ rules: [{ match: '/rest/v1/conversation_members', status: 409, method: 'POST' }] });
  other.w.eval(`globalThis.showTextInputModal = async () => 'Ann'; globalThis.sbFetch = async () => [{ id: '${ANN}', username: 'Ann' }];`);
  await other.call('addGroupMember', 'conv-1');
  assert.ok(other.toasts().some(t => /may already be in the group/.test(t)));
  other.close();
});

// ── The database migration keeps its guarantees ──────────

test('the migration counts "under 18" with caution: a missing age counts as under 18', () => {
  assert.match(SQL, /coalesce\(\s*\(select[\s\S]*?\),\s*true\)/, 'no age on file => minor');
  assert.match(SQL, /< 18 \* 12 \+ 1/, 'adult only once a full month has passed after the 18th birthday month');
});

test('nobody can ask the database "is this person a minor?" from the app', () => {
  assert.match(SQL, /revoke all on function public\.is_minor\(uuid\) from public, anon, authenticated/);
  assert.match(SQL, /revoke all on function public\.are_friends\(uuid, uuid\) from public, anon, authenticated/);
  assert.doesNotMatch(SQL, /grant execute on function public\.(is_minor|are_friends)/i);
});

test('both chat rules refuse with 403 (PT403), skip server-side work, and only apply to direct chats for messages', () => {
  assert.equal((SQL.match(/using errcode = 'PT403'/g) || []).length, 3);
  assert.equal((SQL.match(/if auth\.uid\(\) is null then return new; end if;/g) || []).length, 2);
  assert.match(SQL, /create trigger trg_enforce_minor_chat_members\s+before insert on public\.conversation_members/);
  assert.match(SQL, /create trigger trg_enforce_minor_chat_messages\s+before insert on public\.messages/);
  assert.match(SQL, /security definer set search_path = public/);
});

test('player search is for signed-in players only and escapes what was typed', () => {
  assert.match(SQL, /grant execute on function public\.search_players\(text\) to authenticated/);
  assert.match(SQL, /revoke all on function public\.search_players\(text\) from public, anon/);
  assert.match(SQL, /not public\.is_minor\(p\.id\)/);
  assert.match(SQL, /p\.id <> auth\.uid\(\)/);
  assert.match(SQL, /char_length\(trim\(p_query\)\) >= 2/);
  assert.match(SQL, /replace\(replace\(replace\(trim\(p_query\)/, 'escapes \\ % and _');
  assert.match(SQL, /limit 5/);
});

test('the privacy policy describes the limits for players aged 13 to 17', () => {
  const p = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  assert.match(p, /Players aged 13 to 17/);
  assert.match(p, /limited to people they have accepted as friends/);
  assert.match(p, /do not appear in the friend search/);
});
