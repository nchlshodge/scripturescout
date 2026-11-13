// Static checks on the source files: things that have broken (or could silently break) before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { ROOT, HTML, inlineScript } = require('./helpers');

const script = inlineScript();
const ast = acorn.parse(script, { ecmaVersion: 'latest', locations: true });

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, fn));
    else if (v && typeof v.type === 'string') walk(v, fn);
  }
}

test('the app script parses', () => {
  assert.ok(script.length > 100000);
});

test('${...} never appears inside ordinary quoted strings (it would show up as literal text)', () => {
  const bad = [];
  walk(ast, n => {
    if (n.type === 'Literal' && typeof n.value === 'string' && /\$\{[a-zA-Z_]/.test(n.value)) bad.push(`line ${n.loc.start.line}: ${n.value.slice(0, 60)}`);
  });
  assert.deepEqual(bad, []);
});

test('every inline onclick handler points at a function that exists', () => {
  const declared = new Set();
  walk(ast, n => {
    if (n.type === 'FunctionDeclaration' && n.id) declared.add(n.id.name);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') declared.add(n.id.name);
  });
  // Assignments like window.foo = ... and window.foo / globalThis assignments
  for (const m of script.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]);
  const builtins = new Set(['event', 'this', 'document', 'window', 'navigator', 'history', 'location', 'if', 'return', 'alert', 'confirm', 'setTimeout', 'Number', 'parseInt', 'String']);
  const missing = new Set();
  for (const m of HTML.matchAll(/\bon(?:click|change|input|keydown|submit)=["']\s*(?:event\.stopPropagation\(\);)?\s*(?:[A-Za-z_$][\w$.]*\s*&&\s*)?([A-Za-z_$][\w$]*)\(/g)) {
    const name = m[1];
    if (!declared.has(name) && !builtins.has(name)) missing.add(name);
  }
  assert.deepEqual([...missing], []);
});

test('Content Security Policy is present and only allows our own hosts', () => {
  const m = HTML.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(m, 'CSP meta tag missing');
  const csp = m[1];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  const connect = csp.match(/connect-src ([^;]+)/)[1];
  assert.match(connect, /xzkxigwzoznefywsiwmb\.supabase\.co/);
  assert.doesNotMatch(connect, /\*|http:/);
});

test('the Supabase library is version-pinned with an integrity hash', () => {
  const tag = HTML.match(/<script[^>]*cdn\.jsdelivr\.net[^>]*>/)[0];
  assert.match(tag, /supabase-js@\d+\.\d+\.\d+/);
  assert.match(tag, /integrity="sha384-/);
});

test('no secret keys are shipped in the page', () => {
  assert.doesNotMatch(HTML, /service_role/i);
  assert.doesNotMatch(HTML, /BEGIN (?:RSA |EC )?PRIVATE KEY/);
  // The only JWT in the page should be the public anon key (role: anon).
  for (const m of HTML.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\./g)) {
    const payload = JSON.parse(Buffer.from(m[1], 'base64').toString());
    assert.equal(payload.role, 'anon');
  }
});

test('required files and database scripts are in the repo', () => {
  for (const f of ['index.html', 'privacy.html', 'terms.html', 'support.html', 'sw.js', 'site.webmanifest',
    'chat_moderation_migration.sql', 'age_checks_migration.sql', 'message_reactions_migration.sql',
    'ios/App/App/PrivacyInfo.xcprivacy', 'APPLE_SIGN_IN_SETUP.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' is missing');
  }
});

test('every icon file the page references exists', () => {
  const missing = new Set();
  for (const m of HTML.matchAll(/src="(icons\/[^"$]+)"/g)) if (!/['+]/.test(m[1]) && !fs.existsSync(path.join(ROOT, m[1]))) missing.add(m[1]);   // skip names built at run time
  assert.deepEqual([...missing], []);
});

test('privacy policy mentions the things the app actually does', () => {
  const p = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  for (const word of ['birth month', 'Supabase', 'Firebase', 'Google Fonts', 'jsDelivr', 'report', 'Delete Account']) {
    assert.match(p, new RegExp(word, 'i'), `privacy policy should mention "${word}"`);
  }
});
