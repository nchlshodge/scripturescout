// Offline play: the saved copy of questions/stories, reading from it with no connection,
// and the queue that holds progress and scores until the connection is back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const U = 'u-1';

const PATHS = [
  { id: 2, slug: 'moses', title: 'Moses', description: 'd', icon: 'X', is_free: true, order_num: 2, testament: 'OT' },
  { id: 1, slug: 'abraham', title: 'Abraham', description: 'd', icon: 'X', is_free: true, order_num: 1, testament: 'OT' },
];
const chapter = (path_id, n) => ({ id: path_id * 100 + n, path_id, chapter_num: n, title: `Chapter ${n}`, narrative: 'n', book: 'Genesis', chapter: n, verse: 1, created_at: 'x' });
const CHAPTERS = [...[1, 2, 3].map(n => chapter(1, n)), ...[1, 2].map(n => chapter(2, n))];
const question = (id, difficulty, extra = {}) => ({ id, question: `Q${id}?`, answer: 'A', choices: ['A', 'B', 'C', 'D'], difficulty, reference: 'Gen 1:1', category: 'x', created_at: 'x', topic: null, story_path_slug: null, ...extra });
const TRIVIA = [
  ...Array.from({ length: 12 }, (_, i) => question(i + 1, 'easy')),
  ...Array.from({ length: 6 }, (_, i) => question(100 + i, 'hard')),
  question(200, 'easy', { story_path_slug: 'abraham' }), question(201, 'easy', { story_path_slug: 'abraham' }),
  question(300, 'medium', { topic: 'love' }),
];

// An app wired to a fake Supabase whose connection can be switched off.
function setup({ user = U, paths = PATHS, chapters = CHAPTERS, trivia = TRIVIA, progress = [], up = true } = {}) {
  const net = { up, calls: [], progress, failRpc: false, failScores: false, scoreRows: [] };
  const fetchImpl = async (url, opts = {}) => {
    url = String(url);
    const call = { url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null };
    net.calls.push(call);
    if (!net.up) throw new TypeError('Failed to fetch');
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    const bad = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
    const u = new URL(url); const q = u.searchParams; const t = u.pathname.split('/').pop();
    const page = rows => { const off = +(q.get('offset') || 0), lim = +(q.get('limit') || 1000); return rows.slice(off, off + lim); };
    if (u.pathname.includes('/rpc/')) { if (net.failRpc) return bad(); net.progress.push(JSON.parse(opts.body)); return ok([]); }
    if (opts.method === 'POST' || opts.method === 'PATCH') { if (net.failScores) return bad(); net.scoreRows.push(call); return ok([]); }
    if (t === 'story_paths') return ok(q.get('id') ? paths.filter(p => 'eq.' + p.id === q.get('id')) : page(paths));
    if (t === 'story_chapters') {
      let rows = chapters; const pid = (q.get('path_id') || '').replace('eq.', '');
      if (pid) rows = rows.filter(c => String(c.path_id) === pid);
      if (q.get('order') === 'chapter_num.desc') rows = [...rows].sort((a, b) => b.chapter_num - a.chapter_num);
      else if (q.get('order') === 'chapter_num') rows = [...rows].sort((a, b) => a.chapter_num - b.chapter_num);
      return ok(page(rows));
    }
    if (t === 'bible_trivia_questions') {
      let rows = trivia; const d = (q.get('difficulty') || '').replace('eq.', ''); if (d) rows = rows.filter(r => r.difficulty === d);
      return ok(page(rows));
    }
    if (t === 'verses') return ok(chapters.map(c => ({ book: c.book, chapter: c.chapter, verse: c.verse, text: `Verse ${c.chapter} text` })).filter((v, i) => i < 100));
    if (t === 'story_progress') return ok(net.progress.filter(p => p.path_id !== undefined));
    return ok([]);
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  w.eval(`globalThis.renderAuthScreen = () => {}; globalThis.updateStreak = async () => {};`);
  Object.defineProperty(w.navigator, 'onLine', { get: () => net.up, configurable: true });
  if (user) w.eval(`currentUser = { id: '${user}' }; authToken = 'tok';`);
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute && c.getAttribute('role') === 'status').map(c => c.textContent);
  const call = (name, ...args) => get(w, name)(...args);
  const store = k => JSON.parse(w.localStorage.getItem(k) || 'null');
  return { ...app, w, net, toasts, call, store, ev: c => w.eval(c) };
}
const rpc = net => net.calls.filter(c => c.url.includes('/rpc/upsert_story_progress'));

// ── Saving the pack ──────────────────────────────────────

test('while online, the app saves the stories, questions and chapter verses on the device', async () => {
  const s = setup();
  assert.equal(await s.call('refreshOfflinePack'), true);
  assert.equal(s.store('ss_pack_paths').length, 2);
  assert.equal(s.store('ss_pack_chapters').length, 5);
  assert.equal(s.store('ss_pack_trivia').length, TRIVIA.length);
  assert.ok(s.store('ss_pack_chapters').every(c => !('created_at' in c)), 'trims fields it does not need');
  assert.equal(Object.keys(s.store('ss_pack_verses')).length > 0, true);
  assert.ok(s.store('ss_pack_meta').at > 0);
  s.close();
});

test('it reads every page when there are more than 1000 questions', async () => {
  const many = Array.from({ length: 2300 }, (_, i) => question(i + 1, 'easy'));
  const s = setup({ trivia: many });
  await s.call('refreshOfflinePack');
  assert.equal(s.store('ss_pack_trivia').length, 2300);
  s.close();
});

test('a fresh pack is not downloaded again, a day-old one is, and a new translation refreshes the verses only', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  const first = s.net.calls.length;
  assert.equal(await s.call('refreshOfflinePack'), false);
  assert.equal(s.net.calls.length, first);

  s.ev(`TRANSLATION = 'KJV'`);
  s.net.calls.length = 0;
  await s.call('refreshOfflinePack');
  assert.ok(s.net.calls.every(c => c.url.includes('/verses')), 'only verses were requested');

  const meta = s.store('ss_pack_meta'); meta.at -= 25 * 3600 * 1000;
  s.w.localStorage.setItem('ss_pack_meta', JSON.stringify(meta));
  s.net.calls.length = 0;
  assert.equal(await s.call('refreshOfflinePack'), true);
  assert.ok(s.net.calls.some(c => c.url.includes('bible_trivia_questions')));
  s.close();
});

test('nothing is downloaded with no connection, and a failed download keeps the old copy', async () => {
  const s = setup({ up: false });
  assert.equal(await s.call('refreshOfflinePack'), false);
  assert.equal(s.net.calls.length, 0);

  s.net.up = true;
  await s.call('refreshOfflinePack');
  const before = s.w.localStorage.getItem('ss_pack_trivia');
  s.w.localStorage.setItem('ss_pack_meta', JSON.stringify({ at: 1, translation: 'WEB' }));
  s.net.up = false; s.ev('navigator.onLine'); // offline again
  s.net.up = true;
  s.ev(`globalThis.sbFetch = async () => { throw new Error('boom'); }`);
  assert.equal(await s.call('refreshOfflinePack'), false);
  assert.equal(s.w.localStorage.getItem('ss_pack_trivia'), before);
  s.close();
});

test('a full or blocked device storage never breaks anything', async () => {
  const s = setup();
  s.w.Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
  await assert.doesNotReject(s.call('refreshOfflinePack'));
  assert.equal(s.call('packSet', 'trivia', [1]), false);
  s.close();
});

// ── Reading with no connection ───────────────────────────

test('with no connection the story list and a story path come from the saved copy', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('renderStoryMode');
  const list = s.w.document.getElementById('root').textContent;
  assert.match(list, /Abraham/); assert.match(list, /Moses/);
  assert.ok(list.indexOf('Abraham') < list.indexOf('Moses'), 'in story order');
  await s.call('renderStoryPath', 1);
  const path = s.w.document.getElementById('root').textContent;
  assert.match(path, /Chapter 1/); assert.match(path, /Chapter 3/);
  s.close();
});

test('with no connection and nothing saved yet, Story Mode says it could not load instead of hanging', async () => {
  const s = setup({ up: false });
  await s.call('renderStoryMode');
  const root = s.w.document.getElementById('root');
  assert.match(root.textContent, /Could not load stories/);
  assert.ok(!root.querySelector('.spinner'));
  s.close();
});

test('a chapter opens offline with its verse from the saved copy', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  const ch = s.store('ss_pack_chapters').find(c => c.path_id === 1 && c.chapter_num === 2);
  await s.call('renderStoryChapter', ch, 1, 1);
  assert.equal(s.ev('storyInteractive.verseText'), 'Verse 2 text');
  s.close();
});

test('a verse seen while online is remembered for later', async () => {
  const s = setup();
  await s.call('renderStoryChapter', CHAPTERS[0], 1, 0);
  s.net.up = false;
  s.ev('globalThis.__x = 0');
  assert.equal(s.call('getSavedVerse', CHAPTERS[0]), 'Verse 1 text');
  s.close();
});

test('the next chapter and the story recap work offline', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  assert.equal(JSON.stringify((await s.call('getStoryChapters', 1)).map(c => c.chapter_num)), '[1,2,3]');
  assert.equal(await s.call('getLastChapterNum', 1), 3);
  assert.equal((await s.call('getStoryPath', 1)).slug, 'abraham');
  const recap = await s.call('getTrivia', { slug: 'abraham' });
  assert.equal(JSON.stringify(recap.map(r => r.id).sort()), '[200,201]');
  s.close();
});

test('solo trivia offline uses the saved questions: right difficulty, no repeats, a different mix each time', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  const rows = await s.call('getTrivia', { difficulty: 'hard', limit: 60 });
  assert.equal(rows.length, 6);
  assert.ok(rows.every(r => r.difficulty === 'hard'));
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  const orders = new Set();
  for (let i = 0; i < 12; i++) orders.add((await s.call('getTrivia', { difficulty: 'easy', limit: 5 })).map(r => r.id).join());
  assert.ok(orders.size > 1, 'varies');
  assert.equal((await s.call('getTrivia', { difficulty: 'easy', limit: 5 })).length, 5);
  assert.equal((await s.call('getTrivia', { difficulty: '', limit: 120 })).length, TRIVIA.length, 'endless uses every difficulty');
  assert.equal(JSON.stringify((await s.call('getTrivia', { topic: 'love', limit: 20 })).map(r => r.id)), '[300]');
  s.close();
});

test('starting a trivia game offline plays the saved questions', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('startTrivia', 'easy');
  const qs = s.ev('triviaSession.questions');
  assert.equal(qs.length, 10);
  assert.ok(qs.every(q => /^Q\d+\?$/.test(q.q)), 'from the saved copy, not the built-in list');
  s.close();
});

test('online, a difficulty game draws from the whole saved set, not just the first questions', async () => {
  const many = Array.from({ length: 300 }, (_, i) => question(i + 1, 'medium'));
  const s = setup({ trivia: many });
  await s.call('refreshOfflinePack');
  s.net.calls.length = 0;
  const seen = new Set();
  for (let i = 0; i < 12; i++) (await s.call('getTrivia', { difficulty: 'medium', limit: 60 })).forEach(r => seen.add(r.id));
  assert.ok(seen.size > 150, `saw ${seen.size} different questions`);
  assert.equal(s.net.calls.length, 0, 'no request needed');
  s.close();
});

test('with nothing saved yet, trivia asks the server as before', async () => {
  const s = setup();
  const rows = await s.call('getTrivia', { difficulty: 'hard', limit: 60 });
  assert.equal(rows.length, 6);
  assert.ok(s.net.calls.some(c => c.url.includes('difficulty=eq.hard')));
  s.close();
});

test('a difficulty with fewer than 5 saved questions still asks the server', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.calls.length = 0;
  await s.call('getTrivia', { difficulty: 'medium', limit: 60 });   // only 1 medium question is saved
  assert.ok(s.net.calls.some(c => c.url.includes('difficulty=eq.medium')));
  s.close();
});

test('story recaps and topic rounds still use live data when online', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.calls.length = 0;
  await s.call('getTrivia', { slug: 'abraham' });
  assert.ok(s.net.calls.some(c => c.url.includes('story_path_slug=eq.abraham')));
  s.close();
});

// ── Saving progress offline ──────────────────────────────

test('finishing a chapter offline keeps the progress, shows it, and waits to sync', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false; s.net.calls.length = 0;
  await s.call('completeStoryChapter', 1, 2, 3);
  assert.equal(s.ev('storyProgress[1]'), 2);
  assert.equal(s.ev('storyProgress["stars_1_2"]'), 3);
  assert.equal(rpc(s.net).length, 0, 'nothing was even attempted');
  const waiting = s.store('ss_pending_writes');
  assert.equal(waiting.length, 1);
  assert.deepEqual(waiting[0].payload, { p_path_id: 1, p_chapter_num: 2, p_stars: 3, p_completed: false });
  assert.equal(waiting[0].userId, U);
  assert.ok(s.toasts().some(t => /saved on this device/.test(t)));
  s.close();
});

test('the last chapter is recorded as completed when queued offline', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 3, 2);
  assert.equal(s.store('ss_pending_writes')[0].payload.p_completed, true);
  s.close();
});

test('progress made offline is still on the story list after restarting the app offline', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 2, 3);
  s.ev('storyProgress = {}');   // as after a restart
  await s.call('renderStoryMode');
  assert.equal(s.ev('storyProgress[1]'), 2);
  assert.equal(s.ev('storyProgress["stars_1_2"]'), 3);
  assert.match(s.w.document.getElementById('root').textContent, /2\/3 chapters/);
  s.close();
});

test('replaying a chapter offline keeps one waiting save with the best stars', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 2, 3);
  await s.call('completeStoryChapter', 1, 2, 1);
  await s.call('completeStoryChapter', 1, 1, 2);
  const waiting = s.store('ss_pending_writes');
  assert.equal(waiting.length, 2);
  assert.equal(waiting.find(w => w.payload.p_chapter_num === 2).payload.p_stars, 3);
  s.close();
});

test('a guest finishing a chapter offline queues nothing', async () => {
  const s = setup({ user: null });
  await s.call('completeStoryChapter', 1, 2, 3);
  assert.equal(s.w.localStorage.getItem('ss_pending_writes'), null);
  assert.equal(s.ev('storyProgress[1]'), 2);
  s.close();
});

test('online but the server fails twice: the save is kept for later instead of lost', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.failRpc = true;
  const real = s.w.setTimeout.bind(s.w);
  s.w.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
  await s.call('completeStoryChapter', 1, 2, 3);
  assert.equal(rpc(s.net).length, 2, 'tried twice');
  assert.equal(s.store('ss_pending_writes').length, 1);
  assert.ok(s.toasts().some(t => /saved on this device/.test(t)));
  s.close();
});

test('online and working: nothing is queued', async () => {
  const s = setup();
  await s.call('completeStoryChapter', 1, 2, 3);
  assert.equal(rpc(s.net).length, 1);
  assert.equal(s.w.localStorage.getItem('ss_pending_writes'), null);
  s.close();
});

// ── Sending what was saved offline ───────────────────────

test('when the connection returns, waiting progress is sent and cleared', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  await s.call('completeStoryChapter', 1, 2, 3);
  s.net.up = true; s.net.calls.length = 0;
  assert.equal(await s.call('flushPendingWrites'), 2);
  assert.equal(rpc(s.net).length, 2);
  assert.deepEqual(rpc(s.net).map(c => c.body.p_chapter_num), [1, 2]);
  assert.deepEqual(s.store('ss_pending_writes'), []);
  assert.ok(s.toasts().some(t => /Synced/.test(t)));
  s.close();
});

test('the browser "online" event triggers the sync', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  s.net.up = true;
  s.w.dispatchEvent(new s.w.Event('online'));
  await wait(60);
  assert.equal(rpc(s.net).length, 1);
  assert.deepEqual(s.store('ss_pending_writes'), []);
  s.close();
});

test('if the server still fails, everything stays queued and nothing is sent twice', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  await s.call('completeStoryChapter', 1, 2, 3);
  s.net.up = true; s.net.failRpc = true; s.net.calls.length = 0;
  assert.equal(await s.call('flushPendingWrites'), 0);
  assert.equal(rpc(s.net).length, 1, 'stopped at the first failure');
  assert.equal(s.store('ss_pending_writes').length, 2);
  s.net.failRpc = false;
  assert.equal(await s.call('flushPendingWrites'), 2);
  s.close();
});

test('two syncs at once do not send anything twice', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  s.net.up = true; s.net.calls.length = 0;
  await Promise.all([s.call('flushPendingWrites'), s.call('flushPendingWrites')]);
  assert.equal(rpc(s.net).length, 1);
  s.close();
});

test('only the signed-in player\'s saves are sent; another account\'s wait for their own sign-in', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  s.ev(`currentUser = { id: 'someone-else' }`);
  await s.call('completeStoryChapter', 2, 1, 3);
  s.net.up = true; s.net.calls.length = 0;
  assert.equal(await s.call('flushPendingWrites'), 1);
  assert.equal(rpc(s.net)[0].body.p_path_id, 2);
  assert.equal(s.store('ss_pending_writes').length, 1);
  assert.equal(s.store('ss_pending_writes')[0].userId, U);
  s.ev(`currentUser = { id: '${U}' }`);
  assert.equal(await s.call('flushPendingWrites'), 1);
  s.close();
});

test('deleting an account removes that player\'s saved progress and waiting saves', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  assert.ok(s.w.localStorage.getItem(`ss_story_progress_${U}`));
  s.call('clearSavedPlayerData', U);
  assert.equal(s.w.localStorage.getItem(`ss_story_progress_${U}`), null);
  assert.deepEqual(s.store('ss_pending_writes'), []);
  s.close();
});

test('a damaged saved queue is ignored, not a crash', async () => {
  const s = setup();
  s.w.localStorage.setItem('ss_pending_writes', '{not json');
  assert.equal(s.call('readPending').length, 0);
  s.w.localStorage.setItem('ss_pack_trivia', 'oops');
  assert.equal(s.call('packGet', 'trivia'), null);
  await assert.doesNotReject(s.call('flushPendingWrites'));
  s.close();
});

// ── Scores ───────────────────────────────────────────────

const SCORE = { user_id: U, player_name: 'Scout', score: 800, difficulty: 'easy', correct: 8 };

test('a trivia score earned offline is kept and sent later', async () => {
  const s = setup();
  s.net.up = false;
  assert.equal(await s.call('submitGameScore', 'leaderboard_trivia', SCORE), false);
  assert.equal(s.store('ss_pending_writes').length, 1);
  assert.ok(s.toasts().some(t => /Score saved on this device/.test(t)));
  s.net.up = true; s.net.calls.length = 0;
  assert.equal(await s.call('flushPendingWrites'), 1);
  const posts = s.net.scoreRows.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.score, 800);
  assert.deepEqual(s.store('ss_pending_writes'), []);
  s.close();
});

test('two offline scores for the same difficulty keep only the better one', async () => {
  const s = setup();
  s.net.up = false;
  await s.call('submitGameScore', 'leaderboard_trivia', { ...SCORE, score: 500 });
  await s.call('submitGameScore', 'leaderboard_trivia', { ...SCORE, score: 900 });
  await s.call('submitGameScore', 'leaderboard_trivia', { ...SCORE, score: 300 });
  await s.call('submitGameScore', 'leaderboard_trivia', { ...SCORE, score: 100, difficulty: 'hard' });
  const waiting = s.store('ss_pending_writes');
  assert.equal(waiting.length, 2);
  assert.equal(waiting.find(w => w.payload.data.difficulty === 'easy').payload.data.score, 900);
  s.close();
});

test('a score that cannot be sent online is kept too, but a sync that fails does not re-queue it', async () => {
  const s = setup();
  s.net.failScores = true;
  const real = s.w.setTimeout.bind(s.w);
  s.w.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
  assert.equal(await s.call('submitGameScore', 'leaderboard_trivia', SCORE), false);
  assert.equal(s.store('ss_pending_writes').length, 1);
  assert.equal(await s.call('flushPendingWrites'), 0);
  assert.equal(s.store('ss_pending_writes').length, 1, 'still exactly one');
  s.close();
});

test('a score sent from the queue stays quiet (no "new best" pop-up from an old game)', async () => {
  const s = setup();
  s.net.up = false;
  await s.call('submitGameScore', 'leaderboard_trivia', SCORE);
  s.net.up = true;
  await s.call('flushPendingWrites');
  assert.ok(![...s.w.document.body.children].some(c => /Score of .* submitted|already have a better|best/i.test(c.textContent) && c.style.position === 'fixed'));
  s.close();
});

test('a guest score offline is not queued', async () => {
  const s = setup({ user: null });
  s.net.up = false;
  assert.equal(await s.call('submitGameScore', 'leaderboard_trivia', SCORE), false);
  assert.equal(s.w.localStorage.getItem('ss_pending_writes'), null);
  s.close();
});

test('after sign-in the app saves the pack and sends waiting progress', async () => {
  const s = setup();
  await s.call('refreshOfflinePack');
  s.net.up = false;
  await s.call('completeStoryChapter', 1, 1, 2);
  s.net.up = true; s.net.calls.length = 0;
  s.ev('globalThis.showHome = () => {}; globalThis.prefetchDailyChallenge = () => {}; globalThis.loadStreak = async () => null;');
  s.call('showApp');
  await wait(60);
  assert.equal(rpc(s.net).length, 1);
  s.close();
});
