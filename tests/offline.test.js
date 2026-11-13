// Offline behaviour: the app shell is cached by the service worker, live (Supabase) requests are never cached,
// and a screen stuck loading with no connection turns into a clear "You're offline" panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { ROOT, loadApp, get } = require('./helpers');

const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

// ── Service worker, run in a fake worker environment ─────────────────────────
function makeWorker({ online = true, files = {} } = {}) {
  const stores = {};             // cacheName → Map(key → Response-like)
  const listeners = {};
  const keyOf = r => (typeof r === 'string' ? r : r.url).replace(/^https:\/\/scripturescout\.test\//, '');
  const caches = {
    open: async name => {
      const m = stores[name] || (stores[name] = new Map());
      return {
        add: async r => { const k = keyOf(r); if (!(k in files) && !(k === './' && 'index.html' in files)) throw new Error('404 ' + k); m.set(k, { ok: true, body: files[k] || files['index.html'] }); },
        put: async (r, res) => { m.set(keyOf(r), res); },
        match: async r => m.get(keyOf(r)),
      };
    },
    keys: async () => Object.keys(stores),
    delete: async n => { delete stores[n]; return true; },
  };
  const networkCalls = [];
  const sandbox = {
    self: { addEventListener: (t, f) => { listeners[t] = f; }, location: { origin: 'https://scripturescout.test' }, skipWaiting: async () => {}, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} }, registration: {} },
    caches, URL, Request: class { constructor(u) { this.url = new URL(u, 'https://scripturescout.test/').href; } },
    Response: { error: () => ({ error: true }) },
    fetch: async r => { networkCalls.push(keyOf(r)); if (!online) throw new TypeError('offline'); return { ok: true, type: 'basic', body: 'net:' + keyOf(r), clone() { return this; } }; },
  };
  vm.runInNewContext(SW, sandbox);
  const fire = async (type, ev) => { let p; ev.waitUntil = x => { p = x; }; ev.respondWith = x => { ev._resp = x; ev._handled = true; }; listeners[type](ev); if (p) await p; return ev._handled ? await ev._resp : undefined; };
  return { stores, fire, networkCalls, setOnline: v => { online = v; }, sandbox };
}
const req = (url, extra = {}) => ({ url, method: 'GET', mode: 'cors', ...extra });
const ALL_FILES = () => Object.fromEntries([...SW.matchAll(/^\s+'([^']+)',$/gm)].map(m => [m[1], 'file:' + m[1]]).concat([['index.html', 'PAGE']]));

test('every file the service worker caches actually exists, and is copied into the native apps', () => {
  const listed = [...SW.matchAll(/^\s+'([^']+)',$/gm)].map(m => m[1]).filter(f => f !== './');
  assert.ok(listed.includes('index.html') && listed.some(f => f.startsWith('vendor/supabase-js')));
  const sync = fs.readFileSync(path.join(ROOT, 'scripts/sync-www.sh'), 'utf8');
  for (const f of listed) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
    const top = f.split('/')[0];
    assert.ok(sync.includes(top), `sync-www.sh does not copy ${top}`);
  }
});

test('installing caches the app shell, and one missing file does not block the install', async () => {
  const files = ALL_FILES(); delete files['randy-sad.webp']; delete files['randy-happy.webp'];
  const w = makeWorker({ files });
  await w.fire('install', {});
  const cached = [...w.stores['ss-shell-v1'].keys()];
  assert.ok(cached.includes('index.html') && cached.includes('vendor/supabase-js-2.119.0.js'));
});

test('offline, opening the app serves the saved page; online, the fresh page is used and saved', async () => {
  const w = makeWorker({ files: ALL_FILES() });
  await w.fire('install', {});
  w.setOnline(false);
  const offline = await w.fire('fetch', { request: req('https://scripturescout.test/', { mode: 'navigate' }) });
  assert.equal(offline.body, 'PAGE');
  w.setOnline(true);
  const fresh = await w.fire('fetch', { request: req('https://scripturescout.test/index.html', { mode: 'navigate' }) });
  assert.equal(fresh.body, 'net:index.html');
  assert.equal(w.stores['ss-shell-v1'].get('index.html').body, 'net:index.html');
});

test('with nothing saved yet, going offline fails normally instead of serving junk', async () => {
  const w = makeWorker({ online: false });
  await assert.rejects(w.fire('fetch', { request: req('https://scripturescout.test/', { mode: 'navigate' }) }));
});

test('Supabase requests and writes are never touched by the service worker', async () => {
  const w = makeWorker({ files: ALL_FILES() });
  await w.fire('install', {});
  assert.equal(await w.fire('fetch', { request: req('https://xzkxigwzoznefywsiwmb.supabase.co/rest/v1/leaderboard') }), undefined);
  assert.equal(await w.fire('fetch', { request: req('https://scripturescout.test/x', { method: 'POST' }) }), undefined);
});

test('images and the bundled library come from the cache first', async () => {
  const w = makeWorker({ files: ALL_FILES() });
  await w.fire('install', {});
  w.networkCalls.length = 0;
  const lib = await w.fire('fetch', { request: req('https://scripturescout.test/vendor/supabase-js-2.119.0.js') });
  assert.equal(lib.body, 'file:vendor/supabase-js-2.119.0.js');
  assert.equal(w.networkCalls.length, 0);
});

test('a cached image is shown straight away and refreshed quietly in the background', async () => {
  const w = makeWorker({ files: ALL_FILES() });
  await w.fire('install', {});
  w.networkCalls.length = 0;
  const img = await w.fire('fetch', { request: req('https://scripturescout.test/randy-happy.webp'), waitUntil() {} });
  assert.equal(img.body, 'file:randy-happy.webp');
  assert.deepEqual(w.networkCalls, ['randy-happy.webp']);
});

test('fonts are served from the cache when offline once they have been loaded', async () => {
  const w = makeWorker({ files: ALL_FILES() });
  const font = req('https://fonts.gstatic.com/s/dmsans.woff2');
  const first = await w.fire('fetch', { request: font });
  await wait();
  w.setOnline(false);
  const again = await w.fire('fetch', { request: font });
  assert.ok(!again.error);
  assert.equal(again.body, first.body);
});

test('activating removes old Scripture Scout caches but not other sites\' caches', async () => {
  const w = makeWorker({ files: ALL_FILES() });
  w.stores['ss-shell-v0'] = new Map(); w.stores['other-cache'] = new Map();
  await w.fire('install', {});
  await w.fire('activate', {});
  assert.ok(!('ss-shell-v0' in w.stores));
  assert.ok('ss-shell-v1' in w.stores && 'other-cache' in w.stores);
});

// ── The app itself ────────────────────────────────────────────────────────────
function offlineApp({ online = false } = {}) {
  const calls = [];
  const app = loadApp({ fetchImpl: async u => { calls.push(String(u)); return { ok: true, status: 200, json: async () => [], text: async () => '' }; } });
  const w = app.window;
  w.eval('globalThis.renderAuthScreen = () => {};');
  Object.defineProperty(w.navigator, 'onLine', { get: () => w.__online, configurable: true });
  w.__online = online;
  return { ...app, w, calls };
}
const SB = 'https://xzkxigwzoznefywsiwmb.supabase.co/rest/v1/x';

test('with no connection, a Supabase request fails straight away instead of hanging', async () => {
  const { w, calls, close } = offlineApp();
  await assert.rejects(w.fetch(SB), /offline/i);
  assert.equal(calls.length, 0);
  await w.fetch('https://scripturescout.test/randy-happy.webp');   // other requests are left alone
  assert.equal(calls.length, 1);
  close();
});

test('a screen stuck on its spinner while offline becomes the "You\'re offline" panel', async () => {
  const { w, close } = offlineApp();
  w.document.getElementById('root').innerHTML = '<div class="loading-wrap"><div class="spinner"></div><div class="loading-text">Loading friends…</div></div>';
  w.fetch(SB).catch(() => {});
  await wait(1100);
  const root = w.document.getElementById('root');
  assert.match(root.textContent, /You're offline/);
  assert.ok(root.querySelector('button'));
  assert.ok(!root.querySelector('.spinner'));
  close();
});

test('a screen that already shows content is not replaced', async () => {
  const { w, close } = offlineApp();
  w.document.getElementById('root').innerHTML = '<div class="card">Your friends list with plenty of real content on screen, so nothing should be swapped out here at all.</div>';
  w.fetch(SB).catch(() => {});
  await wait(1100);
  assert.match(w.document.getElementById('root').textContent, /Your friends list/);
  close();
});

test('Try again stays put while offline, and goes home once the connection is back', async () => {
  const { w, close } = offlineApp();
  w.eval(`globalThis.__home = 0; globalThis.showHome = () => { window.__home++; };
          globalThis.__toasts = []; globalThis.showToast = m => window.__toasts.push(m);`);
  get(w, 'showOfflineScreen')();
  get(w, 'retryAfterOffline')();
  assert.equal(w.__home, 0);
  assert.match(w.__toasts[0], /offline/i);
  w.__online = true;
  get(w, 'retryAfterOffline')();
  assert.equal(w.__home, 1);
  close();
});

test('the offline banner follows the connection', () => {
  const { w, close } = offlineApp();
  const banner = w.document.getElementById('offlineBanner');
  w.dispatchEvent(new w.Event('offline')); assert.notEqual(banner.style.display, 'none');
  w.__online = true; w.dispatchEvent(new w.Event('online')); assert.equal(banner.style.display, 'none');
  close();
});
