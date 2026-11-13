# Tests

Run with `npm test` (also runs automatically on every push via GitHub Actions).

- `app.test.js` loads the real `index.html` in a fake browser (jsdom) and checks the app's own functions:
  HTML escaping, the profanity filter, the 13+ age check, failed-save retries and messages, icons.
- `static.test.js` reads the source and checks things that have broken before: every button handler points at a
  real function, no `${...}` leaking into plain strings, the Content Security Policy, no secret keys, required
  files, and that the privacy policy covers what the app does.

- `daily.test.js` checks the Daily Challenge dates with a fake clock in several time zones: the day key, per-day
  completion, the daily topic (including daylight-saving and year boundaries), the leaderboard's day window and
  the overnight cache refresh.
- `story.test.js` checks Story Mode progress: saving chapters and stars (with retry), loading progress, the
  "Continue" card, which chapters are open or locked, and that progress is cleared on sign-out.
- `hearts.test.js` checks the Story Mode hearts: losing and refilling hearts on a fake clock, the Out of Hearts screen and
  its countdown, damaged saved data, and that the countdown timer stops when the player leaves.
- `moderation.test.js` checks chat moderation: the word filter (and that the database copy matches it), sending and
  refused messages, masked display, blocking and unblocking, and reporting users and messages.
- `reactions.test.js` checks chat reactions: the long-press and right-click menu, adding and removing a reaction,
  how chips are shown and highlighted, and that the chat refreshes (without losing typed text) when reactions change.

They don't touch Supabase or any network. To add a test, put a `*.test.js` file in this folder.
