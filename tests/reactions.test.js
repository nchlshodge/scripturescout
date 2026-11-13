// Emoji reactions on chat messages: the long-press menu, adding and removing a reaction, how reactions are shown,
// and that the chat refreshes when they change.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadApp, get, fakeIntervals, fakeTimeouts } = require('./helpers');

const ME = 'me-1', THEM = 'them-2', OTHER = 'other-3';
const EMOJIS = ['👍', '🔥', '🙏', '❤️', '😮', '🎉'];

function setup({ status = {}, existing = [], lookupFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    const key = Object.keys(status).find(k => u.includes(k));
    const st = key ? status[key] : 200;
    return { ok: st >= 200 && st < 300, status: st, json: async () => [], text: async () => '' };
  };
  const app = loadApp({ fetchImpl });
  const w = app.window;
  const timeouts = fakeTimeouts(w);
  const intervals = fakeIntervals(w);
  w.__existing = existing; w.__lookupFails = lookupFails;
  w.eval(`
    currentUser = { id: '${ME}' }; authToken = 't'; currentUsername = 'Me';
    globalThis.sbFetch = async (p) => {
      if (window.__lookupFails) throw new Error('offline');
      if (p.startsWith('message_reactions?message_id=eq.')) return window.__existing;
      return [];
    };
    globalThis.__refreshed = 0;
    window._refreshConversation = async () => { __refreshed++; };
  `);
  const toasts = () => [...w.document.body.children].filter(c => c.getAttribute('role') === 'status').map(c => c.textContent);
  return { ...app, calls, timeouts, intervals, toasts, writes: () => calls.filter(c => c.method !== 'GET') };
}

const addBubble = (w, id, sender, text = 'hi') =>
  w.document.body.insertAdjacentHTML('beforeend', `<div class="msg-bubble" data-msg-id="${id}" data-sender="${sender}" data-sname="X">${text}</div>`);
const picker = w => w.document.getElementById('reactionPicker');

// ── The reaction menu ──────────────────────────────────

test('the menu offers the six reactions in order', () => {
  const s = setup(); addBubble(s.window, 1, THEM);
  get(s.window, 'showReactionPicker')(1);
  const shown = [...picker(s.window).querySelectorAll('span')].map(e => e.textContent);
  assert.deepEqual(shown, EMOJIS);
  s.close();
});

test('every reaction fits the database limit of 16 characters and none repeat', () => {
  const list = get(loadApp().window, 'EMOJI_REACTIONS');
  assert.equal(new Set(list).size, list.length);
  for (const e of list) assert.ok(e.length >= 1 && [...e].length <= 16, e);
  const sql = fs.readFileSync(path.join(ROOT, 'message_reactions_migration.sql'), 'utf8');
  assert.match(sql, /char_length\(emoji\) between 1 and 16/);
  assert.match(sql, /unique \(message_id, user_id, emoji\)/);
});

test('picking a reaction from the menu reacts to that message and closes the menu', async () => {
  const s = setup(); addBubble(s.window, 7, THEM);
  get(s.window, 'showReactionPicker')(7);
  [...picker(s.window).querySelectorAll('span')][1].click();          // 🔥
  await new Promise(r => setImmediate(r));
  assert.equal(picker(s.window), null);
  const post = s.writes().find(c => c.method === 'POST');
  assert.equal(post.body.message_id, 7);
  assert.equal(post.body.emoji, '🔥');
  s.close();
});

test('only one menu is open at a time', () => {
  const s = setup(); addBubble(s.window, 1, THEM); addBubble(s.window, 2, THEM);
  get(s.window, 'showReactionPicker')(1);
  get(s.window, 'showReactionPicker')(2);
  assert.equal(s.window.document.querySelectorAll('#reactionPicker').length, 1);
  s.close();
});

test('the menu closes by itself (3 s on your own message, 5 s when it has a Report button)', () => {
  const s = setup(); addBubble(s.window, 1, ME); addBubble(s.window, 2, THEM);
  get(s.window, 'showReactionPicker')(1);
  s.timeouts.advance(2900); assert.ok(picker(s.window));
  s.timeouts.advance(200);  assert.equal(picker(s.window), null);
  get(s.window, 'showReactionPicker')(2);
  s.timeouts.advance(4900); assert.ok(picker(s.window));
  s.timeouts.advance(200);  assert.equal(picker(s.window), null);
  s.close();
});

// ── Adding and removing ────────────────────────────────

test('reacting for the first time adds a reaction as you, then refreshes the chat', async () => {
  const s = setup();
  await get(s.window, 'toggleReaction')(5, '❤️');
  const post = s.writes()[0];
  assert.equal(post.method, 'POST');
  assert.ok(post.url.endsWith('/rest/v1/message_reactions'));
  assert.deepEqual(post.body, { message_id: 5, user_id: ME, username: 'Me', emoji: '❤️' });
  assert.equal(s.window.__refreshed, 1);
  s.close();
});

test('tapping a reaction you already gave removes it', async () => {
  const s = setup({ existing: [{ id: 99 }] });
  await get(s.window, 'toggleReaction')(5, '❤️');
  const del = s.writes()[0];
  assert.equal(del.method, 'DELETE');
  assert.ok(del.url.endsWith('/rest/v1/message_reactions?id=eq.99'));
  assert.equal(s.window.__refreshed, 1);
  s.close();
});

test('a failed save tells the player and does not refresh', async () => {
  const s = setup({ status: { '/rest/v1/message_reactions': 500 } });
  await get(s.window, 'toggleReaction')(5, '🎉');
  assert.ok(s.toasts().some(t => /Could not save your reaction/.test(t)));
  assert.equal(s.window.__refreshed, 0);
  s.close();
});

test('if the connection drops while reacting, the player is told instead of nothing happening', async () => {
  const s = setup({ lookupFails: true });
  await assert.doesNotReject(get(s.window, 'toggleReaction')(5, '🎉'));
  assert.ok(s.toasts().some(t => /Could not save your reaction/.test(t)));
  assert.equal(s.writes().length, 0);
  s.close();
});

// ── How reactions are shown ────────────────────────────

async function openChat({ messages, reactions }) {
  const app = loadApp(); const w = app.window;
  const intervals = fakeIntervals(w);
  w.__msgs = messages; w.__rx = reactions;
  w.eval(`
    currentUser = { id: '${ME}' }; authToken = 't'; currentUsername = 'Me';
    globalThis.sbFetch = async (p) => p.startsWith('messages?') ? window.__msgs : p.startsWith('message_reactions?') ? window.__rx : [];
  `);
  await get(w, 'openConversation')('c1', 'Chat', 'direct');
  return { ...app, intervals, poll: async () => { intervals.tick(); await new Promise(r => setTimeout(r, 15)); } };
}
const msg = (id, sender, content = 'hello') => ({ id, conversation_id: 'c1', sender_id: sender, content, type: 'text', data: { username: 'U' }, created_at: new Date().toISOString() });
const rx = (id, message_id, user_id, emoji) => ({ id, message_id, user_id, emoji, username: 'U' });
const chips = (w, msgId) => [...w.document.querySelector(`.msg-bubble[data-msg-id="${msgId}"]`).parentElement.querySelectorAll('.reaction-chip')];

test('reactions show as chips with a count, grouped by emoji', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [rx(1, 1, THEM, '👍'), rx(2, 1, OTHER, '👍'), rx(3, 1, OTHER, '🔥')] });
  const texts = chips(c.window, 1).map(x => x.textContent.trim().replace(/\s+/g, ' '));
  assert.deepEqual(texts.sort(), ['👍 2', '🔥 1']);
  c.close();
});

test('your own reactions are highlighted, other people\'s are not', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [rx(1, 1, ME, '🙏'), rx(2, 1, THEM, '🔥')] });
  const mine = Object.fromEntries(chips(c.window, 1).map(x => [x.textContent.trim().startsWith('🙏') ? 'prayer' : 'fire', x.classList.contains('mine')]));
  assert.equal(mine.prayer, true); assert.equal(mine.fire, false);
  c.close();
});

test('a message with no reactions shows no chips', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [] });
  assert.equal(chips(c.window, 1).length, 0);
  c.close();
});

test('reactions stay with their own message', async () => {
  const c = await openChat({ messages: [msg(1, THEM), msg(2, OTHER)], reactions: [rx(1, 2, ME, '🎉')] });
  assert.equal(chips(c.window, 1).length, 0);
  assert.equal(chips(c.window, 2).length, 1);
  c.close();
});

test('tapping a chip reacts with that emoji', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [rx(1, 1, THEM, '❤️')] });
  const calls = [];
  c.window.eval(`globalThis.toggleReaction = (id, e) => { (window.__t = window.__t || []).push([id, e]); }`);
  chips(c.window, 1)[0].click();
  assert.equal(JSON.stringify(c.window.__t), JSON.stringify([[1, '❤️']]));
  c.close();
});

test('reactions on a hidden (blocked) person\'s message are not shown', async () => {
  const c = await openChat({ messages: [msg(1, THEM), msg(2, OTHER)], reactions: [] });
  c.window.eval(`blockedUserIds = new Set(['${THEM}'])`);
  c.window.__rx = [rx(1, 1, OTHER, '🔥'), rx(2, 2, OTHER, '🔥')];
  await c.window.eval(`window._refreshConversation()`);
  assert.equal(c.window.document.querySelector('.msg-bubble[data-msg-id="1"]'), null);
  assert.equal(chips(c.window, 2).length, 1);
  c.close();
});

// ── Refreshing ─────────────────────────────────────────

test('the 5-second refresh leaves the screen (and a half-typed message) alone when nothing changed', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [rx(1, 1, THEM, '👍')] });
  const input = c.window.document.getElementById('msgInput'); input.value = 'half-typed'; 
  const bubbleBefore = c.window.document.querySelector('.msg-bubble');
  await c.poll();
  assert.equal(c.window.document.querySelector('.msg-bubble'), bubbleBefore, 'not rebuilt');
  assert.equal(c.window.document.getElementById('msgInput').value, 'half-typed');
  c.close();
});

test('a new reaction from someone else appears on the next refresh, keeping the typed text', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [] });
  c.window.document.getElementById('msgInput').value = 'still typing';
  c.window.__rx = [rx(1, 1, OTHER, '🔥')];
  await c.poll();
  assert.equal(chips(c.window, 1).length, 1);
  assert.equal(c.window.document.getElementById('msgInput').value, 'still typing');
  c.close();
});

test('a reaction removed by someone else disappears on the next refresh', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [rx(1, 1, OTHER, '🔥')] });
  assert.equal(chips(c.window, 1).length, 1);
  c.window.__rx = [];
  await c.poll();
  assert.equal(chips(c.window, 1).length, 0);
  c.close();
});

test('swapping one reaction for another is noticed even though the count is unchanged', async () => {
  const c = await openChat({ messages: [msg(1, THEM)], reactions: [rx(1, 1, OTHER, '🔥')] });
  c.window.__rx = [rx(2, 1, OTHER, '🎉')];
  await c.poll();
  assert.equal(chips(c.window, 1)[0].textContent.trim().startsWith('🎉'), true);
  c.close();
});

// ── Long press and right-click ─────────────────────────

function gestureSetup() {
  const s = setup();
  const w = s.window; let vibrated = 0;
  Object.defineProperty(w.navigator, 'vibrate', { value: () => { vibrated++; return true; }, configurable: true });
  addBubble(w, 3, THEM, 'press me');
  const bubble = w.document.querySelector('.msg-bubble');
  const ev = (type, target, props = {}) => {
    const e = new w.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10, ...props });
    target.dispatchEvent(e); return e;
  };
  return { ...s, bubble, ev, vibrated: () => vibrated };
}

test('holding a message for half a second opens the menu (with a small buzz)', () => {
  const g = gestureSetup();
  g.ev('pointerdown', g.bubble);
  g.timeouts.advance(499); assert.equal(picker(g.window), null, 'not yet');
  g.timeouts.advance(2);   assert.ok(picker(g.window));
  assert.equal(g.vibrated(), 1);
  g.close();
});

test('a quick tap does not open the menu', () => {
  const g = gestureSetup();
  g.ev('pointerdown', g.bubble); g.timeouts.advance(200); g.ev('pointerup', g.bubble); g.timeouts.advance(1000);
  assert.equal(picker(g.window), null);
  g.close();
});

test('dragging more than 10 pixels (scrolling) cancels the hold', () => {
  const g = gestureSetup();
  g.ev('pointerdown', g.bubble, { clientX: 10, clientY: 10 });
  g.ev('pointermove', g.bubble, { clientX: 10, clientY: 40 });
  g.timeouts.advance(1000);
  assert.equal(picker(g.window), null);
  g.close();
});

test('a tiny wobble while holding is fine', () => {
  const g = gestureSetup();
  g.ev('pointerdown', g.bubble, { clientX: 10, clientY: 10 });
  g.ev('pointermove', g.bubble, { clientX: 14, clientY: 13 });
  g.timeouts.advance(600);
  assert.ok(picker(g.window));
  g.close();
});

test('moving the finger off the bubble cancels the hold', () => {
  const g = gestureSetup();
  g.ev('pointerdown', g.bubble); g.timeouts.advance(300); g.ev('pointerleave', g.bubble); g.timeouts.advance(1000);
  assert.equal(picker(g.window), null);
  g.close();
});

test('right-clicking a message opens the menu and suppresses the browser menu', () => {
  const g = gestureSetup();
  const e = g.ev('contextmenu', g.bubble, { button: 2 });
  assert.equal(e.defaultPrevented, true);
  assert.ok(picker(g.window));
  g.close();
});

test('pressing the right mouse button does not start the long-press timer', () => {
  const g = gestureSetup();
  g.ev('pointerdown', g.bubble, { button: 2 }); g.timeouts.advance(1000);
  assert.equal(picker(g.window), null);
  g.close();
});

test('pressing elsewhere in the app does nothing', () => {
  const g = gestureSetup();
  const other = g.window.document.createElement('div'); g.window.document.body.appendChild(other);
  g.ev('pointerdown', other); g.timeouts.advance(1000); g.ev('contextmenu', other, { button: 2 });
  assert.equal(picker(g.window), null);
  g.close();
});
