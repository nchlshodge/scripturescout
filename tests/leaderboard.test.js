// The Scripture Scout leaderboard screen: the This Week / All Time tabs and the difficulty tabs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

async function setup({ rows = {}, fails = false } = {}) {
  const app = loadApp(); const w = app.window;
  w.__rows = rows; w.__fails = fails; w.__queries = [];
  w.eval(`
    globalThis.sbFetch = async (p) => {
      window.__queries.push(p);
      if (window.__fails) throw new Error('offline');
      const diff = (p.match(/difficulty=eq\\.(\\w+)/) || [])[1];
      const weekly = /created_at=gte\\./.test(p);
      return (window.__rows[diff + (weekly ? ':week' : ':all')] || []);
    };
    globalThis.checkMonthlyChampion = () => {};
    globalThis.renderAuthScreen = () => {};   // start-up would otherwise draw the sign-in screen over our test
    lbFilter = 'easy'; lbView = 'weekly';
  `);
  await get(w, 'renderLeaderboard')();
  await wait();
  const names = () => [...w.document.querySelectorAll('#lbCard .lb-name')].map(e => e.textContent.trim());
  const active = id => w.document.getElementById(id).classList.contains('active');
  return { ...app, w, names, active, queries: () => Array.from(w.__queries) };
}
const r = (name, score) => ({ name, score });

test('the screen opens on This Week, showing only the last 7 days', async () => {
  const s = await setup({ rows: { 'easy:week': [r('Weekly Wendy', 900)], 'easy:all': [r('Old Olive', 5000)] } });
  assert.ok(s.active('lbWeeklyTab')); assert.ok(!s.active('lbAlltimeTab'));
  assert.deepEqual(s.names(), ['Weekly Wendy']);
  const q = s.queries().find(x => x.startsWith('leaderboard?'));
  const since = new Date(decodeURIComponent(q.match(/created_at=gte\.([^&]+)/)[1])).getTime();
  assert.ok(Math.abs(Date.now() - 7 * 86400000 - since) < 60000, 'about seven days ago');
  s.close();
});

test('tapping All Time switches the highlight and shows every score', async () => {
  // Regression: the tab called a function that did not exist, so the list never changed.
  const s = await setup({ rows: { 'easy:week': [r('Weekly Wendy', 900)], 'easy:all': [r('Old Olive', 5000), r('Weekly Wendy', 900)] } });
  s.w.document.getElementById('lbAlltimeTab').click(); await wait();
  assert.ok(s.active('lbAlltimeTab')); assert.ok(!s.active('lbWeeklyTab'));
  assert.deepEqual(s.names(), ['Old Olive', 'Weekly Wendy']);
  assert.ok(!/created_at=gte/.test(s.queries().at(-1)), 'no date limit for All Time');
  s.close();
});

test('going back to This Week limits the list again', async () => {
  const s = await setup({ rows: { 'easy:week': [r('Weekly Wendy', 900)], 'easy:all': [r('Old Olive', 5000)] } });
  s.w.document.getElementById('lbAlltimeTab').click(); await wait();
  s.w.document.getElementById('lbWeeklyTab').click(); await wait();
  assert.deepEqual(s.names(), ['Weekly Wendy']);
  s.close();
});

test('changing difficulty keeps the chosen time range', async () => {
  const s = await setup({ rows: { 'hard:all': [r('Hank', 800)], 'hard:week': [r('Hazel', 100)], 'easy:all': [r('Ed', 300)] } });
  s.w.document.getElementById('lbAlltimeTab').click(); await wait();
  s.w.document.getElementById('lbHard').click(); await wait();
  assert.deepEqual(s.names(), ['Hank']);
  assert.ok(s.active('lbHard') && !s.active('lbEasy'));
  assert.match(s.w.document.getElementById('lbDesc').textContent, /Hard/);
  s.close();
});

test('an empty board says so, and says "this week" only for the weekly view', async () => {
  const s = await setup({ rows: {} });
  assert.match(s.w.document.getElementById('lbCard').textContent, /No easy scores this week/);
  s.w.document.getElementById('lbAlltimeTab').click(); await wait();
  assert.match(s.w.document.getElementById('lbCard').textContent, /No easy scores yet/);
  s.close();
});

test('if scores cannot be loaded the card says so instead of spinning forever', async () => {
  const s = await setup({ fails: true });
  assert.match(s.w.document.getElementById('lbCard').textContent, /Couldn't load scores/);
  s.close();
});

test('names are shown as text and scores have separators', async () => {
  const s = await setup({ rows: { 'easy:week': [r('<img src=x onerror="window.__pwned=1">', 12345)] } });
  assert.equal(s.w.document.querySelectorAll('#lbCard img[src="x"]').length, 0);
  assert.match(s.w.document.getElementById('lbCard').textContent, /12,345/);
  s.close();
});
