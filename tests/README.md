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
- `friends.test.js` checks the friends system: the Friends and Requests tabs, searching, sending, accepting and declining
  requests, and starting a direct chat. One test is marked "todo" for a known gap (invite links are never read).
- `challenges.test.js` checks challenges: sending, answering with the speed bonus, the result screen, the pop-up banner and
  the Challenges list (including that other players' text can't inject code).
- `daily-screens.test.js` checks the Daily Challenge screens: the hub and the home card, starting each game, scoring in
  all four daily games, saving results, and the results screen.
- `memory-trail.test.js` guards against leftovers of the removed Memory Trail game (it had been mislabelling a Challenge
  option and had unreachable code that saved scores under Trivia), checks every daily game saves only its own score,
  and fails if any function is left that nothing calls.
- `globals.test.js` finds names the code uses but never defines, which
  would throw an error the moment that code runs.
- `leaderboard.test.js` checks the Scripture Scout leaderboard's This Week / All Time and difficulty tabs.
- `css.test.js` keeps the stylesheet clean: no style rule, animation or variable that nothing uses, no animation
  defined twice, and no selector written twice.

They don't touch Supabase or any network. To add a test, put a `*.test.js` file in this folder.
- `contrast.test.js` measures text on gradients along the whole gradient (a plain colour check can't), and guards touch-target
  sizes and the chapter stars/hearts labels. Run against the old code it flags nine low-contrast buttons.
- `streak.test.js` checks the streak rules (consecutive days, Sabbath Rests, resets, daylight-saving-safe day maths) and offline
  credit: days played offline are remembered and applied in order when the connection returns, never twice, never to another account.
- `saves.test.js` checks the small saves that used to be fire-and-forget: notifications (create / mark read), turning push off,
  blocking, the challenge start time, and the under-13 account removal. Each is checked, retried once, and the person is told the truth.
- `minors.test.js` covers the limits for players aged 13-17: the app searches through the server function that leaves out players
  under 18, shows clear messages when the server refuses a chat or group add, and the migration keeps its guarantees. The database
  rules themselves were tested against the live tables when `minor_safety_migration.sql` was applied (inside a rolled-back transaction).
