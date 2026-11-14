// Leaderboard names for players under 18: the database replaces their name with an alias ("Scout 7F3A"); the app
// shows it as is, marks your own row, and explains why. The SQL is also checked for its guarantees.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadApp, get } = require('./helpers');

const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const ME = 'me-1';
const SQL = fs.readFileSync(path.join(ROOT, 'leaderboard_names_migration.sql'), 'utf8');

function setup({ me = ME, rows = {} } = {}) {
  const app = loadApp();
  const w = app.window;
  w.__rows = rows;
  w.eval(`
    globalThis.renderAuthScreen = () => {}; globalThis.checkMonthlyChampion = () => {};
    ${me ? `currentUser = { id: '${me}' }; currentUsername = 'RealMe';` : 'currentUser = null;'}
    globalThis.sbFetch = async (p) => {
      if (p.startsWith('leaderboard?select=*')) return window.__rows.scout || [];
      const t = p.split('?')[0];
      if (window.__rows[t]) return window.__rows[t];
      return [];
    };
  `);
  return { ...app, w, call: (n, ...a) => get(w, n)(...a), root: () => w.document.getElementById('root') };
}
const r = (name, user_id, score = 100) => ({ name, user_id, score });

// ── Display name rules ───────────────────────────────────

test('other players\' names show exactly as stored, including aliases', () => {
  const s = setup();
  assert.equal(s.call('lbDisplayName', r('Pat', 'u2')), 'Pat');
  assert.equal(s.call('lbDisplayName', r('Scout 7F3A', 'u2')), 'Scout 7F3A');
  s.close();
});

test('your own aliased row is marked "(you)" so you can find yourself', () => {
  const s = setup();
  assert.equal(s.call('lbDisplayName', r('Scout 7F3A', ME)), 'Scout 7F3A (you)');
  assert.equal(s.call('lbDisplayName', r('RealMe', ME)), 'RealMe', 'adults are not relabelled');
  s.close();
});

test('only a real alias is treated as one: lookalikes and guests are shown as they are', () => {
  const s = setup();
  for (const n of ['Scout 7f3a', 'Scout 7F3', 'Scout 7F3AA', 'scout 7F3A', 'Scout  7F3A', 'Scout 7F3G', 'Scout']) {
    assert.equal(s.call('lbDisplayName', r(n, ME)), n, n);
  }
  assert.equal(s.call('lbDisplayName', r('Scout 7F3A', null)), 'Scout 7F3A', 'guest row');
  s.close();
});

test('the name can come from any of the three name columns, with a fallback', () => {
  const s = setup();
  assert.equal(s.call('lbDisplayName', { player_name: 'Quinn', user_id: 'u9' }), 'Quinn');
  assert.equal(s.call('lbDisplayName', { username: 'Rae', user_id: 'u9' }), 'Rae');
  assert.equal(s.call('lbDisplayName', { user_id: 'u9' }), 'Scout');
  assert.equal(s.call('lbDisplayName', { player_name: 'Scout 0A1B', user_id: ME }), 'Scout 0A1B (you)');
  s.close();
});

test('signed out, nobody is marked as "you"', () => {
  const s = setup({ me: null });
  assert.equal(s.call('lbDisplayName', r('Scout 7F3A', ME)), 'Scout 7F3A');
  assert.equal(s.call('lbAliasNote', [r('Scout 7F3A', ME)]), '');
  s.close();
});

test('the explanation appears only when your own row is aliased', () => {
  const s = setup();
  assert.match(s.call('lbAliasNote', [r('Pat', 'u2'), r('Scout 7F3A', ME)]), /Your name is hidden from other players/);
  assert.equal(s.call('lbAliasNote', [r('Scout 7F3A', 'u2'), r('RealMe', ME)]), '', 'someone else\'s alias, or an adult row');
  assert.equal(s.call('lbAliasNote', []), '');
  s.close();
});

// ── On screen ────────────────────────────────────────────

test('the main leaderboard shows aliases, your own row with "(you)", the explanation, and escapes names', async () => {
  const s = setup({ rows: { scout: [r('Pat', 'u2', 900), r('Scout 3C37', 'u3', 800), r('Scout 9D10', ME, 700), r('<b>x</b>', 'u4', 600)] } });
  s.w.eval(`lbFilter = 'easy'; lbView = 'alltime';`);
  await s.call('renderLeaderboard');
  await wait();
  const names = [...s.root().querySelectorAll('.lb-name')].map(e => e.textContent.trim());
  assert.deepEqual(names, ['Pat', 'Scout 3C37', 'Scout 9D10 (you)', '<b>x</b>']);
  assert.equal(s.root().querySelectorAll('.lb-name b').length, 0, 'names are text, not markup');
  assert.match(s.root().textContent, /Your name is hidden from other players/);
  s.close();
});

test('an adult sees no explanation and no "(you)"', async () => {
  const s = setup({ rows: { scout: [r('RealMe', ME, 900), r('Scout 3C37', 'u3', 800)] } });
  s.w.eval(`lbFilter = 'easy'; lbView = 'alltime';`);
  await s.call('renderLeaderboard');
  await wait();
  assert.deepEqual([...s.root().querySelectorAll('.lb-name')].map(e => e.textContent.trim()), ['RealMe', 'Scout 3C37']);
  assert.doesNotMatch(s.root().textContent, /Your name is hidden/);
  s.close();
});

test('the per-game leaderboards use the same rules (trivia keeps its name in player_name)', async () => {
  const s = setup({ rows: { leaderboard_trivia: [{ player_name: 'Scout 1A2B', user_id: ME, score: 500, correct: 5 }, { player_name: 'Scout 3C4D', user_id: 'u2', score: 400, correct: 4 }, { player_name: 'Quinn', user_id: 'u3', score: 300, correct: 3 }] } });
  await s.call('renderGameLeaderboard', 'Bible Trivia', 'leaderboard_trivia', ['easy'], { easy: 'Easy' }, 'easy');
  await wait(60);
  const names = [...s.root().querySelectorAll('.game-lb-name')].map(e => e.textContent.trim());
  assert.deepEqual(names, ['Scout 1A2B (you)', 'Scout 3C4D', 'Quinn']);
  assert.match(s.root().textContent, /Your name is hidden/);
  s.close();
});

// ── The migration keeps its guarantees ───────────────────

test('every leaderboard table masks names on insert and update', () => {
  for (const t of ['leaderboard', 'leaderboard_daily', 'leaderboard_memory', 'leaderboard_mia', 'leaderboard_track', 'leaderboard_trivia']) {
    assert.match(SQL, new RegExp(`create trigger trg_mask_minor_name before insert or update on public\\.${t}\\s`), t);
    assert.match(SQL, new RegExp(`drop trigger if exists trg_mask_minor_name on public\\.${t};`), t);
  }
});

test('the trigger masks only players with an account who are under 18, and covers both trivia name columns', () => {
  assert.match(SQL, /if new\.user_id is null then return new; end if;/, 'guests untouched');
  assert.match(SQL, /if public\.is_minor\(new\.user_id\) then/);
  assert.match(SQL, /new\.player_name := public\.minor_display_name\(new\.user_id\);\s*new\.username := public\.minor_display_name\(new\.user_id\);/);
  assert.match(SQL, /'Scout ' \|\| upper\(substr\(md5\(p_user::text\), 1, 4\)\)/);
});

test('names are re-synced when the age answer is saved or the username changes, and for everyone once', () => {
  assert.match(SQL, /after insert or update on public\.age_checks/);
  assert.match(SQL, /after update of username on public\.profiles/);
  assert.match(SQL, /select public\.resync_leaderboard_names\(p\.id\) from public\.profiles p;/);
  assert.match(SQL, /update public\.leaderboard_trivia set player_name = shown, username = shown/);
});

test('none of the helpers can be called from the app', () => {
  for (const f of ['resync_leaderboard_names(uuid)', 'mask_minor_leaderboard_name()', 'resync_names_after_age_check()', 'resync_names_after_rename()']) {
    assert.match(SQL, new RegExp(`revoke all on function public\\.${f.replace(/[()]/g, '\\$&')} from public, anon, authenticated`), f);
  }
  assert.doesNotMatch(SQL, /grant execute/i);
  assert.match(SQL, /security definer set search_path = public/);
});

test('the privacy policy explains the alias', () => {
  const p = fs.readFileSync(path.join(ROOT, 'privacy.html'), 'utf8');
  assert.match(p, /replaced by an alias such as "Scout 7F3A"/);
  assert.match(p, /once they are confirmed to be 18 or older/);
});
