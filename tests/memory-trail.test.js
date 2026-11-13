// Memory Trail was removed from the app. These tests make sure nothing of it is left behind that could still be
// reached, mislabelled, or write scores to the wrong game, and that each daily game only ever touches its own score.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { ROOT, HTML, inlineScript, loadApp, get, fakeClock, fakeTimeouts, fakeIntervals } = require('./helpers');

const ME = 'me-1';
const NOON = new Date(2026, 10, 13, 12, 0, 0).getTime();
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));
const GAMES = ['scout', 'trivia', 'mia', 'track'];
const VERSES = [
  { id: 1, book: 'John', chapter: 3, verse: 16, testament: 'NT', text: 'For God so loved the world that he gave his one and only Son' },
  { id: 2, book: 'Psalms', chapter: 23, verse: 1, testament: 'OT', text: 'The LORD is my shepherd I shall not want anything' },
  { id: 3, book: 'Romans', chapter: 8, verse: 28, testament: 'NT', text: 'All things work together for good for those who love God' },
  { id: 4, book: 'Genesis', chapter: 1, verse: 1, testament: 'OT', text: 'In the beginning God created the heavens and the earth' },
];

function setup() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null }); return { ok: true, status: 200, json: async () => [], text: async () => '' }; };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  fakeClock(w, NOON); const timeouts = fakeTimeouts(w); fakeIntervals(w);
  w.eval(`
    currentUser = { id: '${ME}' }; authToken = 't'; currentUsername = 'Me'; playerName = 'Me';
    globalThis.sbFetch = async (p) => p.startsWith('verse_topics?') ? ${JSON.stringify(VERSES)}.map(v => ({ book: v.book, chapter: v.chapter, verse: v.verse }))
      : p.startsWith('verses?') ? ${JSON.stringify(VERSES)}.filter(v => { const m = p.match(/book=eq\\.([^&]+)&chapter=eq\\.(\\d+)/); return m && v.book === decodeURIComponent(m[1]) && v.chapter == m[2]; }) : [];
    globalThis.updateStreak = async () => {}; globalThis.playComplete = () => {}; globalThis.renderAuthScreen = () => {};
    globalThis.showDailyResult = () => {};
  `);
  const submits = () => calls.filter(c => c.method === 'POST' && c.url.includes('leaderboard_daily')).map(c => c.body);
  const done = () => GAMES.filter(g => get(w, 'isDailyCompleted')(g));
  return { ...app, w, calls, timeouts, submits, done, root: () => w.document.getElementById('root') };
}

// ── Nothing of Memory Trail is left in the Daily Challenge ──

test('the Daily Challenge offers exactly four games, and Memory Trail is not one of them', async () => {
  const s = setup();
  await get(s.w, 'renderDailyChallenge')();
  assert.deepEqual([...s.root().querySelectorAll('.daily-card')].map(c => c.id), GAMES.map(g => 'daily_' + g));
  assert.doesNotMatch(s.root().textContent, /Memory/i);
  s.close();
});

test('asking to start a game that does not exist (like the old Memory Trail) does nothing harmful', async () => {
  const s = setup();
  await get(s.w, 'startDailyGame')('memory');
  assert.match(s.root().textContent, /Could not load today's challenge/);
  assert.deepEqual(s.done(), []);
  assert.equal(s.submits().length, 0);
  s.close();
});

test('the old Memory Trail daily code is gone (it saved its score under Trivia)', () => {
  assert.equal(get(loadApp().window, 'typeof renderDailyMemory'), 'undefined');
  assert.equal(get(loadApp().window, 'typeof completeDailyMIA'), 'undefined');
  assert.doesNotMatch(HTML, /Daily Challenge — Memory Trail/);
});

test('the Challenge-a-friend list has no Memory Trail option', async () => {
  const s = setup(); s.w.eval(`globalThis.renderFriends = () => {};`);
  await get(s.w, 'challengeFriend')('fr-2', 'Fran');
  assert.doesNotMatch(s.root().textContent, /Memory Trail/);
  s.close();
});

// ── Each Challenge-a-friend option starts the game it names ──

test('the Challenge-a-friend options are labelled with the game they really start', async () => {
  // Regression: the Bible Trivia option was labelled "Memory Trail — Hard difficulty".
  const s = setup();
  await get(s.w, 'challengeFriend')('fr-2', 'Fran');
  const options = [...s.root().querySelectorAll('.chapter-item')].map(el => {
    const m = el.getAttribute('onclick').match(/startChallengeGame\('[^']*','[^']*','(\w+)','(\w+)'\)/);
    return { title: el.querySelector('.chapter-title').textContent.trim(), ref: el.querySelector('.chapter-ref').textContent.trim(), game: m[1], diff: m[2] };
  });
  assert.deepEqual(options.map(o => o.title), ['Scripture Scout', 'Missing in Action', 'Track It Down', 'Bible Trivia']);
  assert.deepEqual(options.map(o => o.game), ['scout', 'mia', 'track', 'trivia']);
  for (const o of options) assert.equal(o.ref, o.diff[0].toUpperCase() + o.diff.slice(1) + ' difficulty', `${o.title} says "${o.ref}" but starts ${o.diff}`);
  s.close();
});

test('choosing an option starts that game with the friend remembered for the challenge', async () => {
  for (const [game, launched] of [['scout', 'startChallengeScout'], ['mia', 'startChallengeMIA'], ['track', 'startChallengeTrack'], ['trivia', 'renderTriviaSetup']]) {
    const s = setup();
    s.w.eval(`globalThis.DIFF_COUNTS = { WEB: { easy: 5, hard: 5 }, KJV: { easy: 5, hard: 5 } };
      const real = globalThis.sbFetch; globalThis.sbFetch = async (p) => p.startsWith('verses?') && p.includes('difficulty=') ? [${JSON.stringify(VERSES[0])}] : real(p);
      globalThis.__launched = []; for (const n of ['startChallengeScout','startChallengeMIA','startChallengeTrack','renderTriviaSetup']) globalThis[n] = async () => { __launched.push(n); };`);
    await get(s.w, 'startChallengeGame')('fr-2', 'Fran', game, game === 'trivia' ? 'easy' : 'hard');
    assert.deepEqual(Array.from(s.w.__launched), [launched], game);
    const pending = s.w.eval('window._pendingChallenge');
    assert.equal(pending.friendId, 'fr-2'); assert.equal(pending.game, game);
    s.close();
  }
});

// ── Each daily game only ever writes its own score ─────

test('playing one daily game marks only that game as played and saves only its own score', async () => {
  // Guards against one game accidentally saving under another game's name (the old Memory code did).
  const s = setup();
  s.w.eval(`globalThis.generateRefOptions = async () => ['John 3', 'John 4', 'John 5', 'John 6'];
            globalThis.getBlankWords = (t) => ['loved','world','gave','only'].map(w => ({ word: w, index: t.split(' ').indexOf(w), original: w }));
            globalThis.generateOptions = () => ['decoy1', 'decoy2'];`);
  // Track
  await get(s.w, 'renderDailyTrack')(VERSES[0]);
  s.root().querySelector('.ref-option').click(); await wait();
  assert.deepEqual(s.done(), ['track']);
  assert.deepEqual(s.submits().map(x => x.game), ['track']);
  s.close();
});

test('the Missing in Action daily game saves under "mia", not under another game', async () => {
  const s = setup();
  s.w.eval(`globalThis.getBlankWords = (t) => ['loved','world','gave','only'].map(w => ({ word: w, index: t.split(' ').indexOf(w), original: w }));
            globalThis.generateOptions = () => ['decoy1', 'decoy2'];`);
  await get(s.w, 'renderDailyMIA')(VERSES[0]);
  for (const w of ['loved', 'world', 'gave', 'only']) s.root().querySelector(`.word-chip[data-word="${w}"]`).click();
  s.root().querySelector('#dailyMIACheckBtn').click();
  s.root().querySelector('#dailyMIADoneBtn').click(); await wait();
  assert.deepEqual(s.done(), ['mia']);
  assert.deepEqual(s.submits().map(x => [x.game, x.score]), [['mia', 800]]);
  s.close();
});

test('the Scout daily game saves under "scout" only', async () => {
  const s = setup();
  await get(s.w, 'startDailyGame')('scout');
  const v = VERSES[0];
  for (const match of [b => b.dataset.ans === v.testament, b => b.dataset.ans === v.book, b => parseInt(b.dataset.ans) === v.chapter]) {
    [...s.root().querySelectorAll('#scoutPhaseArea .ref-option')].find(match).click(); await wait(); s.timeouts.advance(1200); await wait();
  }
  assert.deepEqual(s.done(), ['scout']);
  assert.deepEqual(s.submits().map(x => x.game), ['scout']);
  s.close();
});

test('the Trivia daily game saves under "trivia" only', async () => {
  const s = setup();
  await get(s.w, 'startDailyGame')('trivia');
  const bank = Array.from(get(s.w, 'DAILY_TRIVIA_BANK'));
  for (let i = 0; i < 5; i++) {
    const text = [...s.root().querySelectorAll('div')].find(d => d.style.lineHeight === '1.5' && bank.some(b => b.q === d.textContent.trim())).textContent.trim();
    const q = bank.find(b => b.q === text);
    [...s.root().querySelectorAll('.ref-option')].find(b => b.dataset.ans === q.a).click(); await wait(); s.timeouts.advance(1200); await wait();
  }
  assert.deepEqual(s.done(), ['trivia']);
  assert.deepEqual(s.submits().map(x => x.game), ['trivia']);
  s.close();
});

test('every place the app records a daily score uses one of the four real games', () => {
  const ast = acorn.parse(inlineScript(), { ecmaVersion: 'latest' });
  const found = [];
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && ['markDailyCompleted', 'submitDailyScore', 'isDailyCompleted', 'getDailyScore'].includes(n.callee.name) && n.arguments[0] && n.arguments[0].type === 'Literal')
      found.push(n.arguments[0].value);
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
  })(ast);
  assert.ok(found.length >= 8);
  assert.deepEqual([...new Set(found)].filter(g => !GAMES.includes(g)), []);
});

// ── No new dead code ───────────────────────────────────

test('functions nobody calls are not piling up in the app', () => {
  // Left over from features that were removed. Delete an entry here when you delete the function; if this test
  // fails because of a NEW name, either use it or remove it.
  const KNOWN_UNUSED = new Set(['calculateStreak', 'showLeaderboard', 'showFullStats', 'shareApp', 'checkStoryBlank', 'checkStoryAnswer',
    'checkHeartsBeforeRound', 'startChallengeMemory', 'toggleTTS', 'speakText', 'playFlip', 'useSabbathRest']);
  const ast = acorn.parse(inlineScript(), { ecmaVersion: 'latest' });
  const names = ast.body.filter(n => n.type === 'FunctionDeclaration').map(n => n.id.name);
  const unused = names.filter(nm => (HTML.match(new RegExp('(?<![\\w$.])' + nm.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length <= 1);
  const unexpected = unused.filter(n => !KNOWN_UNUSED.has(n));
  const stale = [...KNOWN_UNUSED].filter(n => !unused.includes(n));
  assert.deepEqual(unexpected, [], 'new unused functions');
  assert.deepEqual(stale, [], 'listed above but now used or deleted: remove from KNOWN_UNUSED');
});
