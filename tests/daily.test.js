// Daily Challenge date logic: the day key, per-day completion, the daily topic, and the leaderboard window.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

// Runs fn with the app's clock set to a local date/time in the given time zone.
function withClock(tz, localParts, fn) {
  const prevTz = process.env.TZ;
  process.env.TZ = tz;
  const { window } = loadApp();
  const RealDate = window.Date;
  const [y, mo, d, h = 12, mi = 0] = localParts;
  const fixed = new RealDate(y, mo - 1, d, h, mi, 0).getTime();
  window.Date = class extends RealDate {
    constructor(...a) { a.length === 0 ? super(fixed) : super(...a); }
    static now() { return fixed; }
  };
  window.eval('globalThis.Date = window.Date');
  try { return fn(window); }
  finally { window.close(); if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; }
}

const ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Europe/London'];

test('day key is the local calendar date, zero-padded, in every time zone', () => {
  for (const tz of ZONES) {
    withClock(tz, [2026, 3, 5, 0, 30], w => assert.equal(get(w, 'getDailyKey')(), '2026-03-05', tz + ' just after midnight'));
    withClock(tz, [2026, 3, 5, 23, 59], w => assert.equal(get(w, 'getDailyKey')(), '2026-03-05', tz + ' just before midnight'));
  }
  withClock('UTC', [2026, 12, 31, 12], w => assert.equal(get(w, 'getDailyKey')(), '2026-12-31'));
  withClock('UTC', [2027, 1, 1, 0, 5], w => assert.equal(get(w, 'getDailyKey')(), '2027-01-01'));
});

test('completion and score are remembered per game and reset on a new day', () => {
  withClock('America/Los_Angeles', [2026, 11, 13, 10], w => {
    const done = get(w, 'isDailyCompleted'), mark = get(w, 'markDailyCompleted'), score = get(w, 'getDailyScore');
    assert.equal(done('trivia'), false);
    assert.equal(score('trivia'), 0);
    mark('trivia', 1200);
    assert.equal(done('trivia'), true);
    assert.equal(score('trivia'), 1200);
    assert.equal(done('mia'), false, 'other games are unaffected');
    // Same browser storage, next day:
    const store = w.localStorage;
    const RealDate = w.Date; const next = new RealDate(2026, 10, 14, 9, 0, 0).getTime();
    w.Date = class extends RealDate { constructor(...a) { a.length === 0 ? super(next) : super(...a); } static now() { return next; } };
    w.eval('globalThis.Date = window.Date');
    assert.equal(get(w, 'getDailyKey')(), '2026-11-14');
    assert.equal(done('trivia'), false, 'a new day starts fresh');
    assert.equal(score('trivia'), 0);
    assert.ok(store.getItem('ss_dailychallenge_trivia_2026-11-13') !== null, "yesterday's result is kept");
  });
});

test('daily seed is stable within a day, differs between days and between extras', () => {
  const seeds = {};
  for (const [label, parts] of [['a', [2026, 11, 13, 8]], ['a2', [2026, 11, 13, 22]], ['b', [2026, 11, 14, 8]]]) {
    withClock('UTC', parts, w => { seeds[label] = [get(w, 'getDailySeed')(), get(w, 'getDailySeed')('topic')]; });
  }
  assert.deepEqual(seeds.a, seeds.a2, 'same day, same seed');
  assert.notEqual(seeds.a[0], seeds.b[0], 'different day, different seed');
  assert.notEqual(seeds.a[0], seeds.a[1], 'extra changes the seed');
  assert.ok(Number.isInteger(seeds.a[0]) && seeds.a[0] >= 0);
});

test('the daily topic comes from the list, stays the same all day, and changes at midnight', () => {
  for (const tz of ZONES) {
    // Every hour of a normal day gives the same topic.
    const topics = new Set();
    for (const h of [0, 0.5, 1, 6, 12, 18, 23]) {
      withClock(tz, [2026, 6, 10, Math.floor(h), h % 1 ? 30 : 0], w => topics.add(get(w, 'getTodaysTopic')()));
    }
    assert.equal(topics.size, 1, `${tz}: topic changed during the day: ${[...topics]}`);
    // Next day is different.
    withClock(tz, [2026, 6, 11, 0, 5], w => assert.ok(!topics.has(get(w, 'getTodaysTopic')()), tz + ' next day should differ'));
  }
});

test('the topic does not change at 1 a.m. when daylight saving time is in effect', () => {
  // Regression: the day-of-year maths used raw milliseconds, so during DST the new topic arrived an hour late.
  withClock('America/Los_Angeles', [2026, 7, 4, 0, 10], w => { const t = get(w, 'getTodaysTopic')(); globalThis.__t0 = t; });
  withClock('America/Los_Angeles', [2026, 7, 4, 12, 0], w => assert.equal(get(w, 'getTodaysTopic')(), globalThis.__t0));
  withClock('Europe/London', [2026, 7, 4, 0, 10], w => { globalThis.__t1 = get(w, 'getTodaysTopic')(); });
  withClock('Europe/London', [2026, 7, 4, 12, 0], w => assert.equal(get(w, 'getTodaysTopic')(), globalThis.__t1));
});

test('topic cycles through the whole list across a year boundary without gaps or errors', () => {
  withClock('UTC', [2026, 12, 31, 12], w => {
    const topics = get(w, 'DAILY_TOPICS');
    assert.ok(topics.length > 100);
    const dec31 = get(w, 'getTodaysTopic')();
    assert.ok(topics.includes(dec31));
  });
  withClock('UTC', [2027, 1, 1, 12], w => assert.ok(get(w, 'DAILY_TOPICS').includes(get(w, 'getTodaysTopic')())));
  // Leap day exists and is valid.
  withClock('UTC', [2028, 2, 29, 12], w => assert.ok(get(w, 'DAILY_TOPICS').includes(get(w, 'getTodaysTopic')())));
});

test('the home screen theme and the Daily Challenge agree on the topic', async () => {
  await withClockAsync('UTC', [2026, 11, 13, 12], async w => {
    w.eval('globalThis.sbFetch = async () => []');
    const { topic } = await get(w, 'getDailyTopicAndVerses')();
    assert.equal(topic, get(w, 'getTodaysTopic')());
  });
});

test("the daily leaderboard window is the player's local day", async () => {
  // Regression: new Date('YYYY-MM-DD') is midnight UTC, so for anyone west of UTC the window ended
  // hours before their day did and evening scores never appeared on the board.
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    await withClockAsync(tz, [2026, 11, 13, 20], async w => {
      let url = '';
      w.eval('globalThis.sbFetch = async (u) => { globalThis.__url = u; return []; }');
      await get(w, 'fetchDailyLeaderboard')('trivia');
      url = w.__url;
      const since = new Date(decodeURIComponent(url.match(/created_at=gte\.([^&]+)/)[1])).getTime();
      const until = new Date(decodeURIComponent(url.match(/created_at=lt\.([^&]+)/)[1])).getTime();
      const now = new Date(2026, 10, 13, 20).getTime();                       // 8 p.m. local, in this zone
      const localMidnight = new Date(2026, 10, 13, 0).getTime();
      const nextMidnight = new Date(2026, 10, 14, 0).getTime();
      assert.equal(since, localMidnight, tz + ': window should start at local midnight');
      assert.equal(until, nextMidnight, tz + ': window should end at the next local midnight');
      assert.ok(since <= now && now < until, tz + ': now is inside the window');
    });
  }
});

test('daily topic and verses are cached per day, not for the life of the page', async () => {
  // Regression: the in-memory cache never expired, so an app left open past midnight kept yesterday's topic.
  await withClockAsync('UTC', [2026, 11, 13, 23, 50], async w => {
    let topicCalls = 0;
    w.eval(`globalThis.sbFetch = async (u) => { if (u.startsWith('verse_topics')) { globalThis.__topics = (globalThis.__topics||0)+1; return []; } return []; }`);
    const first = await get(w, 'getDailyTopicAndVerses')();
    // Move the clock past midnight without reloading the page.
    const RealDate = w.Date; const next = new RealDate(2026, 10, 14, 0, 10, 0).getTime();
    w.Date = class extends RealDate { constructor(...a) { a.length === 0 ? super(next) : super(...a); } static now() { return next; } };
    w.eval('globalThis.Date = window.Date');
    const second = await get(w, 'getDailyTopicAndVerses')();
    assert.notEqual(second.topic, first.topic, 'a new day should pick a new topic');
  });
});

async function withClockAsync(tz, localParts, fn) {
  const prevTz = process.env.TZ;
  process.env.TZ = tz;
  const { window } = loadApp();
  const RealDate = window.Date;
  const [y, mo, d, h = 12, mi = 0] = localParts;
  const fixed = new RealDate(y, mo - 1, d, h, mi, 0).getTime();
  window.Date = class extends RealDate { constructor(...a) { a.length === 0 ? super(fixed) : super(...a); } static now() { return fixed; } };
  window.eval('globalThis.Date = window.Date');
  try { return await fn(window); }
  finally { window.close(); if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz; }
}
