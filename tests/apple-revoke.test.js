// Revoking a person's Sign in with Apple authorization when they delete their account.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, loadApp, get } = require('./helpers');

const FN_DIR = path.join(ROOT, 'supabase/functions/delete-account');
const loadModule = () => import(path.join(FN_DIR, 'apple-revoke.mjs'));

// A throwaway key in the same format Apple gives out (.p8 = PKCS#8 P-256).
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = { APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_SERVICES_ID: 'com.example.signin', APPLE_PRIVATE_KEY: PEM };
const b64urlJson = s => JSON.parse(Buffer.from(s, 'base64url').toString());

test('the client secret is a valid ES256 token with the claims Apple expects', async () => {
  const { makeAppleClientSecret } = await loadModule();
  const now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const jwt = await makeAppleClientSecret({ teamId: 'TEAM123456', keyId: 'KEY1234567', servicesId: 'com.example.signin', privateKey: PEM, nowMs: now });
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(b64urlJson(h), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  const claims = b64urlJson(p);
  assert.equal(claims.iss, 'TEAM123456');
  assert.equal(claims.sub, 'com.example.signin');
  assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.equal(claims.iat, now / 1000);
  assert.ok(claims.exp > claims.iat && claims.exp - claims.iat <= 600, 'short-lived');
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  assert.ok(ok, 'signature verifies with the matching public key');
});

test('a key pasted with escaped newlines (as often happens in secret settings) still works', async () => {
  const { makeAppleClientSecret } = await loadModule();
  const flat = PEM.replace(/\n/g, '\\n');
  const jwt = await makeAppleClientSecret({ teamId: 't', keyId: 'k', servicesId: 's', privateKey: flat });
  assert.equal(jwt.split('.').length, 3);
});

test('revoking sends the saved token to Apple with the right fields', async () => {
  const { revokeAppleToken } = await loadModule();
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200 }; };
  const r = await revokeAppleToken({ refreshToken: 'r.abc123refresh', env: ENV, fetchImpl });
  assert.equal(r.status, 'revoked');
  assert.equal(seen.url, 'https://appleid.apple.com/auth/revoke');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(seen.opts.body);
  assert.equal(form.get('client_id'), 'com.example.signin');
  assert.equal(form.get('token'), 'r.abc123refresh');
  assert.equal(form.get('token_type_hint'), 'refresh_token');
  assert.equal(form.get('client_secret').split('.').length, 3);
});

test('no saved token (a Google or email account) means nothing is sent', async () => {
  const { revokeAppleToken } = await loadModule();
  let called = false;
  const r = await revokeAppleToken({ refreshToken: null, env: ENV, fetchImpl: async () => { called = true; return { ok: true }; } });
  assert.equal(r.status, 'skipped');
  assert.equal(called, false);
});

test('before Apple is set up (secrets missing) it skips instead of failing', async () => {
  const { revokeAppleToken } = await loadModule();
  for (const missing of Object.keys(ENV)) {
    const env = { ...ENV, [missing]: '' };
    const r = await revokeAppleToken({ refreshToken: 'r.abc123refresh', env, fetchImpl: async () => { throw new Error('should not be called'); } });
    assert.equal(r.status, 'skipped', missing);
  }
});

test('Apple refusing, being unreachable, or a bad key never throws: deletion must go on', async () => {
  const { revokeAppleToken } = await loadModule();
  assert.equal((await revokeAppleToken({ refreshToken: 'r.abc123refresh', env: ENV, fetchImpl: async () => ({ ok: false, status: 400 }) })).status, 'failed');
  assert.equal((await revokeAppleToken({ refreshToken: 'r.abc123refresh', env: ENV, fetchImpl: async () => { throw new TypeError('network down'); } })).status, 'failed');
  const bad = await revokeAppleToken({ refreshToken: 'r.abc123refresh', env: { ...ENV, APPLE_PRIVATE_KEY: 'not a key' }, fetchImpl: async () => ({ ok: true }) });
  assert.equal(bad.status, 'failed');
});

test('the failure report never includes the token or the key', async () => {
  const { revokeAppleToken } = await loadModule();
  const r = await revokeAppleToken({ refreshToken: 'r.SECRETTOKEN999', env: { ...ENV, APPLE_PRIVATE_KEY: 'not a key' }, fetchImpl: async () => ({ ok: true }) });
  assert.ok(!JSON.stringify(r).includes('SECRETTOKEN999'));
});

// ── The delete-account function and the database ──

test('delete-account revokes with Apple before it deletes anything, and uses the helper', () => {
  const src = fs.readFileSync(path.join(FN_DIR, 'index.ts'), 'utf8');
  assert.match(src, /from "\.\/apple-revoke\.mjs"/);
  const revoke = src.indexOf('revokeAppleToken(');
  assert.ok(revoke > 0);
  assert.ok(revoke < src.indexOf('for (const [table, column] of USER_DATA_TABLES)'), 'revoke runs before the data is deleted');
  assert.ok(revoke < src.indexOf('admin.auth.admin.deleteUser'), 'and before the account is deleted');
  assert.match(src, /\["apple_tokens", "user_id"\]/, 'the saved token is removed with the account');
  assert.match(src, /\.eq\("user_id", userId\)/, 'only this caller\'s token is read');
});

test('the database keeps Apple tokens where the app cannot read them', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'apple_tokens_migration.sql'), 'utf8');
  assert.match(sql, /enable row level security/i);
  assert.doesNotMatch(sql, /create policy/i, 'no policies: only the server can touch the table');
  assert.match(sql, /revoke all on public\.apple_tokens from anon, authenticated/i);
  assert.match(sql, /on delete cascade/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /grant execute on function public\.save_apple_refresh_token\(text\) to authenticated/i);
  assert.doesNotMatch(sql, /grant execute[^;]*\banon\b/i);
});

// ── The app side ──

function appWith(fetchImpl) {
  const app = loadApp({ fetchImpl });
  app.window.eval('globalThis.renderAuthScreen = () => {};');
  return app;
}
const session = (over = {}) => ({ access_token: 'access-tok', provider_refresh_token: 'r.apple-refresh-token', user: { id: 'u1', app_metadata: { provider: 'apple' } }, ...over });

test('after an Apple sign-in the refresh token is sent to the server, with the person\'s own login', async () => {
  const calls = [];
  const { window, close } = appWith(async (url, opts = {}) => { calls.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => [], text: async () => '' }; });
  assert.equal(await get(window, 'saveAppleRefreshToken')(session()), true);
  const c = calls.find(x => x.url.includes('/rpc/save_apple_refresh_token'));
  assert.ok(c);
  assert.equal(JSON.parse(c.opts.body).p_token, 'r.apple-refresh-token');
  assert.equal(c.opts.headers.Authorization, 'Bearer access-tok');
  close();
});

test('Google and email sign-ins send nothing', async () => {
  const calls = [];
  const { window, close } = appWith(async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => [] }; });
  const f = get(window, 'saveAppleRefreshToken');
  assert.equal(await f(session({ user: { id: 'u1', app_metadata: { provider: 'google' } } })), false);
  assert.equal(await f(session({ user: { id: 'u1', app_metadata: { provider: 'email' } } })), false);
  assert.equal(await f(session({ provider_refresh_token: null })), false);
  assert.equal(await f(null), false);
  assert.equal(calls.filter(u => u.includes('save_apple')).length, 0);
  close();
});

test('a failed save is retried once, never shows an error, and never throws', async () => {
  const calls = [];
  const { window, close } = appWith(async (url) => { calls.push(String(url)); return { ok: false, status: 500, json: async () => ({}) }; });
  const real = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...a) => (ms === 1500 ? (fn(), 0) : real(fn, ms, ...a));
  assert.equal(await get(window, 'saveAppleRefreshToken')(session()), false);
  assert.equal(calls.filter(u => u.includes('save_apple')).length, 2);
  assert.ok(![...window.document.body.children].some(c => c.getAttribute && c.getAttribute('role') === 'status' && /Apple/.test(c.textContent)));
  close();
});

test('the sign-in listener passes new sessions to it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /event === 'SIGNED_IN' && session\) setTimeout\(\(\) => saveAppleRefreshToken\(session\), 0\)/);
});
