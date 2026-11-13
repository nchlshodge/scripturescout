// Challenges: sending a duel, answering it (with the speed bonus), the result screens, the banner and the list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get, fakeClock, fakeIntervals, fakeTimeouts } = require('./helpers');

const ME = 'me-1', FRIEND = 'fr-2';
const T0 = new Date(2026, 10, 13, 12, 0, 0).getTime();
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

function setup({ status = {}, patchRows = null, postRows = [{ id: 'ch-1' }], lists = {}, user = ME } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const key = Object.keys(status).find(k => u.includes(k));
    const code = key ? status[key] : 200;
    let json = [];
    if (opts.method === 'POST' && u.includes('/rest/v1/challenges')) json = postRows;
    if (opts.method === 'PATCH' && u.includes('/rest/v1/challenges')) json = patchRows === null ? [{ challenger_id: FRIEND, challenger_score: 1000, game: 'trivia' }] : patchRows;
    return { ok: code >= 200 && code < 300, status: code, json: async () => json, text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  const clock = fakeClock(w, T0);
  const timeouts = fakeTimeouts(w);
  fakeIntervals(w);
  w.__lists = lists;
  w.eval(`
    ${user ? `currentUser = { id: '${user}' }; authToken = 't';` : 'currentUser = null; authToken = null;'}
    currentUsername = 'Me'; playerName = 'Me';
    globalThis.sbFetch = async (p) => {
      const L = window.__lists;
      if (p.startsWith('challenges?challenger_id=eq.')) return L.sent || [];
      if (p.startsWith('challenges?opponent_id=eq.') && p.includes('limit=1')) return L.pending || [];
      if (p.startsWith('challenges?opponent_id=eq.')) return L.received || [];
      if (p.startsWith('verses?')) { (window.__verseQueries = window.__verseQueries || []).push(p); if (window.__verseFails) throw new Error('offline'); return L.verses || []; }
      return [];
    };
    globalThis.__started = [];
    globalThis.startChallengeScout = async (...a) => { __started.push(['scout', ...a]); };
    globalThis.startChallengeMIA = async (...a) => { __started.push(['mia', ...a]); };
    globalThis.startChallengeTrack = async (...a) => { __started.push(['track', ...a]); };
    globalThis.renderTriviaSetup = () => { __started.push(['trivia']); };
  `);
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute('role') === 'status').map(c => c.textContent);
  const writes = () => calls.filter(c => c.method !== 'GET');
  const notes = () => writes().filter(c => c.url.endsWith('/rest/v1/notifications')).map(c => c.body);
  return { ...app, w, calls, clock, timeouts, toasts, writes, notes, root: () => w.document.getElementById('root') };
}

const verse = { id: 5, book: 'John', chapter: 3, verse: 16 };

// ── Sending ────────────────────────────────────────────

test('a signed-out player is asked to sign in and nothing is sent', async () => {
  const s = setup({ user: null });
  await get(s.w, 'sendChallenge')(FRIEND, 'Fran', 'trivia', 'easy', 900, null);
  assert.ok(s.toasts().some(t => /Sign in/.test(t)));
  assert.equal(s.calls.length, 0);
  s.close();
});

test('sending a challenge saves who, what game, the score to beat and the verse', async () => {
  const s = setup();
  await get(s.w, 'sendChallenge')(FRIEND, 'Fran', 'scout', 'hard', 1500, verse);
  const post = s.writes().find(c => c.url.endsWith('/rest/v1/challenges'));
  assert.deepEqual(post.body, { challenger_id: ME, opponent_id: FRIEND, game: 'scout', difficulty: 'hard', challenger_score: 1500, challenger_name: 'Me', verse_id: 5, verse_book: 'John', verse_chapter: 3, verse_verse: 16 });
  s.close();
});

test('a challenge without a specific verse leaves the verse fields empty', async () => {
  const s = setup();
  await get(s.w, 'sendChallenge')(FRIEND, 'Fran', 'trivia', 'easy', 800, null);
  const body = s.writes().find(c => c.url.endsWith('/rest/v1/challenges')).body;
  assert.equal(body.verse_id, null); assert.equal(body.verse_book, null);
  s.close();
});

test("with no username set, the player's display name is used", async () => {
  const s = setup(); s.w.eval("currentUsername = ''; playerName = 'Pat';");
  await get(s.w, 'sendChallenge')(FRIEND, 'Fran', 'trivia', 'easy', 800, null);
  assert.equal(s.writes().find(c => c.url.endsWith('/rest/v1/challenges')).body.challenger_name, 'Pat');
  s.close();
});

test('the friend is notified with the game, score and a way to find the challenge', async () => {
  const s = setup({ postRows: [{ id: 'ch-77' }] });
  await get(s.w, 'sendChallenge')(FRIEND, 'Fran', 'mia', 'medium', 2400, null);
  const n = s.notes()[0];
  assert.equal(n.user_id, FRIEND); assert.equal(n.type, 'challenge');
  assert.match(n.message, /Me challenged you to beat 2,400 pts on Missing in Action medium/);
  assert.equal(n.data.challenge_id, 'ch-77'); assert.equal(n.data.from_id, ME);
  assert.ok(s.toasts().some(t => /Challenge sent to Fran/.test(t)));
  s.close();
});

test('if the server refuses the challenge, nobody is told it was sent', async () => {
  // Regression: the "Challenge sent!" message and the notification went out even when saving failed.
  const s = setup({ status: { '/rest/v1/challenges': 403 } });
  await get(s.w, 'sendChallenge')(FRIEND, 'Fran', 'trivia', 'easy', 800, null);
  assert.equal(s.notes().length, 0);
  assert.ok(!s.toasts().some(t => /Challenge sent/.test(t)));
  assert.ok(s.toasts().some(t => /Could not send challenge/.test(t)));
  s.close();
});

// ── Answering: speed bonus and saving ──────────────────

function activate(s, id = 'ch-1', startedOffsetSec = 0) {
  s.w.eval(`window._activeChallenge = { id: '${id}', game: 'trivia', difficulty: 'easy', challengerScore: 1000, startedAt: new Date(${s.clock.now + startedOffsetSec * 1000}) };`);
}
async function answer(s, score, id = 'ch-1') {
  await get(s.w, 'respondToChallenge')(id, score, null);
  return s.writes().find(c => c.method === 'PATCH' && c.body && c.body.status === 'completed');
}

test('the speed bonus starts at 500 and shrinks evenly to 0 over five minutes', async () => {
  for (const [sec, bonus] of [[0, 500], [30, 450], [60, 400], [150, 250], [299, 1], [300, 0], [900, 0]]) {
    const s = setup(); activate(s); s.clock.advance(sec * 1000);
    const patch = await answer(s, 100);
    assert.equal(patch.body.time_bonus, bonus, `${sec}s`);
    assert.equal(patch.body.opponent_score, 100 + bonus, `${sec}s total`);
    s.close();
  }
});

test('the speed bonus can never be more than 500 (even if the clock was changed)', async () => {
  const s = setup(); activate(s, 'ch-1', 3600);       // "started" an hour in the future
  const patch = await answer(s, 100);
  assert.equal(patch.body.time_bonus, 500);
  s.close();
});

test('a leftover challenge from earlier does not give a speed bonus to a different one', async () => {
  const s = setup(); activate(s, 'old-challenge');
  const patch = await answer(s, 100, 'ch-1');
  assert.equal(patch.body.time_bonus, 0);
  s.close();
});

test('answering saves the score, name, finished status and bonus on that challenge', async () => {
  const s = setup(); activate(s); s.clock.advance(60 * 1000);
  const patch = await answer(s, 700);
  assert.ok(patch.url.includes('/rest/v1/challenges?id=eq.ch-1'));
  assert.deepEqual(patch.body, { opponent_score: 1100, opponent_name: 'Me', status: 'completed', time_bonus: 400 });
  s.close();
});

test('only a challenge that is still waiting and not expired can be answered', async () => {
  // Regression: nothing stopped a challenge being answered twice or after it expired.
  const s = setup(); activate(s);
  const patch = await answer(s, 700);
  assert.ok(patch.url.includes('status=eq.pending'));
  assert.ok(/expires_at=gt\.\d{4}-\d\d-\d\dT/.test(patch.url));
  s.close();
});

test('an already-answered or expired challenge is refused with a message and no notification', async () => {
  const s = setup({ patchRows: [] }); activate(s);
  const result = await get(s.w, 'respondToChallenge')('ch-1', 700, null);
  assert.equal(result, undefined);
  assert.ok(s.toasts().some(t => /already answered or has expired/.test(t)));
  assert.equal(s.notes().length, 0);
  s.close();
});

test('a server error is reported and does not notify the challenger', async () => {
  const s = setup({ status: { '/rest/v1/challenges': 500 } }); activate(s);
  await assert.doesNotReject(get(s.w, 'respondToChallenge')('ch-1', 700, null));
  assert.ok(s.toasts().some(t => /Could not save your challenge result/.test(t)));
  assert.equal(s.notes().length, 0);
  s.close();
});

test('the challenger is told how it went, and the winner is decided on score plus speed bonus', async () => {
  // Regression: the notification compared the score WITHOUT the bonus, so the two players saw different results.
  const s = setup({ patchRows: [{ challenger_id: FRIEND, challenger_score: 1000, game: 'trivia' }] }); activate(s);
  s.clock.advance(30 * 1000);                                   // 450 bonus
  await answer(s, 700);                                          // 700 + 450 = 1150 beats 1000
  const n = s.notes()[0];
  assert.equal(n.user_id, FRIEND); assert.equal(n.type, 'challenge_result');
  assert.match(n.message, /Me beat your challenge on trivia! They scored 1,150 vs your 1,000/);
  assert.equal(n.data.score, 1150);
  s.close();
});

test('a tie and a loss are worded correctly', async () => {
  let s = setup({ patchRows: [{ challenger_id: FRIEND, challenger_score: 800, game: 'mia' }] }); activate(s); s.clock.advance(300 * 1000);
  await answer(s, 800);
  assert.match(s.notes()[0].message, /tied your challenge on mia! You both scored 800/);
  s.close();
  s = setup({ patchRows: [{ challenger_id: FRIEND, challenger_score: 900, game: 'mia' }] }); activate(s); s.clock.advance(300 * 1000);
  await answer(s, 500);
  assert.match(s.notes()[0].message, /couldn't beat your score of 900/);
  s.close();
});

// ── The result screen ──────────────────────────────────

async function finish(s, score, challengerScore = 1000) {
  s.w.eval(`window._activeChallenge = { id: 'ch-1', game: 'trivia', difficulty: 'easy', challengerScore: ${challengerScore}, startedAt: new Date(${s.clock.now}) };`);
  await get(s.w, 'finishChallenge')(score, null);
  return s.root().textContent;
}

test('winning shows "You won!" with the combined score, the speed bonus and their score', async () => {
  const s = setup({ patchRows: [{ challenger_id: FRIEND, challenger_score: 1000, game: 'trivia', time_bonus: 500 }] });
  const text = await finish(s, 700);
  assert.match(text, /You won!/); assert.match(text, /Speed bonus: \+500 pts/);
  assert.match(text, /1,200/); assert.match(text, /\(inc\. speed bonus\)/); assert.match(text, /1,000/);
  s.close();
});

test('a tie shows "Tied!" and a narrow miss shows "So close!"', async () => {
  let s = setup({ patchRows: [{ challenger_id: FRIEND, challenger_score: 1000, game: 'trivia', time_bonus: 0 }] });
  assert.match(await finish(s, 1000), /Tied!/); s.close();
  s = setup({ patchRows: [{ challenger_id: FRIEND, challenger_score: 1000, game: 'trivia', time_bonus: 0 }] });
  assert.match(await finish(s, 400), /So close!/); s.close();
});

test("if the result couldn't be saved the screen says so instead of claiming a loss", async () => {
  const s = setup({ patchRows: [] });
  const text = await finish(s, 400);
  assert.match(text, /Result not saved/);
  assert.doesNotMatch(text, /So close!/);
  s.close();
});

test('finishing clears the saved challenge, and does nothing if there was none', async () => {
  const s = setup();
  await finish(s, 400);
  assert.equal(s.w.eval('window._activeChallenge'), null);
  const before = s.calls.length;
  await get(s.w, 'finishChallenge')(500, null);
  assert.equal(s.calls.length, before);
  s.close();
});

// ── Accepting ──────────────────────────────────────────

test('accepting records when the player started, loads the challenger\'s verse, and starts the right game', async () => {
  const s = setup({ lists: { verses: [verse] } });
  await get(s.w, 'acceptChallenge')('ch-1', 'scout', 'hard', 1500, 'John', 3, 16);
  const patch = s.writes().find(c => c.method === 'PATCH');
  assert.ok(patch.url.includes('challenges?id=eq.ch-1')); assert.ok(patch.body.opponent_started_at);
  assert.ok(s.w.__verseQueries[0].includes('book=eq.John') && s.w.__verseQueries[0].includes('chapter=eq.3') && s.w.__verseQueries[0].includes('verse=eq.16'));
  const ac = s.w.eval('window._activeChallenge');
  assert.equal(ac.id, 'ch-1'); assert.equal(ac.challengerScore, 1500); assert.equal(ac.game, 'scout');
  assert.equal(ac.startedAt.getTime(), s.clock.now);
  assert.equal(s.w.__started[0][0], 'scout');
  assert.match(s.root().textContent, /Beat 1,500 pts to win/);
  s.close();
});

test('each game type launches its own game', async () => {
  for (const [game, expected] of [['scout', 'scout'], ['mia', 'mia'], ['track', 'track'], ['trivia', 'trivia']]) {
    const s = setup();
    await get(s.w, 'acceptChallenge')('ch-1', game, 'easy', 500, '', 0, 0);
    assert.equal(s.w.__started[0][0], expected, game);
    s.close();
  }
});

test('a challenge with no set verse does not look one up', async () => {
  const s = setup();
  await get(s.w, 'acceptChallenge')('ch-1', 'scout', 'easy', 500, '', 0, 0);
  assert.equal(s.w.__verseQueries, undefined);
  assert.equal(s.w.__started[0][1], null);
  s.close();
});

// ── Finding out about a challenge ──────────────────────

const pendingRow = (extra = {}) => ({ id: 'ch-9', challenger_id: FRIEND, opponent_id: ME, game: 'trivia', difficulty: 'medium', status: 'pending', challenger_score: 1200, challenger_name: 'Fran', created_at: new Date(T0).toISOString(), expires_at: new Date(T0 + 20 * 3600 * 1000).toISOString(), ...extra });

test('a pending challenge pops up as a banner shortly after opening the app, once per challenge', async () => {
  const s = setup({ lists: { pending: [pendingRow()] } });
  await get(s.w, 'checkForPendingChallenges')();
  assert.equal(s.w.document.getElementById('challengeBannerOverlay'), null, 'not immediately');
  s.timeouts.advance(2500);
  assert.ok(s.w.document.getElementById('challengeBannerOverlay'));
  s.w.document.getElementById('challengeBannerOverlay').remove();
  await get(s.w, 'checkForPendingChallenges')(); s.timeouts.advance(5000);
  assert.equal(s.w.document.getElementById('challengeBannerOverlay'), null, 'not shown again this session');
  s.close();
});

test('no banner for a signed-out player or when nothing is pending', async () => {
  let s = setup({ user: null, lists: { pending: [pendingRow()] } });
  await get(s.w, 'checkForPendingChallenges')(); s.timeouts.advance(5000);
  assert.equal(s.w.document.getElementById('challengeBannerOverlay'), null); assert.equal(s.calls.length, 0); s.close();
  s = setup({ lists: { pending: [] } });
  await get(s.w, 'checkForPendingChallenges')(); s.timeouts.advance(5000);
  assert.equal(s.w.document.getElementById('challengeBannerOverlay'), null); s.close();
});

test('the banner shows who challenged, the game, the score to beat and the time left', () => {
  const s = setup();
  get(s.w, 'showChallengeBanner')(pendingRow());
  const text = s.w.document.getElementById('challengeBannerOverlay').textContent;
  assert.match(text, /Fran wants to battle/); assert.match(text, /Bible Trivia/); assert.match(text, /medium/);
  assert.match(text, /1,200/); assert.match(text, /20 hours left to respond/);
  s.close();
});

test('"Maybe later" closes the banner without accepting', () => {
  const s = setup();
  get(s.w, 'showChallengeBanner')(pendingRow());
  [...s.w.document.querySelectorAll('#challengeBannerOverlay button')].find(b => /Maybe later/.test(b.textContent)).click();
  assert.equal(s.w.document.getElementById('challengeBannerOverlay'), null);
  assert.equal(s.w.__started.length, 0);
  s.close();
});

test("a challenge's fields can't inject markup or run code when shown in the banner", async () => {
  const evil = `x');window.__pwned=1;('<img src=x onerror="window.__pwned=2">`;
  const s = setup();
  s.w.eval(`globalThis.acceptChallenge = (...a) => { window.__args = a; };`);
  get(s.w, 'showChallengeBanner')(pendingRow({ id: evil, challenger_name: evil, game: evil, difficulty: evil, verse_book: evil, verse_chapter: evil, verse_verse: evil }));
  const overlay = s.w.document.getElementById('challengeBannerOverlay');
  assert.equal(overlay.querySelectorAll('img[src="x"]').length, 0);
  [...overlay.querySelectorAll('button')].find(b => /Accept/.test(b.textContent)).click();
  await wait();
  assert.equal(s.w.__pwned, undefined, 'no injected code ran');
  assert.equal(s.w.__args[1], 'scout', 'unknown game falls back safely');
  assert.equal(s.w.__args[2], 'hard', 'unknown difficulty falls back safely');
  assert.equal(s.w.__args[0], evil, 'the id arrives intact, as plain text');
  s.close();
});

// ── The Challenges list ────────────────────────────────

const received = (extra = {}) => pendingRow({ opponent_score: null, ...extra });
const sentRow = (extra = {}) => pendingRow({ id: 'ch-s', challenger_id: ME, opponent_id: FRIEND, challenger_name: 'Me', opponent_name: 'Fran', opponent_score: null, ...extra });
const cards = s => [...s.root().querySelectorAll('.challenge-card')];

test('with no challenges the list says so', async () => {
  const s = setup();
  await get(s.w, 'renderChallenges')();
  assert.match(s.root().textContent, /No challenges yet/);
  s.close();
});

test('a challenge waiting for you has an Accept button wired to that challenge', async () => {
  const s = setup({ lists: { received: [received({ verse_book: 'John', verse_chapter: 3, verse_verse: 16 })] } });
  s.w.eval(`globalThis.acceptChallenge = (...a) => { window.__args = a; };`);
  await get(s.w, 'renderChallenges')();
  assert.match(s.root().textContent, /Your turn to play/);
  s.root().querySelector('.btn-next').click();
  assert.equal(JSON.stringify(s.w.__args), JSON.stringify(['ch-9', 'trivia', 'medium', 1200, 'John', 3, 16]));
  s.close();
});

test('a challenge you sent that is still waiting says so and has no Accept button', async () => {
  const s = setup({ lists: { sent: [sentRow()] } });
  await get(s.w, 'renderChallenges')();
  assert.match(s.root().textContent, /Waiting for a response/);
  assert.equal(s.root().querySelector('.btn-next'), null);
  s.close();
});

test('results are shown from your side, whether you sent or received the challenge', async () => {
  const s = setup({ lists: {
    received: [received({ id: 'r1', status: 'completed', challenger_score: 1000, opponent_score: 1200 }),      // I answered and won
               received({ id: 'r2', status: 'completed', challenger_score: 1000, opponent_score: 800 })],       // I answered and lost
    sent: [sentRow({ id: 's1', status: 'completed', challenger_score: 900, opponent_score: 700 }),               // I sent and won
           sentRow({ id: 's2', status: 'completed', challenger_score: 900, opponent_score: 900 })] } });         // tie
  await get(s.w, 'renderChallenges')();
  const verdict = id => [...s.root().querySelectorAll('.challenge-card')].map(c => c.querySelector('.challenge-result').textContent.trim());
  assert.deepEqual(verdict().sort(), ['Tied', 'You lost', 'You won', 'You won']);
  s.close();
});

test('an unanswered challenge past its deadline shows as expired and cannot be accepted', async () => {
  const s = setup({ lists: { received: [received({ expires_at: new Date(T0 - 1000).toISOString() })] } });
  await get(s.w, 'renderChallenges')();
  assert.match(s.root().textContent, /Expired — no response/);
  assert.equal(s.root().querySelector('.btn-next'), null);
  s.close();
});

test('newest challenges come first', async () => {
  const s = setup({ lists: { received: [received({ id: 'old', created_at: new Date(T0 - 86400000).toISOString(), challenger_name: 'Older' })], sent: [sentRow({ id: 'new', created_at: new Date(T0).toISOString(), opponent_name: 'Newer' })] } });
  await get(s.w, 'renderChallenges')();
  assert.match(cards(s)[0].textContent, /Newer/); assert.match(cards(s)[1].textContent, /Older/);
  s.close();
});

test('a challenge with a missing name does not break the whole list', async () => {
  // Regression: a challenge from someone with no saved name made the screen crash and show nothing.
  const s = setup({ lists: { received: [received({ challenger_name: null }), received({ id: 'x2', challenger_name: 'Fine' })], sent: [sentRow({ opponent_name: null })] } });
  await assert.doesNotReject(get(s.w, 'renderChallenges')());
  assert.equal(cards(s).length, 3);
  assert.match(s.root().textContent, /Someone/); assert.match(s.root().textContent, /Waiting\.\.\./);
  s.close();
});

test('scores are shown with separators, and a dash when the other side has not played yet', async () => {
  const s = setup({ lists: { received: [received({ challenger_score: 12345 })] } });
  await get(s.w, 'renderChallenges')();
  assert.match(s.root().textContent, /12,345/); assert.match(s.root().textContent, /—/);
  s.close();
});

test("a challenge's text fields can't inject markup or run code in the list", async () => {
  const evil = `x');window.__pwned=1;('<img src=x onerror="window.__pwned=2">`;
  const s = setup({ lists: { received: [received({ id: evil, challenger_name: evil, game: evil, difficulty: evil, verse_book: evil, verse_chapter: evil, verse_verse: evil })] } });
  s.w.eval(`globalThis.acceptChallenge = (...a) => { window.__args = a; };`);
  await get(s.w, 'renderChallenges')();
  assert.equal(s.root().querySelectorAll('img[src="x"]').length, 0);
  const btn = s.root().querySelector('.btn-next');
  if (btn) btn.click();
  await wait();
  assert.equal(s.w.__pwned, undefined);
  s.close();
});

test('the accept-call builder only passes known games and difficulties and plain numbers', () => {
  const s = setup(); const args = get(s.w, 'challengeAcceptArgs');
  assert.equal(args({ id: 7, game: 'mia', difficulty: 'easy', challenger_score: 50, verse_book: 'Ruth', verse_chapter: 1, verse_verse: 2 }), "'7','mia','easy',50,'Ruth',1,2");
  assert.equal(args({ id: 7, game: 'nope', difficulty: 'nope', challenger_score: 'abc', verse_book: null, verse_chapter: null, verse_verse: 'x' }), "'7','scout','hard',0,'',0,0");
  s.close();
});
