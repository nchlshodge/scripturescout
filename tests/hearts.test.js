// Story Mode hearts: losing a heart, refilling one every 30 minutes, the "Out of Hearts" screen and its countdown.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get, fakeClock, fakeIntervals } = require('./helpers');

const MIN = 60 * 1000, REFILL = 30 * MIN;
const T0 = new Date(2026, 10, 13, 12, 0, 0).getTime();

function setup() {
  const app = loadApp();
  const clock = fakeClock(app.window, T0);
  const timers = fakeIntervals(app.window);
  const w = app.window;
  return {
    ...app, clock, timers,
    hearts: () => get(w, 'getCurrentHearts')(),
    lose: () => get(w, 'loseHeart')(),
    stored: () => JSON.parse(w.localStorage.getItem('ss_hearts')),
    next: () => get(w, 'getNextRefillTime')(),
  };
}

test('a new player starts with 3 hearts and no timer', () => {
  const s = setup();
  assert.equal(s.hearts(), 3);
  assert.equal(s.next(), null);
  s.close();
});

test('losing hearts counts down to 0 and never below', () => {
  const s = setup();
  assert.deepEqual([s.lose(), s.lose(), s.lose(), s.lose()], [2, 1, 0, 0]);
  assert.equal(s.hearts(), 0);
  s.close();
});

test('the first lost heart starts the 30-minute timer', () => {
  const s = setup();
  s.lose();
  assert.equal(s.stored().lastLostTime, T0);
  assert.equal(s.next(), REFILL);
  s.close();
});

test('one heart comes back after exactly 30 minutes, not before', () => {
  const s = setup();
  s.lose(); s.lose();                         // 1 heart left
  s.clock.advance(REFILL - 1000);
  assert.equal(s.hearts(), 1);
  s.clock.advance(1000);
  assert.equal(s.hearts(), 2);
  s.close();
});

test('hearts refill one per 30 minutes and stop at 3', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();               // 0 hearts
  s.clock.advance(REFILL * 2);
  assert.equal(s.hearts(), 2);
  s.clock.advance(REFILL * 10);
  assert.equal(s.hearts(), 3);
  assert.equal(s.stored().lastLostTime, null, 'timer is cleared once full');
  assert.equal(s.next(), null);
  s.close();
});

test('a partly-elapsed refill is carried over, not thrown away, when hearts refill', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();               // 0 hearts
  s.clock.advance(REFILL + 10 * MIN);         // 1 refilled, 10 minutes into the next
  assert.equal(s.hearts(), 1);
  assert.equal(s.next(), 20 * MIN);
  s.close();
});

test('losing another heart does not restart a refill that is already running', () => {
  // Regression: loseHeart() set the timer to "now" every time, wiping out minutes already waited.
  const s = setup();
  s.lose();                                   // 2 hearts, timer starts
  s.clock.advance(25 * MIN);                  // 5 minutes until the next heart
  assert.equal(s.lose(), 1);                  // lose another
  assert.equal(s.next(), 5 * MIN, 'the heart that was almost back is still due in 5 minutes');
  s.clock.advance(5 * MIN);
  assert.equal(s.hearts(), 2);
  s.close();
});

test('the countdown counts down as time passes', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();
  s.clock.advance(10 * MIN);
  assert.equal(s.next(), 20 * MIN);
  s.close();
});

test('formatCountdown shows minutes and zero-padded seconds', () => {
  const f = (setup => get(setup.window, 'formatCountdown'))(setup());
  assert.equal(f(0), '0:00');
  assert.equal(f(1), '0:01');
  assert.equal(f(59000), '0:59');
  assert.equal(f(60000), '1:00');
  assert.equal(f(61000), '1:01');
  assert.equal(f(REFILL), '30:00');
  assert.equal(f(90 * MIN + 5000), '90:05');
});

test('bad or odd saved data never crashes and always gives 0 to 3 hearts', () => {
  const s = setup();
  for (const raw of ['not json', 'null', '42', '"x"', '{}', '{"hearts":"2"}', '{"hearts":99,"lastLostTime":1}', '{"hearts":-5,"lastLostTime":1}', '{"hearts":1,"lastLostTime":"abc"}', '{"hearts":null}']) {
    s.window.localStorage.setItem('ss_hearts', raw);
    let n;
    assert.doesNotThrow(() => { n = s.hearts(); }, raw);
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 3, `${raw} gave ${n}`);
    assert.doesNotThrow(() => s.lose(), raw);
    assert.doesNotThrow(() => s.next(), raw);
  }
  s.close();
});

test('setting the phone clock back does not cost the player hearts', () => {
  // Regression: a negative elapsed time produced a negative refill count and removed hearts.
  const s = setup();
  s.lose();                                   // 2 hearts, timer started at T0
  s.clock.set(T0 - 3 * 60 * MIN);             // clock moved back 3 hours
  assert.equal(s.hearts(), 2);
  assert.ok(s.next() <= REFILL && s.next() >= 0, 'countdown stays within one refill period');
  s.close();
});

test('checkHeartsBeforeRound lets the player in with hearts, and shows the empty screen without', () => {
  const s = setup();
  let proceeded = null, wentBack = 0;
  get(s.window, 'checkHeartsBeforeRound')(n => { proceeded = n; }, () => { wentBack++; });
  assert.equal(proceeded, 3);
  s.lose(); s.lose(); s.lose();
  proceeded = null;
  get(s.window, 'checkHeartsBeforeRound')(n => { proceeded = n; }, () => { wentBack++; });
  assert.equal(proceeded, null);
  assert.match(s.window.document.getElementById('root').textContent, /Out of Hearts/);
  assert.equal(wentBack, 0);
  s.close();
});

test('the Out of Hearts screen shows the countdown and a slot for each heart', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();
  get(s.window, 'showHeartsEmptyScreen')(() => {});
  const d = s.window.document;
  assert.equal(d.getElementById('heartCountdown').textContent, '30:00');
  assert.match(d.getElementById('heartTimerNext').textContent, /Full hearts in 90:00/);
  const slots = [...d.querySelectorAll('.heart-refill-slot')].map(e => e.className.replace('heart-refill-slot ', ''));
  assert.deepEqual(slots, ['refilling', 'empty', 'empty']);
  s.close();
});

test('the Out of Hearts screen counts down each second and returns automatically when a heart is back', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();
  let back = 0;
  get(s.window, 'showHeartsEmptyScreen')(() => { back++; });
  s.clock.advance(5 * MIN + 1000); s.timers.tick();
  assert.equal(s.window.document.getElementById('heartCountdown').textContent, '24:59');
  assert.equal(back, 0);
  s.clock.advance(REFILL); s.timers.tick();        // a heart has come back
  assert.equal(back, 1, 'sent back once');
  s.timers.tick(); s.timers.tick();
  assert.equal(back, 1, 'and only once');
  assert.equal(s.timers.active.size, 0, 'the timer stopped');
  s.close();
});

test('if hearts refilled while the player was away, the empty screen is skipped', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();
  s.clock.advance(REFILL);
  let back = 0;
  get(s.window, 'showHeartsEmptyScreen')(() => { back++; });
  assert.equal(back, 1);
  s.close();
});

test('leaving the Out of Hearts screen stops its timer, so it cannot yank the player back later', () => {
  // Regression: "Go Back" left the 1-second timer running; when a heart came back 30 minutes later it
  // called Home on top of whatever the player was doing.
  const s = setup();
  s.lose(); s.lose(); s.lose();
  let back = 0;
  get(s.window, 'showHeartsEmptyScreen')(() => { back++; });
  get(s.window, 'goBackFromHeartsEmpty')();
  assert.equal(back, 1);
  assert.equal(s.timers.active.size, 0, 'timer should be stopped after going back');
  s.clock.advance(REFILL * 3); s.timers.tick();
  assert.equal(back, 1, 'no second navigation');
  s.close();
});

test('the timer also stops itself if the player navigates away without using Go Back', () => {
  const s = setup();
  s.lose(); s.lose(); s.lose();
  let back = 0;
  get(s.window, 'showHeartsEmptyScreen')(() => { back++; });
  s.window.document.getElementById('root').innerHTML = '<p>some other screen</p>';   // e.g. the nav bar was used
  s.clock.advance(REFILL); s.timers.tick();
  assert.equal(back, 0, 'must not redirect from another screen');
  assert.equal(s.timers.active.size, 0);
  s.close();
});
