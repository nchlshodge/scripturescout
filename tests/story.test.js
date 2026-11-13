// Story Mode progress: saving chapters/stars, loading progress, what the path and list screens show.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

const U = 'u-1';
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));

// Builds a signed-in (or guest) app with a fake Supabase.
function setup({ user = U, paths = [], chapters = [], progress = [] } = {}) {
  const calls = [];                       // every request the app makes
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
    return { ok: true, status: 200, json: async () => [], text: async () => '' };
  };
  const { window, close } = loadApp({ fetchImpl });
  window.__paths = paths; window.__chapters = chapters; window.__progress = progress;
  window.eval(`
    globalThis.sbFetch = async (path) => {
      if (path.startsWith('story_paths?order')) return window.__paths;
      if (path.startsWith('story_paths?id=eq.')) return window.__paths.filter(p => p.id === parseInt(path.match(/id=eq\\.(\\d+)/)[1]));
      if (path.startsWith('story_chapters?select=id,path_id')) return window.__chapters.map(c => ({ id: c.id, path_id: c.path_id }));
      if (path.startsWith('story_chapters?path_id=eq.') && path.includes('limit=1')) {
        const id = parseInt(path.match(/path_id=eq\\.(\\d+)/)[1]);
        const mine = window.__chapters.filter(c => c.path_id === id).sort((a, b) => b.chapter_num - a.chapter_num);
        return mine.slice(0, 1);
      }
      if (path.startsWith('story_chapters?path_id=eq.')) {
        const id = parseInt(path.match(/path_id=eq\\.(\\d+)/)[1]);
        return window.__chapters.filter(c => c.path_id === id).sort((a, b) => a.chapter_num - b.chapter_num);
      }
      if (path.startsWith('story_progress?')) return window.__progress;
      return [];
    };
    globalThis.updateStreak = async () => {};
  `);
  if (user) window.eval(`currentUser = { id: '${user}' }; authToken = 'tok';`);
  else window.eval('currentUser = null; authToken = null;');
  return { window, calls, close };
}

const path = (id, extra = {}) => ({ id, title: 'Path ' + id, description: 'About path ' + id, icon: 'X', slug: 'none', testament: 'OT', order_num: id, ...extra });
const chapter = (pathId, n) => ({ id: pathId * 100 + n, path_id: pathId, chapter_num: n, title: `Chapter ${n}`, book: 'Genesis', chapter: n, verse: 1 });
const chaptersFor = (pathId, count) => Array.from({ length: count }, (_, i) => chapter(pathId, i + 1));
const rpcCalls = calls => calls.filter(c => c.url.includes('/rpc/upsert_story_progress'));

// ── Saving ─────────────────────────────────────────────

test('finishing a chapter as a guest updates progress on screen but sends nothing', async () => {
  const { window, calls, close } = setup({ user: null, chapters: chaptersFor(7, 10) });
  await get(window, 'completeStoryChapter')(7, 3, 2);
  assert.equal(window.eval('storyProgress[7]'), 3);
  assert.equal(calls.length, 0);
  close();
});

test('finishing a chapter saves chapter number and stars for a signed-in player', async () => {
  const { window, calls, close } = setup({ chapters: chaptersFor(7, 10) });
  await get(window, 'completeStoryChapter')(7, 3, 2);
  const rpc = rpcCalls(calls);
  assert.equal(rpc.length, 1);
  assert.deepEqual(rpc[0].body, { p_path_id: 7, p_chapter_num: 3, p_stars: 2, p_completed: false });
  assert.match(rpc[0].headers.Authorization, /Bearer tok/);
  assert.equal(window.eval('storyProgress[7]'), 3);
  close();
});

test('the path counts as completed only when the last chapter is finished', async () => {
  const { window, calls, close } = setup({ chapters: chaptersFor(7, 4) });
  const done = get(window, 'completeStoryChapter');
  await done(7, 3, 3);
  await done(7, 4, 1);
  const rpc = rpcCalls(calls);
  assert.equal(rpc[0].body.p_completed, false);
  assert.equal(rpc[1].body.p_completed, true);
  close();
});

test('replaying an earlier chapter never moves progress backwards', async () => {
  const { window, close } = setup({ chapters: chaptersFor(7, 10) });
  const done = get(window, 'completeStoryChapter');
  await done(7, 6, 3);
  await done(7, 2, 1);
  assert.equal(window.eval('storyProgress[7]'), 6);
  close();
});

test('a round replay keeps the best stars the player already had', async () => {
  const { window, close } = setup({ chapters: chaptersFor(7, 10) });
  window.eval(`globalThis.__saved = []; globalThis.completeStoryChapter = async (...a) => { __saved.push(a); };`);
  window.eval(`storyInteractive = { pathId: 7, chapter: { chapter_num: 3, title: 'T' }, round: 1, stars: 3 };`);
  await get(window, 'completeStoryRound')();            // finishing round 1 again after already earning 3 stars
  assert.equal(JSON.stringify(window.__saved[0]), '[7,3,3]');
  assert.equal(window.eval('storyProgress["stars_7_3"]'), 3);
  window.eval(`storyInteractive = { pathId: 7, chapter: { chapter_num: 4, title: 'T' }, round: 2, stars: 0 };`);
  await get(window, 'completeStoryRound')();
  assert.equal(JSON.stringify(window.__saved[1]), '[7,4,2]');
  close();
});

test('a failed save is retried once, then kept on the device and the player is told', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => { calls.push(String(url)); return { ok: !String(url).includes('/rpc/'), status: 500, json: async () => [], text: async () => '' }; };
  const { window, close } = loadApp({ fetchImpl });
  const real = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
  window.eval(`globalThis.sbFetch = async () => [{ chapter_num: 10 }]; globalThis.updateStreak = async () => {}; currentUser = { id: 'u' }; authToken = 't';`);
  await get(window, 'completeStoryChapter')(7, 2, 3);
  assert.equal(calls.filter(u => u.includes('/rpc/')).length, 2, 'tried twice');
  assert.equal(window.eval('storyProgress[7]'), 2, 'progress still shows on screen');
  const toast = [...window.document.body.children].find(c => c.getAttribute('role') === 'status');
  assert.match(toast.textContent, /saved on this device/);
  close();
});

// ── Loading and showing progress ───────────────────────

test('the story list shows complete, in-progress and new paths correctly', async () => {
  const { window, close } = setup({
    paths: [path(1), path(2), path(3)],
    chapters: [...chaptersFor(1, 3), ...chaptersFor(2, 4), ...chaptersFor(3, 2)],
    progress: [
      { path_id: 1, chapter_num: 1, stars: 3 }, { path_id: 1, chapter_num: 2, stars: 2 }, { path_id: 1, chapter_num: 3, stars: 1 },   // path 1 done
      { path_id: 2, chapter_num: 1, stars: 3 }, { path_id: 2, chapter_num: 2, stars: 1 },                                              // path 2: 2 of 4
    ],
  });
  await get(window, 'renderStoryMode')();
  const entry = id => window.document.querySelector(`.fg-path-entry[data-path="${id}"]:not([style])`);
  assert.match(entry(1).textContent, /3\/3 chapters/); assert.match(entry(1).textContent, /Complete/);
  assert.match(entry(2).textContent, /2\/4 chapters/); assert.match(entry(2).textContent, /In progress/);
  assert.match(entry(3).textContent, /Tap to begin/);
  close();
});

test('stars use the best result and progress uses the furthest chapter, whatever order rows arrive in', async () => {
  const { window, close } = setup({
    paths: [path(1)], chapters: chaptersFor(1, 5),
    progress: [{ path_id: 1, chapter_num: 3, stars: 1 }, { path_id: 1, chapter_num: 3, stars: 3 }, { path_id: 1, chapter_num: 2, stars: 2 }],
  });
  await get(window, 'renderStoryMode')();
  assert.equal(window.eval('storyProgress[1]'), 3);
  assert.equal(window.eval('storyProgress["stars_1_3"]'), 3);
  assert.equal(window.eval('storyProgress["stars_1_2"]'), 2);
  close();
});

test('"Continue" appears for a path in progress even when star counts are high', async () => {
  // Regression: star entries (e.g. stars_2_1 = 3) were mixed in with path ids when picking the last path,
  // so a player with one chapter and 3 stars got no Continue card.
  const { window, close } = setup({
    paths: [path(2)], chapters: chaptersFor(2, 6),
    progress: [{ path_id: 2, chapter_num: 1, stars: 3 }],
  });
  await get(window, 'renderStoryMode')();
  const text = window.document.getElementById('root').textContent;
  assert.match(text, /Continue:\s*.*Path 2/);
  assert.match(text, /Chapter 2 of 6/);
  close();
});

test('"Continue" picks an unfinished path, not a finished one', async () => {
  const { window, close } = setup({
    paths: [path(1), path(2)], chapters: [...chaptersFor(1, 2), ...chaptersFor(2, 5)],
    progress: [{ path_id: 1, chapter_num: 1, stars: 1 }, { path_id: 1, chapter_num: 2, stars: 3 }, { path_id: 2, chapter_num: 1, stars: 2 }],
  });
  await get(window, 'renderStoryMode')();
  const text = window.document.getElementById('root').textContent;
  assert.match(text, /Continue:\s*.*Path 2/);
  close();
});

test('no "Continue" card when nothing is in progress', async () => {
  const { window, close } = setup({ paths: [path(1)], chapters: chaptersFor(1, 3), progress: [] });
  await get(window, 'renderStoryMode')();
  assert.doesNotMatch(window.document.getElementById('root').textContent, /Continue:/);
  close();
});

test("one player's story progress does not carry over to the next account on the same device", async () => {
  // Regression: the in-memory progress was never cleared on sign-out.
  const { window, close } = setup({ paths: [path(1)], chapters: chaptersFor(1, 4), progress: [{ path_id: 1, chapter_num: 3, stars: 3 }] });
  await get(window, 'renderStoryMode')();
  assert.equal(window.eval('storyProgress[1]'), 3);
  await get(window, 'signOut')();
  assert.equal(window.eval('storyProgress[1]'), undefined, 'cleared on sign-out');
  // A different player with no progress:
  window.__progress = [];
  window.eval(`currentUser = { id: 'u-2' }; authToken = 't2';`);
  await get(window, 'renderStoryMode')();
  assert.doesNotMatch(window.document.getElementById('root').textContent, /In progress/);
  close();
});

test('signing out completes without errors (the old code threw on a missing menu element)', async () => {
  const { window, close } = setup({ chapters: chaptersFor(1, 2) });
  await assert.doesNotReject(get(window, 'signOut')());
  assert.equal(window.eval('currentUser'), null);
  close();
});

// ── The chapter list inside a path ─────────────────────

async function openPath(completed, total = 4) {
  const progress = Array.from({ length: completed }, (_, i) => ({ path_id: 5, chapter_num: i + 1, stars: (i % 3) + 1 }));
  const app = setup({ paths: [path(5)], chapters: chaptersFor(5, total), progress });
  await get(app.window, 'renderStoryMode')();            // loads progress
  await get(app.window, 'renderStoryPath')(5);
  return app;
}
const rows = w => [...w.document.querySelectorAll('.fg-ch-row')];

test('a new path: chapter 1 is open, the rest are locked, button says Begin', async () => {
  const { window, close } = await openPath(0);
  const r = rows(window);
  assert.equal(r.length, 4);
  assert.ok(r[0].hasAttribute('data-chapter'), 'chapter 1 can be opened');
  assert.ok(r.slice(1).every(x => !x.hasAttribute('data-chapter')), 'later chapters are locked');
  assert.match(window.document.getElementById('fgBeginChapterBtn').textContent, /Begin Chapter 1/);
  assert.match(window.document.querySelector('.fg-page-num').textContent, /0 of 4 complete/);
  close();
});

test('mid-path: finished chapters show a tick and stars, the next one is open, button says Continue', async () => {
  const { window, close } = await openPath(2);
  const r = rows(window);
  assert.match(r[0].textContent, /✓/); assert.match(r[0].textContent, /★/);
  assert.match(r[1].textContent, /✓/);
  assert.ok(r[2].hasAttribute('data-chapter'), 'chapter 3 (next) can be opened');
  assert.ok(!r[3].hasAttribute('data-chapter'), 'chapter 4 is still locked');
  assert.match(window.document.getElementById('fgBeginChapterBtn').textContent, /Continue Chapter 3/);
  assert.match(window.document.querySelector('.fg-page-num').textContent, /2 of 4 complete/);
  close();
});

test('a finished path has every chapter open for replay and no Continue button', async () => {
  const { window, close } = await openPath(4);
  assert.ok(rows(window).every(x => x.hasAttribute('data-chapter')));
  assert.equal(window.document.getElementById('fgBeginChapterBtn'), null);
  assert.match(window.document.querySelector('.fg-page-num').textContent, /4 of 4 complete/);
  close();
});

test('stars shown for a chapter never exceed three', async () => {
  const { window, close } = await openPath(3);
  for (const r of rows(window)) {
    const stars = r.querySelector('.fg-ch-stars').textContent;
    assert.ok((stars.match(/★/g) || []).length <= 3);
  }
  close();
});
