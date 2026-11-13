// Friend invite links: the link is built correctly, opening one is remembered, and after sign-in the player
// is offered a connection with whoever invited them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ME = '11111111-1111-4111-8111-111111111111';
const FRIEND = '22222222-2222-4222-8222-222222222222';
const KEY = 'ss_pending_invite';

function setup({ query = '', signedIn = true, username = 'Me', profiles = [{ id: FRIEND, username: 'Pat' }], relation = [], offline = false, realFriends = false } = {}) {
  const calls = [];
  const state = { profiles, relation, offline };
  const fetchImpl = async (url, opts = {}) => {
    url = String(url);
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (state.offline) throw new TypeError('Failed to fetch');
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (opts.method === 'POST' || opts.method === 'PATCH') return ok([]);
    if (url.includes('/rest/v1/profiles')) return ok(state.profiles);
    if (url.includes('/rest/v1/friends')) return ok(state.relation);
    return ok([]);
  };
  const app = loadApp({ fetchImpl, url: 'https://scripturescout.test/' + query });
  const w = app.window;
  w.eval(`globalThis.renderAuthScreen = globalThis.renderAuthScreen; ${realFriends ? '' : 'globalThis.renderFriends = () => {};'} globalThis.createNotification = async () => {}; globalThis.loadBlockedUsers = async () => {};`);
  if (signedIn) w.eval(`currentUser = { id: '${ME}' }; authToken = 'tok'; currentUsername = '${username}';`);
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute && c.getAttribute('role') === 'status').map(c => c.textContent);
  const modal = () => w.document.getElementById('inviteModalOverlay');
  const click = id => w.document.getElementById(id).click();
  const call = (n, ...a) => get(w, n)(...a);
  const writes = () => calls.filter(c => c.method !== 'GET');
  return { ...app, w, calls, state, toasts, modal, click, call, writes, stored: () => w.localStorage.getItem(KEY) };
}

test('the invite link points at the app and carries your id', () => {
  const s = setup();
  assert.equal(s.call('inviteLink', ME), `https://scripturescout.pages.dev/?invite=${ME}`);
  s.close();
});

test('the Add Friend tab shows your link and the Copy button copies exactly that', async () => {
  const s = setup({ realFriends: true, profiles: [] });
  await s.call('renderFriends', 'add');
  const shown = s.w.document.querySelector('input[aria-label="Your invite link"]');
  assert.equal(shown.value, `https://scripturescout.pages.dev/?invite=${ME}`);
  const real = get(s.w, 'copyInviteLink');
  let copied = null;
  Object.defineProperty(s.w.navigator, 'clipboard', { value: { writeText: async t => { copied = t; } }, configurable: true });
  real();
  await wait();
  assert.equal(copied, `https://scripturescout.pages.dev/?invite=${ME}`);
  assert.ok(s.toasts().some(t => /Link copied/.test(t)));
  s.close();
});

test('copying says so plainly when the browser will not allow it', async () => {
  const s = setup();
  Object.defineProperty(s.w.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
  s.call('copyInviteLink'); await wait();
  assert.ok(s.toasts().some(t => /Could not copy/.test(t)));
  s.close();
});

// ── Opening a link ───────────────────────────────────────

test('opening an invite link remembers who invited you and cleans the address bar', () => {
  const s = setup({ query: `?invite=${FRIEND}&other=1` });
  assert.equal(s.stored(), FRIEND);
  assert.equal(s.w.location.search, '?other=1');
  s.close();
});

test('an upper-case id is accepted', () => {
  const s = setup({ query: `?invite=${FRIEND.toUpperCase()}` });
  assert.equal(s.stored(), FRIEND);
  s.close();
});

test('anything that is not a real id is ignored, including attempts to inject markup or queries', () => {
  for (const bad of ['', 'hello', '<script>alert(1)</script>', `${FRIEND}&id=neq.0`, "' or 1=1 --", FRIEND.slice(1), '../../etc']) {
    const s = setup({ query: '?invite=' + encodeURIComponent(bad) });
    assert.equal(s.stored(), null, `kept "${bad}"`);
    assert.ok(!s.w.location.search.includes('invite'), 'removed from the address bar');
    s.close();
  }
});

test('a page opened without an invite does nothing', () => {
  const s = setup();
  assert.equal(s.stored(), null);
  s.close();
});

test('a signed-out visitor sees a friendly note on the sign-in screen', () => {
  const s = setup({ query: `?invite=${FRIEND}`, signedIn: false });
  s.call('renderAuthScreen');
  assert.match(s.w.document.getElementById('root').textContent, /A friend invited you/);
  s.close();
});

test('no invite note on the sign-in screen when there is no invite', () => {
  const s = setup({ signedIn: false });
  s.call('renderAuthScreen');
  assert.doesNotMatch(s.w.document.getElementById('root').textContent, /A friend invited you/);
  s.close();
});

// ── After signing in ─────────────────────────────────────

test('after sign-in the player is asked whether to add the person who invited them', async () => {
  const s = setup({ query: `?invite=${FRIEND}` });
  const done = s.call('handlePendingInvite');
  await wait();
  assert.match(s.modal().textContent, /Add Pat as a friend/);
  s.click('inviteModalYes');
  await done;
  const req = s.writes().find(c => c.url.includes('/rest/v1/friends'));
  assert.deepEqual({ ...req.body }, { user_id: ME, friend_id: FRIEND, status: 'pending' });
  assert.equal(s.stored(), null, 'invite used up');
  s.close();
});

test('"Not now" sends nothing and does not ask again', async () => {
  const s = setup({ query: `?invite=${FRIEND}` });
  const done = s.call('handlePendingInvite');
  await wait(); s.click('inviteModalNo'); await done;
  assert.equal(s.writes().length, 0);
  assert.equal(s.stored(), null);
  assert.equal(s.modal(), null);
  s.close();
});

test('the invited name is shown safely even if it contains markup', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, profiles: [{ id: FRIEND, username: '<img src=x onerror=alert(1)>' }] });
  const done = s.call('handlePendingInvite');
  await wait();
  assert.equal(s.modal().querySelector('img'), null);
  assert.match(s.modal().textContent, /<img src=x/);
  s.click('inviteModalNo'); await done;
  s.close();
});

test('your own invite link just says so', async () => {
  const s = setup({ query: `?invite=${ME}` });
  await s.call('handlePendingInvite');
  assert.ok(s.toasts().some(t => /your own invite/.test(t)));
  assert.equal(s.modal(), null);
  assert.equal(s.stored(), null);
  s.close();
});

test('already friends: no question, just a message', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, relation: [{ id: 5, user_id: ME, status: 'accepted' }] });
  await s.call('handlePendingInvite');
  assert.ok(s.toasts().some(t => /already friends/.test(t)));
  assert.equal(s.writes().length, 0);
  s.close();
});

test('a request you already sent is not sent again', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, relation: [{ id: 5, user_id: ME, status: 'pending' }] });
  await s.call('handlePendingInvite');
  assert.ok(s.toasts().some(t => /already sent/.test(t)));
  assert.equal(s.writes().length, 0);
  s.close();
});

test('if they already asked to be your friend, accepting their request is offered', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, relation: [{ id: 9, user_id: FRIEND, status: 'pending' }] });
  const done = s.call('handlePendingInvite');
  await wait();
  assert.match(s.modal().textContent, /wants to be friends/);
  s.click('inviteModalYes'); await done;
  const patch = s.writes().find(c => c.method === 'PATCH');
  assert.ok(patch.url.includes('friends?id=eq.9'));
  assert.equal(patch.body.status, 'accepted');
  s.close();
});

test('an invite from someone who no longer exists is dropped with a message', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, profiles: [] });
  await s.call('handlePendingInvite');
  assert.ok(s.toasts().some(t => /isn't valid/.test(t)));
  assert.equal(s.stored(), null);
  s.close();
});

test('an invite from someone you blocked is dropped quietly', async () => {
  const s = setup({ query: `?invite=${FRIEND}` });
  s.w.eval(`globalThis.isBlocked = id => id === '${FRIEND}';`);
  await s.call('handlePendingInvite');
  assert.equal(s.modal(), null);
  assert.equal(s.writes().length, 0);
  assert.equal(s.stored(), null);
  s.close();
});

test('with no connection the invite is kept for next time', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, offline: true });
  await s.call('handlePendingInvite');
  assert.equal(s.stored(), FRIEND);
  assert.equal(s.modal(), null);
  s.close();
});

test('nothing happens while signed out, and the invite waits', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, signedIn: false });
  await s.call('handlePendingInvite');
  assert.equal(s.calls.length, 0);
  assert.equal(s.stored(), FRIEND);
  s.close();
});

test('it waits for a username and for the age question before asking', async () => {
  const s = setup({ query: `?invite=${FRIEND}`, username: '' });
  await s.call('handlePendingInvite');
  assert.equal(s.modal(), null);
  assert.equal(s.stored(), FRIEND, 'still waiting');
  s.w.eval(`currentUsername = 'Me'`);
  const gate = s.w.document.createElement('div'); gate.id = 'ageGateOverlay'; s.w.document.body.appendChild(gate);
  await s.call('handlePendingInvite');
  assert.equal(s.modal(), null);
  s.close();
});

test('two triggers at once show only one question', async () => {
  const s = setup({ query: `?invite=${FRIEND}` });
  const a = s.call('handlePendingInvite'); const b = s.call('handlePendingInvite');
  await wait();
  assert.equal(s.w.document.querySelectorAll('#inviteModalOverlay').length, 1);
  s.click('inviteModalNo'); await Promise.all([a, b]);
  s.close();
});

test('the invite survives the Google sign-in redirect and is used afterwards', async () => {
  const first = setup({ query: `?invite=${FRIEND}`, signedIn: false });
  const saved = first.stored();
  first.close();
  const second = setup({});                      // page reloaded after sign-in, no ?invite= any more
  second.w.localStorage.setItem(KEY, saved);
  const done = second.call('handlePendingInvite');
  await wait();
  assert.match(second.modal().textContent, /Add Pat/);
  second.click('inviteModalNo'); await done;
  second.close();
});
