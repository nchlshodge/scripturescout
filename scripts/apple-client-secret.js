#!/usr/bin/env node
// Generates the "client secret" Supabase needs for the Apple provider.
// Apple makes this a signed token (JWT) that expires after at most 6 months, so it must be
// regenerated and pasted into Supabase before then (set a calendar reminder for ~5 months).
//
// Usage:
//   node scripts/apple-client-secret.js <TEAM_ID> <KEY_ID> <SERVICES_ID> <path/to/AuthKey_XXXX.p8>
//
// Nothing is sent anywhere; the .p8 file is only read locally. Don't commit the .p8 or the output.
const crypto = require('crypto');
const fs = require('fs');

const [teamId, keyId, servicesId, keyPath] = process.argv.slice(2);
if (!teamId || !keyId || !servicesId || !keyPath) {
  console.error('Usage: node scripts/apple-client-secret.js <TEAM_ID> <KEY_ID> <SERVICES_ID> <path/to/AuthKey.p8>');
  process.exit(1);
}

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const now = Math.floor(Date.now() / 1000);
const lifetime = 15777000; // Apple's maximum: about 6 months
const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
const payload = { iss: teamId, iat: now, exp: now + lifetime, aud: 'https://appleid.apple.com', sub: servicesId };

const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
const signature = crypto.sign('sha256', Buffer.from(input), { key: fs.readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' });
console.log(`${input}.${b64u(signature)}`);
console.error(`\nExpires: ${new Date((now + lifetime) * 1000).toDateString()} — regenerate before then.`);
