# Sign in with Apple — setup

The app side is ready. Until the steps below are done, `APPLE_SIGNIN_ENABLED` in `index.html` stays
`false`, and the **Google button is hidden in the iPhone app** (Apple requires Sign in with Apple
whenever Google sign-in is offered — guideline 4.8). Web and Android are unaffected.

How it works: the Apple button uses the same browser hand-off as Google (Supabase OAuth, returning
to the app through `scripturescout://auth-callback`). No extra iOS plugin or Xcode capability is needed.

## 1. Apple Developer account (needs the paid Developer Program)
1. **Identifiers → App IDs →** `com.scripturescout.app`: tick **Sign in with Apple**, save.
2. **Identifiers → Services IDs → +**: create one, e.g. `com.scripturescout.signin`.
   Tick **Sign in with Apple → Configure**:
   - Primary App ID: `com.scripturescout.app`
   - Domains: `xzkxigwzoznefywsiwmb.supabase.co`
   - Return URL: `https://xzkxigwzoznefywsiwmb.supabase.co/auth/v1/callback`
3. **Keys → +**: name it, tick **Sign in with Apple**, configure → primary App ID above. Register and
   **download the `.p8` file once** (Apple won't show it again). Note the **Key ID**.
4. Note your **Team ID** (Membership details).

## 2. Make the client secret
Apple's "secret" is a signed token that **expires after 6 months**.
```bash
node scripts/apple-client-secret.js <TEAM_ID> <KEY_ID> <SERVICES_ID> path/to/AuthKey_XXXXXXXX.p8
```
Copy the long token it prints. **Put a calendar reminder at ~5 months** to regenerate it and paste it
into Supabase again, or Apple sign-in will silently stop working. Don't commit the `.p8` or the token.

## 3. Supabase (Dashboard → Authentication)
- **Providers → Apple:** enable. Client IDs: `com.scripturescout.signin` (the Services ID; you can also
  add `com.scripturescout.app`). Secret key: the token from step 2.
- **URL Configuration → Redirect URLs:** make sure `scripturescout://auth-callback` and your web app URL
  are listed (they should already be, from Google sign-in).

## 4. Turn it on
Set `const APPLE_SIGNIN_ENABLED = true;` in `index.html`, then rebuild the iOS app
(`npm run cap:ios`). Both buttons then appear on every platform, Apple first.

## 5. Test (on a real iPhone, via TestFlight)
- New Apple account → lands in the app, age prompt appears, username prompt appears.
- Sign out, sign in again with Apple → straight in.
- "Hide My Email" option works (the account email will be a privaterelay address).
- Delete account works (see below).

## Still to do after it works
- **Revoke Apple tokens on account deletion.** Apple requires apps with Sign in with Apple to revoke
  the user's Apple token when they delete their account. Not built yet: it needs the user's Apple
  refresh token saved at sign-in and a call to `https://appleid.apple.com/auth/revoke` from the
  `delete-account` function.
- Update `privacy.html`: it says Apple sign-in is "in the future" — change to present tense.
- Mention Sign in with Apple in the App Store review notes.
