// Revokes a person's Sign in with Apple authorization when they delete their account
// (App Store guideline 5.1.1(v)). Plain JavaScript using only Web Crypto and fetch, so it runs in
// the Supabase Edge Function (Deno) and in the Node test suite.
//
// Needs these function secrets (see APPLE_SIGN_IN_SETUP.md): APPLE_TEAM_ID, APPLE_KEY_ID,
// APPLE_SERVICES_ID (the Services ID Supabase signs in with), APPLE_PRIVATE_KEY (the .p8 file's text).

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const textBytes = text => new TextEncoder().encode(text);

function pemToDer(pem) {
  const body = String(pem).replace(/\\n/g, '\n').replace(/-----BEGIN [A-Z ]+-----/, '').replace(/-----END [A-Z ]+-----/, '').replace(/\s+/g, '');
  const raw = atob(body);
  const der = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) der[i] = raw.charCodeAt(i);
  return der;
}

// The "client secret" Apple wants: a short-lived ES256 token signed with the .p8 key.
export async function makeAppleClientSecret({ teamId, keyId, servicesId, privateKey, nowMs = Date.now() }) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: teamId, iat, exp: iat + 300, aud: APPLE_AUDIENCE, sub: servicesId };
  const input = `${base64url(textBytes(JSON.stringify(header)))}.${base64url(textBytes(JSON.stringify(payload)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, textBytes(input)));   // raw r||s, as JWT expects
  return `${input}.${base64url(signature)}`;
}

// Returns { status: 'revoked' | 'skipped' | 'failed', detail }. Never throws: account deletion must go on.
export async function revokeAppleToken({ refreshToken, env, fetchImpl = fetch, nowMs = Date.now() }) {
  if (!refreshToken) return { status: 'skipped', detail: 'no Apple token saved for this account' };
  const teamId = env.APPLE_TEAM_ID, keyId = env.APPLE_KEY_ID, servicesId = env.APPLE_SERVICES_ID, privateKey = env.APPLE_PRIVATE_KEY;
  if (!teamId || !keyId || !servicesId || !privateKey) return { status: 'skipped', detail: 'Apple secrets are not set on the function' };
  try {
    const clientSecret = await makeAppleClientSecret({ teamId, keyId, servicesId, privateKey, nowMs });
    const res = await fetchImpl(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: servicesId, client_secret: clientSecret, token: refreshToken, token_type_hint: 'refresh_token' }).toString(),
    });
    if (res.ok) return { status: 'revoked', detail: String(res.status) };
    return { status: 'failed', detail: `Apple answered ${res.status}` };
  } catch (e) {
    return { status: 'failed', detail: e && e.message ? e.message : String(e) };
  }
}
