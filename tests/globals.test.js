// Finds names the code uses but never defines. In the browser such a name throws "X is not defined" the moment that
// line runs, so these usually mean a button that does nothing (for example a function that was deleted but is still called).
const test = require('node:test');
const assert = require('node:assert/strict');
const acorn = require('acorn');
const eslintScope = require('eslint-scope');
const { inlineScript, loadApp } = require('./helpers');

// Provided by the page itself rather than the script: the Supabase library from its <script src> tag
// (the code checks `typeof supabase` before using it).
const FROM_OUTSIDE = new Set(['supabase']);

test('every name the code uses is defined somewhere', () => {
  const ast = acorn.parse(inlineScript(), { ecmaVersion: 'latest', locations: true, ranges: true });
  const scopes = eslintScope.analyze(ast, { ecmaVersion: 2022, sourceType: 'script' });
  const app = loadApp();
  const missing = new Map();
  for (const ref of scopes.globalScope.through) {
    const name = ref.identifier.name;
    if (FROM_OUTSIDE.has(name)) continue;
    let exists = false;
    try { exists = app.window.eval('typeof ' + name) !== 'undefined' || name in app.window; } catch (e) { exists = false; }
    if (!exists) { if (!missing.has(name)) missing.set(name, []); missing.get(name).push('line ' + ref.identifier.loc.start.line); }
  }
  app.close();
  assert.deepEqual([...missing].map(([n, l]) => `${n} (${l.slice(0, 3).join(', ')})`), []);
});
