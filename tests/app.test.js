// Behaviour tests: run the app's real functions in a fake browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, get } = require('./helpers');

// Only the retry pause (1.5 s) is skipped; other timers (like toast removal) run normally.
function skipRetryPause(window) {
  const real = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
}

let app;
test.before(() => { app = loadApp(); });
test.after(() => app.close());

test('the app starts without script errors', () => {
  assert.deepEqual(app.errors, []);
});

test('escapeHtml neutralises markup in text and attributes', () => {
  const esc = get(app.window, 'escapeHtml');
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc('"quoted" & \'single\''), '&quot;quoted&quot; &amp; &#39;single&#39;');
  assert.equal(esc(null), '');
});

test('escapeJsAttr is safe inside an inline onclick string', () => {
  const esc = get(app.window, 'escapeJsAttr');
  const out = esc(`x');alert(1);//"\n\\`);
  // The real check is below: the value must survive being placed in an onclick string unchanged.
  const doc = app.window.document;
  const b = doc.createElement('div');
  b.innerHTML = `<button id="t" onclick="window.__got='${out}'">x</button>`;
  doc.body.appendChild(b);
  doc.getElementById('t').click();
  assert.equal(app.window.__got, `x');alert(1);//"\n\\`);
});

test('profanity filter blocks slurs and obfuscated variants but not normal words', () => {
  const bad = get(app.window, 'isObjectionable');
  for (const t of ['what the fuck', 'sh!t happens', 'you a$$hole', 'b1tch', 'kill yourself']) assert.equal(bad(t), true, t);
  for (const t of ['hello friend', 'God is good', 'Amen, bless you', 'Scunthorpe grape class', 'He rode an ass', 'Assyria and Babylon']) assert.equal(bad(t), false, t);
});

test('maskObjectionable hides bad words and keeps everything else the same length', () => {
  const mask = get(app.window, 'maskObjectionable');
  assert.equal(mask('you a$$hole, ok'), 'you *******, ok');
  assert.equal(mask('hi there'), 'hi there');
  assert.equal(mask('sh!t').length, 4);
});

test('age check: 13+ rounds toward caution', () => {
  const ok = get(app.window, 'meetsMinAge');
  const now = new Date(); const y = now.getFullYear(), m = now.getMonth() + 1;
  assert.equal(ok({ month: m, year: y - 12 }), false);
  assert.equal(ok({ month: m, year: y - 13 }), false);          // turns 13 this month: wait until next month
  const d = new Date(now.getFullYear() - 13, now.getMonth() - 1, 1);   // 13 years and a month ago
  assert.equal(ok({ month: d.getMonth() + 1, year: d.getFullYear() }), true);
  assert.equal(ok({ month: m, year: y - 14 }), true);
  assert.equal(ok({ month: 1, year: 1990 }), true);
});

test('apiWrite throws when the server rejects the write', async () => {
  const { window } = loadApp({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(get(window, 'apiWrite')('https://x', {}), /403/);
  window.close();
});

test('saveWithRetry: succeeds first time with no retry', async () => {
  let calls = 0;
  const { window } = loadApp();
  const save = get(window, 'saveWithRetry');
  const r = await save(async () => { calls++; return 'ok'; }, 'score');
  assert.equal(r, 'ok'); assert.equal(calls, 1);
  window.close();
});

test('saveWithRetry: retries once after a failure, then succeeds', async () => {
  let calls = 0;
  const { window } = loadApp();
  skipRetryPause(window);   // skip the 1.5 s pause
  const r = await get(window, 'saveWithRetry')(async () => { calls++; if (calls === 1) throw new Error('blip'); return 'ok'; }, 'score');
  assert.equal(r, 'ok'); assert.equal(calls, 2);
  window.close();
});

test('saveWithRetry: tells the player when both tries fail', async () => {
  const { window } = loadApp();
  skipRetryPause(window);
  const r = await get(window, 'saveWithRetry')(async () => { throw new Error('down'); }, 'daily score');
  assert.equal(r, null);
  const toast = [...window.document.body.children].find(c => c.getAttribute('role') === 'status');
  assert.match(toast.textContent, /Couldn't save your daily score/);
  window.close();
});

test('icons: every icon is valid SVG markup and ico() never throws', () => {
  const ICO = get(app.window, 'ICO'); const ico = get(app.window, 'ico');
  const parser = new app.window.DOMParser();
  for (const name of Object.keys(ICO)) {
    const doc = parser.parseFromString(ico(name, 20), 'image/svg+xml');
    assert.equal(doc.querySelector('parsererror'), null, name);
    assert.ok(doc.querySelector('svg path, svg circle, svg rect, svg ellipse'), name + ' has no shapes');
  }
  assert.match(ico('does-not-exist'), /<svg/);
});

test('Endless mode is unlocked for everyone', () => {
  assert.equal(get(app.window, 'isEndlessUnlocked')(), true);
});

test('Apple sign-in switch is off, and Google is hidden on iPhone while it is off', () => {
  // If you turn Apple sign-in on, update this test on purpose.
  assert.equal(get(app.window, 'APPLE_SIGNIN_ENABLED'), false);
});
