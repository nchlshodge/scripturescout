// Loads the real index.html into jsdom (a fake browser) so tests run the app's own code.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// The app's one big inline <script> (the Supabase CDN script has a src and no body).
function inlineScript() {
  const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return scripts.sort((a, b) => b.length - a.length)[0];
}

function loadApp({ fetchImpl, url = 'https://scripturescout.test/' } = {}) {
  const errors = [];
  const dom = new JSDOM(HTML, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = fetchImpl || (async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' }));
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
      window.scrollTo = () => {};
      window.Notification = window.Notification || { permission: 'default', requestPermission: async () => 'default' };
      window.AudioContext = undefined;
      window.addEventListener('error', e => errors.push(e.message));
    },
  });
  return { window: dom.window, errors, close: () => dom.window.close() };
}

// Reads a top-level function/const from the app's global scope.
const get = (window, name) => window.eval(name);

module.exports = { ROOT, HTML, inlineScript, loadApp, get };

// A clock the test controls: new Date() and Date.now() inside the app follow clock.now.
function fakeClock(window, startMs) {
  const clock = { now: startMs, advance(ms) { clock.now += ms; }, set(ms) { clock.now = ms; } };
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...a) { a.length === 0 ? super(clock.now) : super(...a); }
    static now() { return clock.now; }
  };
  window.eval('globalThis.Date = window.Date');
  return clock;
}

// Replaces setInterval/clearInterval so a test can run ticks by hand.
function fakeIntervals(window) {
  const t = { active: new Map(), nextId: 1, cleared: [] };
  window.setInterval = (fn) => { const id = t.nextId++; t.active.set(id, fn); return id; };
  window.clearInterval = (id) => { t.cleared.push(id); t.active.delete(id); };
  t.tick = () => { for (const fn of [...t.active.values()]) fn(); };
  return t;
}

module.exports.fakeClock = fakeClock;
module.exports.fakeIntervals = fakeIntervals;

// Replaces setTimeout/clearTimeout with a virtual clock the test advances by hand.
function fakeTimeouts(window) {
  const t = { now: 0, nextId: 1, pending: new Map() };
  window.setTimeout = (fn, ms = 0, ...args) => { const id = t.nextId++; t.pending.set(id, { at: t.now + ms, fn: () => fn(...args) }); return id; };
  window.clearTimeout = (id) => { t.pending.delete(id); };
  t.advance = (ms) => {
    const end = t.now + ms;
    for (;;) {
      const due = [...t.pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      t.pending.delete(due[0]); t.now = Math.max(t.now, due[1].at); due[1].fn();
    }
    t.now = end;
  };
  return t;
}
module.exports.fakeTimeouts = fakeTimeouts;
