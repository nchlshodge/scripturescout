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

function loadApp({ fetchImpl } = {}) {
  const errors = [];
  const dom = new JSDOM(HTML, {
    url: 'https://scripturescout.test/',
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
