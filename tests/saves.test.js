// Small saves that used to be fire-and-forget: they are now checked, retried once, and the person is told the
// truth when it matters (age-gate account removal, turning notifications off, blocking).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const U = 'u-1';

// A fake server where each request is answered by the first matching rule: { match, status } (default 200).
function setup({ rules = [], signedIn = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    url = String(url);
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    const rule = rules.find(r => url.includes(r.match) && (!r.method || r.method === call.method));
    const status = rule ? (typeof rule.status === 'function' ? rule.status(calls.filter(c => c.url.includes(rule.match)).length) : rule.status) : 200;
    if (status === 'network') throw new TypeError('Failed to fetch');
    return { ok: status >= 200 && status < 300, status, json: async () => [], text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  const real = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));   // skip the pause before a retry
  w.eval(`globalThis.renderAuthScreen = () => {}; globalThis.__toasts = []; globalThis.showStreakToast = m => __toasts.push(m);
          globalThis.showToast = globalThis.showStreakToast;`);
  Object.defineProperty(w.navigator, 'serviceWorker', { value: { addEventListener() {}, register: async () => ({}), getRegistration: async () => null }, configurable: true });
  if (signedIn) w.eval(`currentUser = { id: '${U}' }; authToken = 'tok'; currentUsername = 'Me';`);
  return { ...app, w, calls, call: (n, ...a) => get(w, n)(...a), toasts: () => Array.from(w.eval('__toasts')), to: (m) => calls.filter(c => c.url.includes(m)) };
}

// ── Notifications ────────────────────────────────────────

test('a notification is stored; if the server refuses once it is tried again', async () => {
  const s = setup({ rules: [{ match: '/notifications', status: n => (n === 1 ? 500 : 201) }] });
  assert.equal(await s.call('createNotification', 'friend-1', 'friend_request', 'hi', { a: 1 }), true);
  assert.equal(s.to('/notifications').length, 2);
  assert.deepEqual({ ...s.to('/notifications')[1].body }, { user_id: 'friend-1', type: 'friend_request', message: 'hi', data: { a: 1 } });
  s.close();
});

test('a notification that cannot be stored reports failure without an error pop-up or a crash', async () => {
  const s = setup({ rules: [{ match: '/notifications', status: 500 }] });
  assert.equal(await s.call('createNotification', 'friend-1', 'friend_request', 'hi'), false);
  assert.equal(s.toasts().length, 0);
  s.close();
});

test('a notification is not lost to a dropped connection either', async () => {
  const s = setup({ rules: [{ match: '/notifications', status: 'network' }] });
  assert.equal(await s.call('createNotification', 'friend-1', 'x', 'hi'), false);
  s.close();
});

test('marking a notification read is checked and retried', async () => {
  const s = setup({ rules: [{ match: '/notifications', status: n => (n === 1 ? 500 : 204) }] });
  assert.equal(await s.call('markNotifRead', 42), true);
  assert.equal(s.to('/notifications?id=eq.42').length, 2);
  assert.equal(s.to('/notifications')[0].body.read, true);
  s.close();
  const bad = setup({ rules: [{ match: '/notifications', status: 500 }] });
  assert.equal(await bad.call('markNotifRead', 42), false);
  bad.close();
});

// ── Turning notifications off ────────────────────────────

function pushApp(rules) {
  const s = setup({ rules });
  s.w.eval(`
    globalThis.IS_ANDROID_NATIVE_TEST = true;
    window.Capacitor = { Plugins: { PushNotifications: { unregister: async () => {} } }, getPlatform: () => 'android' };
  `);
  return s;
}

test('turning notifications off on the web removes the saved subscription and says so', async () => {
  const s = setup({ rules: [{ match: '/push_subscriptions', status: 204 }] });
  s.w.eval(`
    globalThis.isPushSupported = () => true;
    swRegistration = { pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/abc', unsubscribe: async () => true }) } };
  `);
  await s.call('unsubscribeFromPush');
  const del = s.to('/push_subscriptions')[0];
  assert.equal(del.method, 'DELETE');
  assert.ok(del.url.includes(encodeURIComponent('https://push.example/abc')));
  assert.ok(s.toasts().some(t => t === 'Notifications turned off.'));
  s.close();
});

test('if the settings cannot be updated, the person is told the truth instead of "turned off"', async () => {
  const s = setup({ rules: [{ match: '/push_subscriptions', status: 500 }] });
  s.w.eval(`
    globalThis.isPushSupported = () => true;
    swRegistration = { pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/abc', unsubscribe: async () => true }) } };
  `);
  await s.call('unsubscribeFromPush');
  assert.equal(s.to('/push_subscriptions').length, 2, 'tried twice');
  const t = s.toasts();
  assert.ok(t.some(x => /couldn't update your settings/.test(x)));
  assert.ok(!t.includes('Notifications turned off.'));
  s.close();
});

test('opening the app with notifications already on re-registers quietly: no pop-up', async () => {
  const s = setup({ rules: [{ match: '/push_subscriptions', status: 201 }] });
  await wait(80);   // let the app's own start-up finish before setting up the fake push service
  s.w.eval(`
    globalThis.isPushSupported = () => true;
    window.Notification = { permission: 'granted', requestPermission: async () => { window.__asked = true; return 'granted'; } };
    swRegistration = { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }) }) } };
  `);
  s.calls.length = 0;
  assert.equal(await s.call('subscribeToPush', { silent: true }), true);
  assert.equal(s.to('/push_subscriptions').length, 1);
  assert.equal(s.toasts().length, 0, 'nothing shown');
  assert.equal(s.w.__asked, undefined, 'and the permission prompt is not shown again');
  s.close();
});

test('a quiet re-registration that fails also stays quiet', async () => {
  const s = setup({ rules: [{ match: '/push_subscriptions', status: 500 }] });
  s.w.eval(`
    globalThis.isPushSupported = () => true;
    window.Notification = { permission: 'granted', requestPermission: async () => 'granted' };
    swRegistration = { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }) }) } };
  `);
  assert.equal(await s.call('subscribeToPush', { silent: true }), false);
  assert.equal(s.toasts().length, 0);
  s.close();
});

test('turning notifications on yourself still confirms it, and still reports a failure', async () => {
  const ok = setup({ rules: [{ match: '/push_subscriptions', status: 201 }] });
  ok.w.eval(`
    globalThis.isPushSupported = () => true;
    window.Notification = { permission: 'default', requestPermission: async () => 'granted' };
    swRegistration = { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }) }) } };
  `);
  assert.equal(await ok.call('subscribeToPush'), true);
  assert.ok(ok.toasts().some(t => /Notifications enabled/.test(t)));
  ok.close();
  const bad = setup({ rules: [{ match: '/push_subscriptions', status: 500 }] });
  bad.w.eval(`
    globalThis.isPushSupported = () => true;
    window.Notification = { permission: 'default', requestPermission: async () => 'granted' };
    swRegistration = { pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }) }) } };
  `);
  assert.equal(await bad.call('subscribeToPush'), false);
  assert.ok(bad.toasts().some(t => /Could not enable/.test(t)));
  bad.close();
});

// ── Blocking ─────────────────────────────────────────────

test('blocking someone removes the friendship and confirms it', async () => {
  const s = setup({ rules: [{ match: '/blocked_users', status: 201 }, { match: '/friends', status: 204 }] });
  s.w.eval(`globalThis.renderProfile = () => {};`);
  await s.call('blockUser', 'pat-1', 'Pat');
  assert.equal(s.to('/friends')[0].method, 'DELETE');
  assert.ok(s.toasts().some(t => /Blocked Pat\. They can no longer/.test(t)));
  s.close();
});

test('if the friendship cannot be removed, the block still stands and the person is told', async () => {
  const s = setup({ rules: [{ match: '/blocked_users', status: 201 }, { match: '/friends', status: 500 }] });
  s.w.eval(`globalThis.renderProfile = () => {};`);
  await s.call('blockUser', 'pat-1', 'Pat');
  assert.equal(s.to('/friends').length, 2, 'tried twice');
  assert.ok(s.w.eval(`blockedUserIds.has('pat-1')`), 'still blocked');
  const t = s.toasts();
  assert.ok(t.some(x => /couldn't remove them from your friends list/.test(x)));
  assert.ok(!t.some(x => /can no longer message/.test(x)), 'does not claim it all worked');
  s.close();
});

// ── Age gate: under 13 ───────────────────────────────────

function ageGate(rules) {
  const s = setup({ rules });
  s.w.eval(`globalThis.signOut = async () => { window.__signedOut = true; };`);
  s.w.eval('showAgeGate()');
  const year = new Date().getFullYear() - 10;
  s.w.document.getElementById('ageGateMonth').value = '6';
  s.w.document.getElementById('ageGateYear').value = String(year);
  return s;
}

test('under 13: the account is removed, the person is signed out, and told it was removed', async () => {
  const s = ageGate([{ match: '/functions/v1/delete-account', status: 200 }]);
  await s.call('submitAgeGate');
  assert.equal(s.to('/delete-account').length, 1);
  assert.equal(s.w.__signedOut, true);
  assert.ok(s.toasts().some(t => /your account has been removed|yours has been removed/.test(t)));
  assert.equal(s.w.document.getElementById('ageGateOverlay'), null);
  s.close();
});

test('under 13 and the removal fails: stay on the screen, do not claim it is gone, and allow another try', async () => {
  const s = ageGate([{ match: '/functions/v1/delete-account', status: 500 }]);
  await s.call('submitAgeGate');
  assert.equal(s.to('/delete-account').length, 2, 'tried twice');
  assert.equal(s.w.__signedOut, undefined, 'not signed out');
  assert.ok(!s.toasts().some(t => /has been removed/.test(t)));
  assert.match(s.w.document.getElementById('ageGateError').textContent, /couldn't remove this account/);
  assert.equal(s.w.document.getElementById('ageGateBtn').disabled, false);
  assert.ok(s.w.document.getElementById('ageGateOverlay'));
  s.close();
});

test('under 13 and the connection drops: same, and a later try can succeed', async () => {
  const s = ageGate([{ match: '/functions/v1/delete-account', status: n => (n <= 2 ? 'network' : 200) }]);
  await s.call('submitAgeGate');
  assert.equal(s.w.__signedOut, undefined);
  await s.call('submitAgeGate');
  assert.equal(s.w.__signedOut, true);
  s.close();
});

// ── Challenges ───────────────────────────────────────────

test('accepting a challenge records the start time; if that fails, the game still starts', async () => {
  const s = setup({ rules: [{ match: '/challenges?id=eq.c1', status: 500 }, { match: '/verses', status: 200 }] });
  s.w.eval(`globalThis.startChallengeScout = () => { window.__started = true; }; globalThis.startChallengeMIA = globalThis.startChallengeTrack = () => { window.__started = true; };`);
  await s.call('acceptChallenge', 'c1', 'scout', 'hard', 1000, '', 0, 0);
  assert.equal(s.to('/challenges?id=eq.c1').length, 2, 'tried twice');
  assert.equal(s.to('/challenges?id=eq.c1')[0].body.opponent_started_at.length > 10, true);
  assert.equal(s.toasts().filter(t => /Couldn't save/.test(t)).length, 0, 'no alarming message for a record-only field');
  s.close();
});

// ── Static: nothing left to ignore failures ──────────────

test('no write in the app swallows a failure with an empty catch', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  const lines = html.split('\n');
  const bad = [];
  lines.forEach((l, i) => {
    if (/fetch\([^)]*SUPABASE_URL[^)]*\/rest\/v1\//.test(l) && /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(l)) bad.push(i + 1);
  });
  const block = html.match(/method:\s*'(?:PATCH|POST|DELETE)'[^}]*\}\)\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || [];
  assert.deepEqual(bad, []);
  assert.equal(block.length, 0);
});
