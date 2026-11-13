// The Daily Challenge screens: the hub, the home card, starting a game, each of the four daily games,
// saving scores, and the results screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get, fakeClock, fakeTimeouts, fakeIntervals } = require('./helpers');

const ME = 'me-1';
const NOON = new Date(2026, 10, 13, 12, 0, 0).getTime();
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

const VERSES = [
  { id: 1, book: 'John', chapter: 3, verse: 16, testament: 'NT', text: 'For God so loved the world that he gave his one and only Son' },
  { id: 2, book: 'Psalms', chapter: 23, verse: 1, testament: 'OT', text: 'The LORD is my shepherd I shall not want anything' },
  { id: 3, book: 'Romans', chapter: 8, verse: 28, testament: 'NT', text: 'All things work together for good for those who love God' },
  { id: 4, book: 'Genesis', chapter: 1, verse: 1, testament: 'OT', text: 'In the beginning God created the heavens and the earth' },
];

function setup({ user = ME, status = {}, board = [], offline = false, verses = VERSES, startMs = NOON } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const key = Object.keys(status).find(k => u.includes(k));
    const code = key ? status[key] : 200;
    return { ok: code >= 200 && code < 300, status: code, json: async () => [], text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  const clock = fakeClock(w, startMs);
  const timeouts = fakeTimeouts(w);
  fakeIntervals(w);
  w.__board = board; w.__offline = offline; w.__verses = verses; w.__boardFails = false;
  w.eval(`
    ${user ? `currentUser = { id: '${user}' }; authToken = 't';` : 'currentUser = null; authToken = null;'}
    currentUsername = 'Me'; playerName = 'Me';
    globalThis.sbFetch = async (p) => {
      if (window.__offline) throw new Error('offline');
      if (p.startsWith('verse_topics?')) return window.__verses.map(v => ({ book: v.book, chapter: v.chapter, verse: v.verse }));
      if (p.startsWith('verses?')) { const m = p.match(/book=eq\\.([^&]+)&chapter=eq\\.(\\d+)&verse=eq\\.(\\d+)/); return m ? window.__verses.filter(v => v.book === decodeURIComponent(m[1]) && v.chapter == m[2] && v.verse == m[3]) : window.__verses.slice(0, 1); }
      if (p.startsWith('leaderboard_daily?')) { if (window.__boardFails) throw new Error('offline'); return window.__board; }
      return [];
    };
    globalThis.updateStreak = async () => { window.__streakUpdates = (window.__streakUpdates || 0) + 1; };
    globalThis.playComplete = () => {};
    globalThis.renderAuthScreen = () => {};   // the app's start-up would otherwise draw the sign-in screen over our test
  `);
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute('role') === 'status').map(c => c.textContent);
  const submits = () => calls.filter(c => c.method === 'POST' && c.url.includes('/rest/v1/leaderboard_daily')).map(c => c.body);
  const root = () => w.document.getElementById('root');
  const key = () => get(w, 'getDailyKey')();
  return { ...app, w, calls, clock, timeouts, toasts, submits, root, key };
}
const mark = (s, game, score) => get(s.w, 'markDailyCompleted')(game, score);

// ── The hub ────────────────────────────────────────────

test('the hub shows the four games, each with Play when not done yet', async () => {
  const s = setup();
  await get(s.w, 'renderDailyChallenge')();
  const cards = [...s.root().querySelectorAll('.daily-card')];
  assert.deepEqual(cards.map(c => c.id), ['daily_scout', 'daily_trivia', 'daily_mia', 'daily_track']);
  assert.ok(cards.every(c => /Play/.test(c.querySelector('.daily-card-badge').textContent) && !c.classList.contains('completed')));
  s.close();
});

test("today's theme is shown even with no connection (it does not need the network)", async () => {
  // Regression: the theme label waited on a network call and stayed on "Loading…" when offline.
  const s = setup({ offline: true });
  await get(s.w, 'renderDailyChallenge')();
  await wait(40);
  const label = s.root().querySelector('#dailyTopicLabel').textContent;
  assert.doesNotMatch(label, /Loading|…/);
  assert.match(label.toLowerCase(), new RegExp(get(s.w, 'getTodaysTopic')().toLowerCase()));
  s.close();
});

test('the countdown shows the hours and minutes left until local midnight', async () => {
  const s = setup({ startMs: new Date(2026, 10, 13, 20, 30, 0).getTime() });
  await get(s.w, 'renderDailyChallenge')();
  assert.match(s.root().textContent, /Resets in 3h 30m/);
  s.close();
});

test('finished games show Done and the score; the others still say Play', async () => {
  const s = setup();
  mark(s, 'trivia', 1300); mark(s, 'track', 0);
  await get(s.w, 'renderDailyChallenge')();
  const card = id => s.root().querySelector('#daily_' + id);
  assert.ok(card('trivia').classList.contains('completed')); assert.match(card('trivia').textContent, /Done/); assert.match(card('trivia').textContent, /1,300 pts/);
  assert.ok(card('track').classList.contains('completed')); assert.match(card('track').textContent, /0 pts/);
  assert.ok(!card('scout').classList.contains('completed')); assert.match(card('scout').textContent, /Play/);
  s.close();
});

test('tapping an unplayed game starts it; tapping a finished one shows its leaderboard', async () => {
  const s = setup();
  s.w.eval(`globalThis.startDailyGame = (g) => { (window.__started = window.__started || []).push(g); }; globalThis.showDailyLeaderboard = (g) => { (window.__lbs = window.__lbs || []).push(g); };`);
  mark(s, 'mia', 400);
  await get(s.w, 'renderDailyChallenge')();
  s.root().querySelector('#daily_scout').click(); s.root().querySelector('#daily_mia').click();
  assert.deepEqual(Array.from(s.w.__started), ['scout']);
  assert.deepEqual(Array.from(s.w.__lbs), ['mia']);
  s.close();
});

// ── The home screen card ───────────────────────────────

async function homeText(s) {
  s.w.eval(`globalThis.fetchVerseOfDay = async () => null; globalThis.refreshHomeStreak = () => {};`);
  await get(s.w, 'showHome')();
  const d = s.w.document;
  return { cta: d.getElementById('homeDailyBtn').textContent.trim(), count: d.querySelector('.hm-daily-count').textContent.trim(), done: d.querySelectorAll('.hm-tile.done').length, bar: d.querySelector('.hm-progress').getAttribute('aria-valuenow') };
}

test('the home card invites you to start, then to continue, then to see results', async () => {
  let s = setup();
  assert.deepEqual(await homeText(s), { cta: "Start today's challenge", count: '0of 4', done: 0, bar: '0' }); s.close();
  s = setup(); mark(s, 'scout', 900); mark(s, 'track', 500);
  assert.deepEqual(await homeText(s), { cta: 'Continue · 2 of 4 done', count: '2of 4', done: 2, bar: '2' }); s.close();
  s = setup(); for (const g of ['scout', 'trivia', 'mia', 'track']) mark(s, g, 100);
  assert.deepEqual(await homeText(s), { cta: "See today's results", count: '4of 4', done: 4, bar: '4' }); s.close();
});

test("yesterday's results don't count today", async () => {
  const s = setup();
  s.w.localStorage.setItem('ss_dailychallenge_scout_2026-11-12', '900');
  assert.equal((await homeText(s)).done, 0);
  s.close();
});

// ── Starting a game ────────────────────────────────────

function stubRenderers(s) {
  s.w.eval(`
    globalThis.__screens = [];
    globalThis.renderDailyScout = (v) => { __screens.push(['scout', v.book]); };
    globalThis.renderDailyMIA = (v) => { __screens.push(['mia', v.book]); };
    globalThis.renderDailyTrack = (v) => { __screens.push(['track', v.book]); };
    globalThis.renderDailyTriviaGame = (t) => { __screens.push(['trivia', t]); };
  `);
}

test('each game gets its own verse from the day\'s four, and opens its own screen', async () => {
  const s = setup(); stubRenderers(s);
  for (const g of ['scout', 'trivia', 'mia', 'track']) await get(s.w, 'startDailyGame')(g);
  const shown = Array.from(s.w.__screens).map(x => x.join(':'));
  assert.deepEqual(shown, ['scout:John', 'trivia:' + get(s.w, 'getTodaysTopic')(), 'mia:Romans', 'track:Genesis'].map(x => x));
  s.close();
});

test('if today\'s verses cannot be loaded, the player sees a message instead of a stuck spinner', async () => {
  // Regression: a dropped connection left "Loading today's verse…" on screen forever.
  const s = setup({ offline: true }); stubRenderers(s);
  await get(s.w, 'startDailyGame')('scout');
  assert.match(s.root().textContent, /Could not load today's challenge/);
  assert.equal(s.w.__screens.length, 0);
  s.close();
});

test('with no verses available at all the player is told too', async () => {
  const s = setup({ verses: [] }); stubRenderers(s);
  s.w.eval(`globalThis.sbFetch = async () => []`);
  await get(s.w, 'startDailyGame')('mia');
  assert.match(s.root().textContent, /Could not load today's challenge/);
  s.close();
});

test('a game you already finished today cannot be started again', async () => {
  // Regression: nothing stopped a direct call replaying a finished game for a better score.
  const s = setup(); stubRenderers(s);
  s.w.eval(`globalThis.showDailyLeaderboard = (g) => { (window.__lbs = window.__lbs || []).push(g); };`);
  mark(s, 'scout', 900);
  await get(s.w, 'startDailyGame')('scout');
  assert.equal(s.w.__screens.length, 0);
  assert.deepEqual(Array.from(s.w.__lbs || []), ['scout']);
  s.close();
});

// ── Daily Bible Trivia ─────────────────────────────────

test("everyone gets the same five trivia questions, in the same order, on the same day", () => {
  // Regression: the "seed" was mixed with Math.random(), so every player (and every visit) got different questions.
  const lists = [];
  for (let i = 0; i < 3; i++) {
    const s = setup();
    lists.push(Array.from(get(s.w, 'getDailyTriviaQuestions')('faith', 5)).map(q => q.q));
    s.close();
  }
  assert.deepEqual(lists[1], lists[0]); assert.deepEqual(lists[2], lists[0]);
});

test('a different day brings different questions', () => {
  const day = (ms) => { const s = setup({ startMs: ms }); const l = Array.from(get(s.w, 'getDailyTriviaQuestions')('faith', 5)).map(q => q.q); s.close(); return l; };
  assert.notDeepEqual(day(NOON), day(NOON + 86400000 * 3));
});

test('every topic gets exactly five different questions', () => {
  const s = setup();
  const topics = get(s.w, 'DAILY_TOPICS');
  for (const t of topics) {
    const qs = Array.from(get(s.w, 'getDailyTriviaQuestions')(t, 5));
    assert.equal(qs.length, 5, t);
    assert.equal(new Set(qs.map(q => q.q)).size, 5, t + ' has a repeated question');
  }
  s.close();
});

test('every trivia question is well-formed: the answer is one of the choices, with unique choices and a reference', () => {
  const s = setup();
  const bank = Array.from(get(s.w, 'DAILY_TRIVIA_BANK'));
  assert.ok(bank.length >= 40);
  const bad = [];
  for (const q of bank) {
    const choices = Array.from(q.choices);
    if (!q.q || !q.a || !choices.includes(q.a) || new Set(choices).size !== choices.length || choices.length < 3 || !q.ref || !['easy', 'medium', 'hard'].includes(q.diff)) bad.push(q.q);
  }
  assert.deepEqual(bad, []);
  s.close();
});

async function playTrivia(s, picks) {      // picks: array of 'right' | 'wrong' for each question
  await get(s.w, 'startDailyGame')('trivia');
  const bank = Array.from(get(s.w, 'DAILY_TRIVIA_BANK'));
  for (let i = 0; i < picks.length; i++) {
    const qText = [...s.root().querySelectorAll('div')].find(d => d.style.lineHeight === '1.5' && d.textContent.trim().length > 10 && bank.some(b => b.q === d.textContent.trim()));
    const q = bank.find(b => b.q === qText.textContent.trim());
    const buttons = [...s.root().querySelectorAll('.ref-option')];
    const btn = picks[i] === 'right' ? buttons.find(b => b.dataset.ans === q.a) : buttons.find(b => b.dataset.ans !== q.a);
    btn.click();
    await wait(); s.timeouts.advance(1200); await wait();
  }
  return bank;
}

test('trivia scores 300 / 500 / 800 for easy / medium / hard questions and nothing for wrong answers', async () => {
  const s = setup();
  s.w.eval(`globalThis.showDailyResult = (g, sc) => { window.__result = [g, sc]; };`);
  await get(s.w, 'startDailyGame')('trivia');
  const bank = Array.from(get(s.w, 'DAILY_TRIVIA_BANK'));
  const qs = Array.from(get(s.w, 'getDailyTriviaQuestions')(get(s.w, 'getTodaysTopic')(), 5));
  const worth = d => ({ easy: 300, medium: 500, hard: 800 })[d];
  // Answer the first two correctly and the rest wrongly.
  let expected = 0;
  for (let i = 0; i < 5; i++) {
    const text = qs[i].q;
    const q = bank.find(b => b.q === text);
    const buttons = [...s.root().querySelectorAll('.ref-option')];
    const right = i < 2;
    if (right) expected += worth(q.diff);
    (right ? buttons.find(b => b.dataset.ans === q.a) : buttons.find(b => b.dataset.ans !== q.a)).click();
    await wait(); s.timeouts.advance(1200); await wait();
  }
  assert.equal(s.w.__result[1], expected);
  s.close();
});

test('finishing trivia saves the score once, marks the day done and updates the streak', async () => {
  const s = setup();
  s.w.eval(`globalThis.showDailyResult = (g, sc) => { window.__result = [g, sc]; };`);
  await playTrivia(s, ['right', 'right', 'right', 'right', 'right']);
  const score = s.w.__result[1];
  assert.ok(score > 0);
  assert.equal(get(s.w, 'isDailyCompleted')('trivia'), true);
  assert.equal(get(s.w, 'getDailyScore')('trivia'), score);
  assert.deepEqual(s.submits(), [{ name: 'Me', score, game: 'trivia', user_id: ME }]);
  assert.equal(s.w.__streakUpdates, 1);
  s.close();
});

test('a guest can play and submit, with no account attached to the score', async () => {
  const s = setup({ user: null });
  s.w.eval(`globalThis.showDailyResult = () => {}; playerName = 'Guesty'; currentUsername = '';`);
  await playTrivia(s, ['wrong', 'wrong', 'wrong', 'wrong', 'wrong']);
  const sub = s.submits()[0];
  assert.equal(sub.user_id, null); assert.equal(sub.name, 'Guesty'); assert.equal(sub.score, 0);
  s.close();
});

// ── Daily Scripture Scout ──────────────────────────────

async function playScout(s, answers) {     // answers: [testament, book, chapter] each 'right'|'wrong'
  await get(s.w, 'startDailyGame')('scout');
  const v = VERSES[0];
  const pick = async (right, matcher) => {
    const btns = [...s.root().querySelectorAll('#scoutPhaseArea .ref-option')];
    const btn = right ? btns.find(matcher) : btns.find(b => !matcher(b));
    btn.click(); await wait();
  };
  await pick(answers[0] === 'right', b => b.dataset.ans === v.testament);
  s.timeouts.advance(1200); await wait();
  await pick(answers[1] === 'right', b => b.dataset.ans === v.book);
  s.timeouts.advance(1200); await wait();
  const completedBeforeLast = get(s.w, 'isDailyCompleted')('scout');
  await pick(answers[2] === 'right', b => parseInt(b.dataset.ans) === v.chapter);
  await wait();
  return completedBeforeLast;
}

test('Scout awards 300 for the testament, 500 for the book and 700 for the chapter', async () => {
  const s = setup(); s.w.eval(`globalThis.showDailyResult = (g, sc) => { window.__result = [g, sc]; };`);
  await playScout(s, ['right', 'right', 'right']); s.timeouts.advance(1200);
  assert.equal(s.w.__result[1], 1500);
  s.close();
});

test('Scout adds up only the right answers', async () => {
  for (const [answers, total] of [[['right', 'wrong', 'right'], 1000], [['wrong', 'right', 'wrong'], 500], [['wrong', 'wrong', 'wrong'], 0]]) {
    const s = setup(); s.w.eval(`globalThis.showDailyResult = (g, sc) => { window.__result = [g, sc]; };`);
    await playScout(s, answers); s.timeouts.advance(1200);
    assert.equal(s.w.__result[1], total, answers.join());
    s.close();
  }
});

test('Scout is only counted as played after the last question, then saves once', async () => {
  const s = setup(); s.w.eval(`globalThis.showDailyResult = () => {};`);
  const doneEarly = await playScout(s, ['right', 'right', 'right']);
  assert.equal(doneEarly, false, 'not marked done after two of three questions');
  assert.equal(get(s.w, 'isDailyCompleted')('scout'), true);
  assert.deepEqual(s.submits().map(x => x.score), [1500]);
  assert.equal(s.w.__streakUpdates, 1);
  s.close();
});

// ── Daily Track It Down ────────────────────────────────

async function playTrack(s, right) {
  s.w.eval(`globalThis.generateRefOptions = async () => ['John 3', 'John 4', 'John 5', 'John 6'];`);
  await get(s.w, 'renderDailyTrack')(VERSES[0]);
  const btns = [...s.root().querySelectorAll('.ref-option')];
  (right ? btns.find(b => b.dataset.ref === 'John 3') : btns.find(b => b.dataset.ref !== 'John 3')).click();
  await wait();
}

test('Track gives 500 for the right reference and 0 for a wrong one, and saves it', async () => {
  for (const [right, score] of [[true, 500], [false, 0]]) {
    const s = setup(); s.w.eval(`globalThis.showDailyResult = () => {};`);
    await playTrack(s, right);
    assert.equal(get(s.w, 'getDailyScore')('track'), score);
    assert.equal(get(s.w, 'isDailyCompleted')('track'), true, 'even a 0 counts as played');
    assert.deepEqual(s.submits().map(x => x.score), [score]);
    s.close();
  }
});

test('Track marks the correct and the wrong answer and locks the buttons', async () => {
  const s = setup(); s.w.eval(`globalThis.showDailyResult = () => {};`);
  await playTrack(s, false);
  const btns = [...s.root().querySelectorAll('.ref-option')];
  assert.ok(btns.every(b => b.disabled));
  assert.ok(btns.find(b => b.dataset.ref === 'John 3').classList.contains('correct'));
  assert.equal(btns.filter(b => b.classList.contains('wrong')).length, 1);
  assert.match(s.root().querySelector('#dailyTrackFeedback').textContent, /Not quite/);
  s.close();
});

// ── Daily Missing in Action ────────────────────────────

async function playMia(s, rightCount) {
  const words = ['loved', 'world', 'gave', 'only'];
  s.w.eval(`globalThis.getBlankWords = (text) => ${JSON.stringify(words)}.map(w => ({ word: w, index: text.split(' ').indexOf(w), original: w }));
            globalThis.generateOptions = (word) => ['decoy' + word, 'fake' + word];
            globalThis.showDailyResult = (g, sc) => { window.__result = [g, sc]; };`);
  await get(s.w, 'renderDailyMIA')(VERSES[0]);
  const chips = [...s.root().querySelectorAll('#dailyMIAWordBank .word-chip')];
  for (let i = 0; i < words.length; i++) {
    const wantRight = i < rightCount;
    const chip = wantRight ? chips.find(c => c.dataset.word === words[i]) : chips.find(c => c.dataset.word.startsWith('decoy') && !c.classList.contains('used'));
    chip.click();
  }
  s.root().querySelector('#dailyMIACheckBtn').click();
  return s.root().querySelector('#dailyMIADoneBtn');
}

test('Missing in Action gives 200 for each blank filled correctly', async () => {
  for (const right of [4, 2, 0]) {
    const s = setup();
    const done = await playMia(s, right);
    done.click(); await wait();
    assert.equal(s.w.__result[1], right * 200, `${right} right`);
    assert.equal(get(s.w, 'getDailyScore')('mia'), right * 200);
    s.close();
  }
});

test('the Check button stays off until every blank has a word', async () => {
  const s = setup();
  s.w.eval(`globalThis.getBlankWords = (text) => ['loved','world','gave'].map(w => ({ word: w, index: text.split(' ').indexOf(w), original: w })); globalThis.generateOptions = () => ['x1'];`);
  await get(s.w, 'renderDailyMIA')(VERSES[0]);
  const btn = s.root().querySelector('#dailyMIACheckBtn');
  assert.equal(btn.disabled, true); assert.match(btn.textContent, /0\/3/);
  s.root().querySelector('.word-chip[data-word="loved"]').click();
  assert.match(btn.textContent, /1\/3/);
  s.close();
});

test('tapping "See Results" twice saves the score only once', async () => {
  // Regression: nothing locked the button, so a double tap posted the same score twice.
  const s = setup();
  const done = await playMia(s, 4);
  done.click(); done.click(); await wait(40);
  assert.equal(s.submits().length, 1);
  s.close();
});

// ── The results screen ─────────────────────────────────

const row = (name, score) => ({ name, score });

test('the results screen shows the score, your rank and the day\'s leaderboard', async () => {
  const s = setup({ board: [row('Ann', 1500), row('Me', 1200), row('Ben', 900)] });
  await get(s.w, 'showDailyResult')('trivia', 1200);
  const text = s.root().textContent;
  assert.match(text, /Daily Challenge Complete!/); assert.match(text, /1,200/); assert.match(text, /You ranked #2 today/);
  assert.deepEqual([...s.root().querySelectorAll('.daily-lb-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), ['🥇 Ann 1,500', '🥈 Me 1,200', '🥉 Ben 900']);
  s.close();
});

test('with an empty board it says you are the first', async () => {
  const s = setup({ board: [] });
  await get(s.w, 'showDailyResult')('track', 500);
  assert.match(s.root().textContent, /first to play today/);
  assert.doesNotMatch(s.root().textContent, /You ranked/);
  s.close();
});

test('names on the leaderboard cannot inject markup', async () => {
  const s = setup({ board: [row('<img src=x onerror="window.__pwned=1">', 900)] });
  await get(s.w, 'showDailyResult')('track', 500);
  assert.equal(s.root().querySelectorAll('img[src="x"]').length, 0);
  assert.equal(s.w.__pwned, undefined);
  s.close();
});

test('if the leaderboard cannot be loaded, the player still sees their score', async () => {
  // Regression: a failed leaderboard request left "Loading results…" on screen forever after the game.
  const s = setup(); s.w.__boardFails = true;
  await get(s.w, 'showDailyResult')('trivia', 1200);
  const text = s.root().textContent;
  assert.match(text, /Daily Challenge Complete!/); assert.match(text, /1,200/);
  assert.doesNotMatch(text, /Loading results/);
  s.close();
});

test('the buttons on the results screen lead back to the hub and home', async () => {
  const s = setup();
  await get(s.w, 'showDailyResult')('trivia', 100);
  const html = s.root().innerHTML;
  assert.match(html, /renderDailyChallenge\(\)/); assert.match(html, /showHome\(\)/);
  s.close();
});

test('opening a finished game from the hub shows that game\'s saved score', async () => {
  const s = setup({ board: [row('Me', 700)] });
  mark(s, 'mia', 700);
  await get(s.w, 'showDailyLeaderboard')('mia');
  assert.match(s.root().textContent, /700/); assert.match(s.root().textContent, /You ranked #1/);
  s.close();
});
