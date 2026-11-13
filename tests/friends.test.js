// Friends: the Friends screen and its tabs, searching, sending/accepting/declining requests, and starting a chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get, fakeIntervals } = require('./helpers');

const ME = 'me-1', ANN = 'ann-2', BEN = 'ben-3', CAL = 'cal-4', DEE = 'dee-5';
const NAMES = { [ME]: 'Me', [ANN]: 'Ann', [BEN]: 'Ben', [CAL]: 'Cal', [DEE]: 'Dee' };
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

// A signed-in app with a controllable fake Supabase. `state` can be changed by the test between calls.
function setup(state = {}, { status = {} } = {}) {
  const st = { friends: [], incoming: [], sent: [], profiles: NAMES, search: () => [], myConvs: [], theirConvs: [], directConvs: null, newConvId: 'new-conv', ...state };
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method || 'GET', body });
    const key = Object.keys(status).find(k => u.includes(k));
    const code = key ? status[key] : 200;
    const json = u.includes('/rest/v1/conversations') && opts.method === 'POST' ? [{ id: st.newConvId }] : [];
    return { ok: code >= 200 && code < 300, status: code, json: async () => json, text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  fakeIntervals(w);
  w.__st = st;
  w.eval(`
    currentUser = { id: '${ME}' }; authToken = 't'; currentUsername = 'Me';
    globalThis.sbFetch = async (p) => {
      const s = window.__st;
      if (p.startsWith('friends?or=')) return s.friends;
      if (p.startsWith('friends?friend_id=eq.')) return s.incoming;
      if (p.startsWith('friends?user_id=eq.')) return s.sent;
      if (p.startsWith('profiles?id=in.')) { const ids = p.match(/in\\.\\(([^)]*)\\)/)[1].split(','); return ids.map(id => ({ id, username: s.profiles[id] })); }
      if (p.startsWith('profiles?select=id,username')) return s.search(decodeURIComponent(p));
      if (p.startsWith('conversation_members?user_id=eq.${ME}')) return s.myConvs.map(id => ({ conversation_id: id }));
      if (p.startsWith('conversation_members?user_id=eq.')) return s.theirConvs.map(id => ({ conversation_id: id }));
      if (p.startsWith('conversations?id=in.')) { const ids = p.match(/in\\.\\(([^)]*)\\)/)[1].split(','); const only = s.directConvs; return (only === null ? [] : only).filter(id => ids.includes(id)).map(id => ({ id })); }
      return [];
    };
    globalThis.__opened = []; globalThis.openConversation = async (...a) => { __opened.push(a); };
    globalThis.__renders = []; 
  `);
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute('role') === 'status').map(c => c.textContent);
  const writes = () => calls.filter(c => c.method !== 'GET');
  const root = () => w.document.getElementById('root');
  return { ...app, st, calls, toasts, writes, root, w };
}

const row = (id, user_id, friend_id, status = 'accepted') => ({ id, user_id, friend_id, status, created_at: new Date().toISOString() });
const names = s => [...s.root().querySelectorAll('.friend-name')].map(e => e.textContent.trim());

// ── The Friends tab ────────────────────────────────────

test('the Friends tab lists friends whichever way round the friendship was made', async () => {
  const s = setup({ friends: [row(1, ME, ANN), row(2, BEN, ME)] });
  await get(s.w, 'renderFriends')();
  assert.deepEqual(names(s).sort(), ['Ann', 'Ben']);
  assert.match(s.root().querySelector('.friends-tab').textContent, /Friends \(2\)/);
  s.close();
});

test('with no friends it says so', async () => {
  const s = setup();
  await get(s.w, 'renderFriends')();
  assert.match(s.root().textContent, /No friends yet/);
  assert.doesNotMatch(s.root().querySelector('.friends-tab').textContent, /\(/);
  s.close();
});

test('each friend has Profile, Message and Challenge buttons wired to that friend', async () => {
  const s = setup({ friends: [row(1, ME, ANN)] });
  await get(s.w, 'renderFriends')();
  const html = s.root().innerHTML;
  assert.match(html, new RegExp(`openDirectMessage\\('${ANN}','Ann'\\)`));
  assert.match(html, new RegExp(`challengeFriend\\('${ANN}','Ann'\\)`));
  assert.match(html, new RegExp(`renderProfile\\('${ANN}','Ann'\\)`));
  s.close();
});

test("a friend's name cannot inject markup or break out of the button handlers", async () => {
  const evil = `x');window.__pwned=1;('<img src=x onerror="window.__pwned=2">`;
  const s = setup({ friends: [row(1, ME, ANN)], profiles: { ...NAMES, [ANN]: evil } });
  await get(s.w, 'renderFriends')();
  assert.equal(s.root().querySelectorAll('img').length, 0);
  s.root().querySelector('.btn-friend-action.message').click();
  s.root().querySelector('.btn-friend-action.challenge').click();
  await wait();
  assert.equal(s.w.__pwned, undefined);
  s.close();
});

test('a friend whose username cannot be found still shows up', async () => {
  const s = setup({ friends: [row(1, ME, ANN)], profiles: { [ANN]: null } });
  await get(s.w, 'renderFriends')();
  assert.deepEqual(names(s), ['Unknown']);
  s.close();
});

// ── The Requests tab ───────────────────────────────────

test('Requests shows incoming requests with Accept/Decline and sent ones with Cancel', async () => {
  const s = setup({ incoming: [row(10, BEN, ME, 'pending')], sent: [row(11, ME, CAL, 'pending')] });
  await get(s.w, 'renderFriends')('requests');
  const text = s.root().textContent;
  assert.match(text, /Incoming Requests/); assert.match(text, /Sent — Waiting for Response/);
  assert.deepEqual(names(s), ['Ben', 'Cal']);
  const html = s.root().innerHTML;
  assert.match(html, new RegExp(`acceptFriend\\('10','${BEN}','Ben'`));
  assert.match(html, /declineFriend\('10'\)/);
  assert.match(html, /declineFriend\('11'\)/);
  assert.match(s.root().querySelector('.friends-tabs').textContent, /Requests \(1\)/);
  s.close();
});

test('with no requests it says so', async () => {
  const s = setup();
  await get(s.w, 'renderFriends')('requests');
  assert.match(s.root().textContent, /No pending requests/);
  s.close();
});

test('the screen remembers which tab you were on when it reloads', async () => {
  const s = setup();
  await get(s.w, 'renderFriends')('requests');
  await get(s.w, 'renderFriends')();
  assert.ok(s.root().querySelectorAll('.friends-tab')[1].classList.contains('active'));
  await get(s.w, 'renderFriends')('add');
  assert.ok(s.root().querySelectorAll('.friends-tab')[2].classList.contains('active'));
  s.close();
});

// ── Searching ──────────────────────────────────────────

async function openSearch(state) {
  const s = setup(state);
  await get(s.w, 'renderFriends')('add');
  const input = s.root().querySelector('#friendSearch');
  const type = async (q) => { input.value = q; input.dispatchEvent(new s.w.Event('input')); await wait(); };
  return { ...s, type, results: () => [...s.root().querySelectorAll('#friendSearchResults .friend-name')].map(e => e.textContent.trim()), resultsEl: () => s.root().querySelector('#friendSearchResults') };
}

test('the Add Friend tab shows your own invite link', async () => {
  const s = setup();
  await get(s.w, 'renderFriends')('add');
  assert.match(s.root().innerHTML, new RegExp(`\\?invite=${ME}`));
  s.close();
});

test('searching needs at least two letters, and finds players by name', async () => {
  const s = await openSearch({ search: (p) => /username=ilike\.%an%/i.test(p) ? [{ id: ANN, username: 'Ann' }, { id: ME, username: 'Me' }] : [] });
  await s.type('a'); assert.deepEqual(s.results(), []);
  await s.type('an'); assert.deepEqual(s.results(), ['Ann'], 'you never appear in your own results');
  s.close();
});

test('searching says when nobody matches, and escapes what was typed', async () => {
  const s = await openSearch({ search: () => [] });
  await s.type('<b>zz</b>');
  assert.match(s.resultsEl().textContent, /No users found for "<b>zz<\/b>"/);
  assert.equal(s.resultsEl().querySelectorAll('b').length, 0, 'the typed <b> is text, not markup');
  assert.equal(s.resultsEl().querySelectorAll('strong').length, 1, 'only our own <strong>');
  s.close();
});

test('the + Add button sends a request to that exact person', async () => {
  const s = await openSearch({ search: () => [{ id: DEE, username: 'Dee' }] });
  await s.type('de');
  assert.match(s.resultsEl().innerHTML, new RegExp(`sendFriendRequest\\('${DEE}','Dee'\\)`));
  s.close();
});

test('results always match the latest thing typed, even if an older search answers late', async () => {
  // Regression: every keystroke fired a search and whichever answered last won, so a slow reply for "an"
  // could replace the results for "ann".
  const slow = {}; 
  const s = await openSearch({});
  s.w.eval(`
    const orig = globalThis.sbFetch;
    globalThis.sbFetch = (p) => {
      if (p.startsWith('profiles?select=id,username')) {
        const q = decodeURIComponent(p).match(/ilike\\.%(.*)%/)[1];
        return new Promise(res => { (window.__pending = window.__pending || {})[q] = () => res(q === 'an' ? [{ id: 'x', username: 'AnOld' }] : [{ id: 'y', username: 'AnnNew' }]); });
      }
      return orig(p);
    };
  `);
  const input = s.root().querySelector('#friendSearch');
  input.value = 'an'; input.dispatchEvent(new s.w.Event('input'));
  input.value = 'ann'; input.dispatchEvent(new s.w.Event('input'));
  s.w.__pending['ann'](); await wait();
  s.w.__pending['an'](); await wait();          // the older answer arrives last
  assert.deepEqual(s.results(), ['AnnNew']);
  s.close();
});

test('people who are already friends, or already asked, are not offered a + Add button', async () => {
  const s = await openSearch({
    friends: [row(1, ME, ANN)], sent: [row(2, ME, BEN, 'pending')], incoming: [row(3, CAL, ME, 'pending')],
    search: () => [{ id: ANN, username: 'Ann' }, { id: BEN, username: 'Ben' }, { id: CAL, username: 'Cal' }, { id: DEE, username: 'Dee' }],
  });
  await get(s.w, 'renderFriends')('add');            // reload so the screen knows the current friend list
  const input = s.root().querySelector('#friendSearch'); input.value = 'xx'; input.dispatchEvent(new s.w.Event('input')); await wait();
  const cards = Object.fromEntries([...s.root().querySelectorAll('#friendSearchResults .friend-card')].map(c => [c.querySelector('.friend-name').textContent.trim(), c]));
  assert.ok(cards.Dee.querySelector('button[onclick*="sendFriendRequest"]'), 'a stranger can be added');
  for (const n of ['Ann', 'Ben', 'Cal']) assert.equal(cards[n].querySelector('button[onclick*="sendFriendRequest"]'), null, n + ' should not be addable again');
  assert.match(cards.Ann.textContent, /Friends/); assert.match(cards.Ben.textContent, /Request sent/); assert.match(cards.Cal.textContent, /Wants to add you|Accept/);
  s.close();
});

// ── Requests: send, accept, decline ────────────────────

test('sending a request saves it as pending, tells the other person, and shows the Requests tab', async () => {
  const s = setup();
  await get(s.w, 'sendFriendRequest')(DEE, 'Dee');
  const friendsPost = s.writes().find(c => c.url.endsWith('/rest/v1/friends'));
  assert.deepEqual(friendsPost.body, { user_id: ME, friend_id: DEE, status: 'pending' });
  const note = s.writes().find(c => c.url.endsWith('/rest/v1/notifications'));
  assert.equal(note.body.user_id, DEE); assert.equal(note.body.type, 'friend_request');
  assert.match(note.body.message, /Me sent you a friend request/);
  assert.equal(note.body.data.from_id, ME);
  assert.ok(s.toasts().some(t => /Friend request sent to Dee/.test(t)));
  await wait();
  assert.ok(s.root().querySelectorAll('.friends-tab')[1].classList.contains('active'));
  s.close();
});

test('if the request is refused (for example already sent), the player is told and nobody is notified', async () => {
  const s = setup({}, { status: { '/rest/v1/friends': 409 } });
  await get(s.w, 'sendFriendRequest')(DEE, 'Dee');
  assert.ok(s.toasts().some(t => /Could not send request/.test(t)));
  assert.equal(s.writes().filter(c => c.url.includes('/notifications')).length, 0);
  s.close();
});

test('accepting marks the request accepted, tells the sender, and refreshes the friends list', async () => {
  const s = setup({ friends: [row(10, BEN, ME)] });
  await get(s.w, 'acceptFriend')('10', BEN, 'Ben');
  const patch = s.writes().find(c => c.method === 'PATCH');
  assert.ok(patch.url.endsWith('/rest/v1/friends?id=eq.10'));
  assert.deepEqual(patch.body, { status: 'accepted' });
  const note = s.writes().find(c => c.url.endsWith('/rest/v1/notifications'));
  assert.equal(note.body.user_id, BEN); assert.equal(note.body.type, 'friend_accept');
  assert.ok(s.toasts().some(t => /You and Ben are now friends/.test(t)));
  await wait();
  assert.deepEqual(names(s), ['Ben']);
  s.close();
});

test('a failed accept tells the player and sends no notification', async () => {
  const s = setup({}, { status: { 'friends?id=eq.10': 500 } });
  await get(s.w, 'acceptFriend')('10', BEN, 'Ben');
  assert.ok(s.toasts().some(t => /Could not accept/.test(t)));
  assert.equal(s.writes().filter(c => c.url.includes('/notifications')).length, 0);
  s.close();
});

test('declining (or cancelling) deletes that request', async () => {
  const s = setup();
  await get(s.w, 'declineFriend')('10');
  const del = s.writes()[0];
  assert.equal(del.method, 'DELETE'); assert.ok(del.url.endsWith('/rest/v1/friends?id=eq.10'));
  assert.ok(s.toasts().some(t => /Request declined/.test(t)));
  s.close();
});

test('a failed decline tells the player', async () => {
  const s = setup({}, { status: { 'friends?id=eq.10': 500 } });
  await get(s.w, 'declineFriend')('10');
  assert.ok(s.toasts().some(t => /Could not decline/.test(t)));
  s.close();
});

test('accepting a request from the Notifications screen keeps you on Notifications', async () => {
  // Regression: accepting also jumped to the Friends screen a moment later.
  const s = setup({ friends: [row(10, BEN, ME)] });
  s.w.eval(`globalThis.renderNotificationHub = async () => { document.getElementById('root').innerHTML = '<p id="notifs">Notifications</p>'; };`);
  await get(s.w, 'acceptFriend')('10', BEN, 'Ben', 'notifications');
  await wait();
  assert.ok(s.root().querySelector('#notifs'), 'still on Notifications');
  assert.equal(s.root().querySelector('.friends-screen'), null);
  s.close();
});

test('the Notifications screen\'s Accept and Decline buttons ask for that behaviour', async () => {
  const s = setup();
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/acceptFriend\('\$\{r\.id\}','\$\{r\.user_id\}','\$\{escapeJsAttr\(getReqName\(r\.user_id\)\)\}','notifications'\)/.test(html), 'Accept should pass "notifications"');
  assert.ok(/declineFriend\('\$\{r\.id\}','notifications'\)/.test(html), 'Decline should pass "notifications"');
  s.close();
});

// ── Starting a chat with a friend ──────────────────────

test('messaging a friend reopens the direct chat you already have with them', async () => {
  const s = setup({ myConvs: ['c1', 'c2'], theirConvs: ['c2'], directConvs: ['c2'] });
  await get(s.w, 'openDirectMessage')(ANN, 'Ann');
  assert.equal(s.w.__opened.length, 1);
  assert.equal(s.w.__opened[0][0], 'c2');
  assert.equal(s.writes().length, 0, 'nothing new is created');
  s.close();
});

test('a group chat you both belong to is not mistaken for your direct chat', async () => {
  // Regression: any shared conversation matched, so "Message" opened a shared group chat instead of a private one.
  const s = setup({ myConvs: ['group1'], theirConvs: ['group1'], directConvs: [], newConvId: 'dm-new' });
  await get(s.w, 'openDirectMessage')(ANN, 'Ann');
  await wait();
  const created = s.writes().find(c => c.url.endsWith('/rest/v1/conversations'));
  assert.ok(created, 'a new direct chat is created');
  assert.equal(created.body.type, 'direct');
  assert.equal(s.w.__opened[0][0], 'dm-new');
  s.close();
});

test('starting a new chat adds both of you to it and opens it', async () => {
  const s = setup({ newConvId: 'dm-9' });
  await get(s.w, 'openDirectMessage')(ANN, 'Ann');
  await wait();
  const conv = s.writes().find(c => c.url.endsWith('/rest/v1/conversations'));
  assert.deepEqual(conv.body, { name: 'Ann', type: 'direct', created_by: ME });
  const members = s.writes().filter(c => c.url.endsWith('/rest/v1/conversation_members')).map(c => c.body);
  assert.equal(members.length, 2);
  assert.deepEqual(new Set(members.map(m => m.user_id)), new Set([ME, ANN]));
  assert.ok(members.every(m => m.conversation_id === 'dm-9'));
  assert.equal(s.w.__opened[0][0], 'dm-9');
  s.close();
});

test('if the chat cannot be created, the player is told and nothing opens', async () => {
  const s = setup({}, { status: { '/rest/v1/conversations': 500 } });
  await get(s.w, 'openDirectMessage')(ANN, 'Ann');
  assert.ok(s.toasts().some(t => /Could not start the chat/.test(t)));
  assert.equal(s.w.__opened.length, 0);
  s.close();
});

test('if adding the members fails, the player is told and the empty chat is not opened', async () => {
  const s = setup({}, { status: { '/rest/v1/conversation_members': 403 } });
  await get(s.w, 'openDirectMessage')(ANN, 'Ann');
  await wait();
  assert.ok(s.toasts().some(t => /Could not start the chat/.test(t)));
  assert.equal(s.w.__opened.length, 0);
  s.close();
});

// ── Signed out, and the invite link ────────────────────

test('tapping Friends while signed out asks you to sign in and loads nothing', () => {
  const s = setup(); s.w.eval('currentUser = null; authToken = null;');
  get(s.w, 'navGo')('friends');
  assert.ok(s.toasts().some(t => /Sign in/.test(t)));
  assert.equal(s.calls.length, 0);
  s.close();
});

test('opening someone\'s invite link offers to add them as a friend', { todo: 'invite links are created but never read — see the Friends > Add Friend tab' }, async () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/searchParams\.get\(['"]invite['"]\)|URLSearchParams[^;]*invite/.test(html), 'nothing reads ?invite=');
});
