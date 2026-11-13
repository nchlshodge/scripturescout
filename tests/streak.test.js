// The streak: the day-by-day rules, and counting days played offline (kept on the device, applied in order
// to the real streak when the connection is back).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get, fakeClock } = require('./helpers');

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const U = 'u-1';
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const rec = (over = {}) => ({ user_id: U, current_streak: 0, longest_streak: 0, freeze_tokens: 0, total_days_played: 0, last_played_date: null, ...over });

// An app wired to a fake server holding one streak row; the connection can be switched off.
function setup({ streak = rec(), now = at(2026, 11, 13), up = true, signedIn = true } = {}) {
  const net = { up, streak, patches: [], failPatch: false, calls: 0 };
  const fetchImpl = async (url, opts = {}) => {
    url = String(url); net.calls++;
    if (!net.up) throw new TypeError('Failed to fetch');
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (url.includes('/rest/v1/streaks')) {
      if (opts.method === 'PATCH') {
        if (net.failPatch) return { ok: false, status: 500, json: async () => ({}) };
        const body = JSON.parse(opts.body); net.patches.push(body);
        net.streak = { ...net.streak, ...body };
        return ok([net.streak]);
      }
      return ok(net.streak ? [net.streak] : []);
    }
    return ok([]);
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  const clock = fakeClock(w, now);
  Object.defineProperty(w.navigator, 'onLine', { get: () => net.up, configurable: true });
  w.eval(`globalThis.renderAuthScreen = () => {}; globalThis.__cards = []; globalThis.__toasts = [];
    globalThis.showJournalCard = (...a) => __cards.push(a); globalThis.playStreak = globalThis.playMilestone = () => {};
    globalThis.checkAndAwardBadges = () => []; globalThis.queueBadgeJournals = () => {};
    globalThis.showStreakToast = m => __toasts.push(m);`);
  if (signedIn) w.eval(`currentUser = { id: '${U}' }; authToken = 'tok';`);
  const call = (n, ...a) => get(w, n)(...a);
  const ls = k => JSON.parse(w.localStorage.getItem(k) || 'null');
  return { ...app, w, net, clock, call, ls, cards: () => w.eval('__cards'), toasts: () => w.eval('__toasts'),
    cur: () => w.eval('currentStreak'), days: () => ls(`ss_streak_days_${U}`) };
}

// ── Day-by-day rules ─────────────────────────────────────

test('day keys step across month ends, year ends, leap days and daylight-saving changes', () => {
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Europe/London']) {
    process.env.TZ = tz;
    const s = setup();
    assert.equal(s.call('shiftDayKey', '2026-03-01', -1), '2026-02-28');
    assert.equal(s.call('shiftDayKey', '2028-03-01', -1), '2028-02-29');
    assert.equal(s.call('shiftDayKey', '2027-01-01', -1), '2026-12-31');
    assert.equal(s.call('shiftDayKey', '2026-12-31', 1), '2027-01-01');
    assert.equal(s.call('shiftDayKey', '2026-03-09', -1), '2026-03-08', tz + ' US spring-forward');
    assert.equal(s.call('shiftDayKey', '2026-03-09', -2), '2026-03-07');
    assert.equal(s.call('shiftDayKey', '2026-11-02', -1), '2026-11-01', tz + ' US fall-back');
    assert.equal(s.call('shiftDayKey', '2026-10-26', -1), '2026-10-25', tz + ' UK fall-back');
    s.close();
  }
  delete process.env.TZ;
});

test('first play starts a streak of 1; the next day makes 2; the same day changes nothing', () => {
  const s = setup(); const step = get(s.w, 'computeStreakStep');
  const a = step(rec(), '2026-11-13');
  assert.equal(a.updates.current_streak, 1); assert.equal(a.updates.total_days_played, 1); assert.equal(a.updates.last_played_date, '2026-11-13');
  const b = step({ ...rec(), ...a.updates }, '2026-11-14');
  assert.equal(b.updates.current_streak, 2);
  assert.equal(step({ ...rec(), ...a.updates }, '2026-11-13'), null, 'same day');
  assert.equal(step({ ...rec(), ...a.updates }, '2026-11-12'), null, 'an earlier day is already behind us');
  s.close();
});

test('a missed day costs the streak, unless a Sabbath Rest covers it', () => {
  const s = setup(); const step = get(s.w, 'computeStreakStep');
  const base = rec({ current_streak: 4, longest_streak: 9, last_played_date: '2026-11-10', freeze_tokens: 1, total_days_played: 20 });
  const rested = step(base, '2026-11-12');
  assert.equal(rested.updates.current_streak, 5); assert.equal(rested.updates.freeze_tokens, 0); assert.equal(rested.usedSabbath, true);
  const broken = step({ ...base, freeze_tokens: 0 }, '2026-11-12');
  assert.equal(broken.updates.current_streak, 1); assert.equal(broken.usedSabbath, false);
  const gone = step(base, '2026-11-14');   // three days away
  assert.equal(gone.updates.current_streak, 1); assert.equal(gone.updates.freeze_tokens, 0, 'rests are lost with the streak');
  assert.equal(gone.updates.longest_streak, 9, 'the best streak is never lowered');
  s.close();
});

test('every sixth day earns a Sabbath Rest, never more than 3', () => {
  const s = setup(); const step = get(s.w, 'computeStreakStep');
  const six = step(rec({ current_streak: 5, last_played_date: '2026-11-12', freeze_tokens: 0 }), '2026-11-13');
  assert.equal(six.updates.freeze_tokens, 1); assert.equal(six.sabbathEarned, true);
  const capped = step(rec({ current_streak: 11, last_played_date: '2026-11-12', freeze_tokens: 3 }), '2026-11-13');
  assert.equal(capped.updates.freeze_tokens, 3);
  assert.equal(step(rec({ current_streak: 6, last_played_date: '2026-11-12' }), '2026-11-13').sabbathEarned, false);
  s.close();
});

// ── Online behaviour is unchanged ────────────────────────

test('playing online extends the streak, saves it, and shows the celebration', async () => {
  const s = setup({ streak: rec({ current_streak: 3, longest_streak: 3, last_played_date: '2026-11-12', total_days_played: 3 }) });
  await s.call('updateStreak');
  assert.equal(s.net.patches.length, 1);
  assert.equal(s.net.patches[0].current_streak, 4);
  assert.equal(s.net.patches[0].last_played_date, '2026-11-13');
  await wait(1300);
  assert.equal(s.cards().length, 1);
  assert.equal(s.cards()[0][0], 4);
  assert.equal(s.days(), null, 'nothing waiting');
  s.close();
});

test('a second play the same day does not count again', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-13' }) });
  await s.call('updateStreak');
  assert.equal(s.net.patches.length, 0);
  s.close();
});

test('a guest has no streak', async () => {
  const s = setup({ signedIn: false });
  await s.call('updateStreak');
  assert.equal(s.net.calls, 0);
  s.close();
});

test('a streak the server could not save is kept for later instead of lost', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-12' }) });
  s.net.failPatch = true;
  const real = s.w.setTimeout.bind(s.w);
  s.w.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
  await s.call('updateStreak');
  assert.deepEqual(Array.from(s.days()), ['2026-11-13']);
  s.net.failPatch = false;
  assert.equal(await s.call('syncOfflineStreak'), true);
  assert.equal(s.net.streak.current_streak, 4);
  assert.equal(s.days().length, 0);
  s.close();
});

// ── Offline ──────────────────────────────────────────────

test('playing offline counts toward the streak, with the celebration, and sends nothing', async () => {
  const s = setup({ streak: rec({ current_streak: 3, longest_streak: 3, last_played_date: '2026-11-12', total_days_played: 3 }) });
  await s.call('loadStreak');          // seen while online earlier
  s.net.up = false; s.net.calls = 0;
  await s.call('updateStreak');
  assert.equal(s.net.calls, 0);
  assert.equal(s.cur().current_streak, 4);
  assert.equal(s.cur().last_played_date, '2026-11-13');
  assert.deepEqual(Array.from(s.days()), ['2026-11-13']);
  await wait(1300);
  assert.equal(s.cards()[0][0], 4, 'the celebration shows the new streak');
  assert.ok(s.toasts().some(t => /Streak counted/.test(t)));
  s.close();
});

test('playing again the same day offline does not count twice', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-12' }) });
  await s.call('loadStreak');
  s.net.up = false;
  await s.call('updateStreak'); await s.call('updateStreak'); await s.call('updateStreak');
  assert.equal(s.cur().current_streak, 4);
  assert.equal(s.days().length, 1);
  await wait(1300);
  assert.equal(s.cards().length, 1, 'celebrated once');
  s.close();
});

test('several days offline in a row build the streak day by day', async () => {
  const s = setup({ streak: rec({ current_streak: 3, longest_streak: 3, last_played_date: '2026-11-12', total_days_played: 3 }) });
  await s.call('loadStreak');
  s.net.up = false;
  await s.call('updateStreak');                         // Nov 13
  s.clock.set(at(2026, 11, 14)); await s.call('updateStreak');
  s.clock.set(at(2026, 11, 15)); await s.call('updateStreak');
  assert.equal(s.cur().current_streak, 6);
  assert.deepEqual(Array.from(s.days()), ['2026-11-13', '2026-11-14', '2026-11-15']);
  s.close();
});

test('back online, the waiting days are applied to the real streak in order and cleared', async () => {
  const s = setup({ streak: rec({ current_streak: 3, longest_streak: 3, last_played_date: '2026-11-12', total_days_played: 3 }) });
  await s.call('loadStreak');
  s.net.up = false;
  await s.call('updateStreak');
  s.clock.set(at(2026, 11, 14)); await s.call('updateStreak');
  s.net.up = true;
  assert.equal(await s.call('syncOfflineStreak'), true);
  assert.equal(s.net.patches.length, 1, 'one save for all the days');
  assert.equal(s.net.streak.current_streak, 5);
  assert.equal(s.net.streak.last_played_date, '2026-11-14');
  assert.equal(s.net.streak.total_days_played, 5);
  assert.equal(s.days().length, 0);
  assert.equal(s.cur()._offline, undefined, 'now the real record');
  s.close();
});

test('the "online" event syncs the streak', async () => {
  const s = setup({ streak: rec({ current_streak: 1, last_played_date: '2026-11-12', total_days_played: 1 }) });
  await s.call('loadStreak');
  s.net.up = false; await s.call('updateStreak');
  s.net.up = true; s.w.dispatchEvent(new s.w.Event('online'));
  await wait(80);
  assert.equal(s.net.streak.current_streak, 2);
  s.close();
});

test('if the server already has those days (another device), nothing is added twice', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-12' }) });
  await s.call('loadStreak');
  s.net.up = false; await s.call('updateStreak');
  s.net.streak = rec({ current_streak: 9, longest_streak: 9, last_played_date: '2026-11-13', total_days_played: 30 });   // played on a tablet meanwhile
  s.net.up = true;
  assert.equal(await s.call('syncOfflineStreak'), true);
  assert.equal(s.net.patches.length, 0);
  assert.equal(s.net.streak.current_streak, 9);
  assert.equal(s.days().length, 0);
  s.close();
});

test('a failed sync keeps the days and a later sync finishes the job', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-12' }) });
  await s.call('loadStreak');
  s.net.up = false; await s.call('updateStreak');
  s.net.up = true; s.net.failPatch = true;
  const real = s.w.setTimeout.bind(s.w);
  s.w.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
  assert.equal(await s.call('syncOfflineStreak'), false);
  assert.equal(s.days().length, 1);
  s.net.failPatch = false;
  assert.equal(await s.call('syncOfflineStreak'), true);
  assert.equal(s.net.streak.current_streak, 4);
  s.close();
});

test('with no connection the sync does nothing and keeps the days', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-12' }) });
  await s.call('loadStreak');
  s.net.up = false; await s.call('updateStreak');
  assert.equal(await s.call('syncOfflineStreak'), false);
  assert.equal(s.days().length, 1);
  s.close();
});

test('playing online first applies the days waiting from offline, then counts today', async () => {
  const s = setup({ streak: rec({ current_streak: 3, longest_streak: 3, last_played_date: '2026-11-12', total_days_played: 3 }) });
  await s.call('loadStreak');
  s.net.up = false; await s.call('updateStreak');        // Nov 13, offline
  s.net.up = true; s.clock.set(at(2026, 11, 14));
  await s.call('updateStreak');                          // Nov 14, online
  assert.equal(s.net.streak.current_streak, 5);
  assert.equal(s.net.streak.last_played_date, '2026-11-14');
  assert.equal(s.net.streak.total_days_played, 5);
  assert.equal(s.days().length, 0);
  s.close();
});

test('the last streak seen is shown when the app opens offline, and survives a restart', async () => {
  const s = setup({ streak: rec({ current_streak: 7, longest_streak: 9, last_played_date: '2026-11-12' }) });
  await s.call('loadStreak');
  s.net.up = false;
  s.w.eval('currentStreak = null');                      // as after reopening the app
  const shown = await s.call('loadStreak');
  assert.equal(shown.current_streak, 7);
  assert.equal(shown._offline, true);
  s.close();
});

test('never having seen a streak, offline play is still remembered and counted when back online', async () => {
  const s = setup({ streak: rec({ current_streak: 2, last_played_date: '2026-11-12', total_days_played: 2 }), up: false });
  await s.call('updateStreak');
  assert.deepEqual(Array.from(s.days()), ['2026-11-13']);
  assert.ok(s.toasts().some(t => /Streak counted/.test(t)));
  s.net.up = true;
  await s.call('syncOfflineStreak');
  assert.equal(s.net.streak.current_streak, 3);
  s.close();
});

test('days waiting for one account are not applied to another, and deleting an account clears them', async () => {
  const s = setup({ streak: rec({ current_streak: 3, last_played_date: '2026-11-12' }) });
  await s.call('loadStreak');
  s.net.up = false; await s.call('updateStreak');
  s.w.eval(`currentUser = { id: 'someone-else' }`);
  assert.equal(s.call('readStreakDays').length, 0);
  assert.equal(s.call('readCachedStreak'), null);
  s.w.eval(`currentUser = { id: '${U}' }`);
  assert.equal(s.call('readStreakDays').length, 1);
  s.call('clearSavedPlayerData', U);
  assert.equal(s.call('readStreakDays').length, 0);
  assert.equal(s.call('readCachedStreak'), null);
  s.close();
});

test('damaged saved data is ignored, not a crash', async () => {
  const s = setup();
  s.w.localStorage.setItem(`ss_streak_days_${U}`, '{oops');
  s.w.localStorage.setItem(`ss_streak_${U}`, 'nope');
  assert.equal(s.call('readStreakDays').length, 0);
  assert.equal(s.call('readCachedStreak'), null);
  s.w.localStorage.setItem(`ss_streak_days_${U}`, JSON.stringify(['2026-11-13', 'garbage', 5, null, '2026-11-13']));
  assert.deepEqual(Array.from(s.call('readStreakDays')), ['2026-11-13']);
  s.close();
});

test('an offline Story Mode chapter counts toward the streak too', async () => {
  const s = setup({ streak: rec({ current_streak: 3, longest_streak: 3, last_played_date: '2026-11-12', total_days_played: 3 }) });
  await s.call('loadStreak');
  s.net.up = false;
  s.w.eval(`globalThis.getLastChapterNum = async () => 3;`);   // as from the saved copy
  await s.call('completeStoryChapter', 1, 1, 2);
  assert.equal(s.cur().current_streak, 4);
  assert.deepEqual(Array.from(s.days()), ['2026-11-13']);
  s.close();
});
