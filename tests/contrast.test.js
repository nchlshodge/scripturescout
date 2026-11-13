// Colour contrast and touch-target guards for text on gradients, which a plain "text colour vs background colour"
// check can't judge: the text has to read against every point of the gradient, not just one end.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, loadApp, get } = require('./helpers');

const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = hex => { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);

const style = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
const vars = {};
for (const m of style.matchAll(/(--[a-z-]+):\s*(linear-gradient\([^;]*\))\s*;/g)) vars[m[1]] = m[2];
const resolve = v => v.replace(/var\((--[a-z-]+)\)/g, (_, n) => vars[n] || 'UNKNOWN');

// Every place a hex-coloured gradient and a text colour are set together: CSS rules and inline style="" attributes.
function pairs() {
  const found = [];
  const check = (where, decls) => {
    if (/background-clip:\s*text/.test(decls)) return;
    const bg = resolve(decls).match(/background(?:-image)?:\s*[^;]*?linear-gradient\(([^;]*)\)/);
    const fg = decls.match(/(?:^|[;\s])color:\s*(#[0-9a-f]{3,6}|white)\b/i);
    if (!bg || !fg) return;
    const stops = [...bg[1].matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map(m => rgb(m[0]));
    if (stops.length < 2 || /rgba/.test(bg[1])) return;
    const size = (decls.match(/font-size:\s*([\d.]+)(px|rem)/) || []);
    const px = size[1] ? parseFloat(size[1]) * (size[2] === 'rem' ? 16 : 1) : 14;
    const bold = /font-weight:\s*(700|800|bold)/.test(decls);
    found.push({ where, fg: rgb(fg[1].toLowerCase() === 'white' ? '#ffffff' : fg[1]), stops, large: px >= 24 || (px >= 18.66 && bold) });
  };
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) check(m[1].trim().slice(0, 50), m[2]);
  for (const m of HTML.matchAll(/style="([^"]*)"/g)) check('inline: ' + m[1].slice(0, 50), m[1]);
  return found;
}

test('text on a gradient reads clearly along the whole gradient (4.5:1, or 3:1 for large text)', () => {
  const all = pairs();
  assert.ok(all.length > 15, `found ${all.length} gradient+text pairs, the scan may have broken`);
  const bad = [];
  for (const p of all) {
    let worst = 99;
    for (let i = 0; i < p.stops.length - 1; i++) for (let t = 0; t <= 10; t++) worst = Math.min(worst, ratio(p.fg, mix(p.stops[i], p.stops[i + 1], t / 10)));
    if (worst < (p.large ? 3 : 4.5)) bad.push(`${worst.toFixed(2)}:1  ${p.where}`);
  }
  assert.deepEqual(bad, []);
});

test('the shared green button gradient works with white text', () => {
  const g = vars['--grad-action'];
  assert.ok(g, 'defined');
  const stops = [...g.matchAll(/#[0-9a-f]{6}/gi)].map(m => rgb(m[0]));
  for (let t = 0; t <= 10; t++) assert.ok(ratio([255, 255, 255], mix(stops[0], stops[1], t / 10)) >= 4.5);
  assert.doesNotMatch(HTML, /#4A7C59,\s*#3BBFA0\)[^;"]*(?:color:\s*white|;\s*margin)/i, 'the old light gradient is not used behind text');
});

test('buttons that use the shared green gradient set their own text colour (the default button text is dark brown)', () => {
  for (const id of ['fitbCheckBtn', 'challengeCheckBtn', 'dailyMIACheckBtn']) {
    const tag = HTML.match(new RegExp(`id="${id}"[^>]*>`))[0];
    assert.match(tag, /var\(--grad-action\)/);
    assert.match(tag, /color:#fff/);
  }
});

test('the story buttons use the book\'s dark gold-on-brown style, not a light gold gradient', () => {
  for (const id of ['storyTypeSubmit', 'storyVerseSubmitBtn', 'storyCheckBlanksBtn', 'nextRoundBtn']) {
    const tag = HTML.match(new RegExp(`id="${id}"[^>]*>`))[0];
    assert.doesNotMatch(tag, /#c8941a/, `${id} still has the light gradient`);
  }
});

test('fill-in-the-blank slots are at least 44 pixels tall', () => {
  assert.match(style, /\.blank-word \{[^}]*min-height:\s*44px/);
});

test('the sign-in and create-account tabs are at least 44 pixels tall', () => {
  const tabs = [...HTML.matchAll(/<button onclick="renderAuthScreen\('(?:login|signup)'\)" style="([^"]*)"/g)];
  assert.equal(tabs.length, 2);
  for (const t of tabs) assert.match(t[1], /min-height:44px/);
});

test('links on the sign-in screen follow the theme instead of a fixed brown that vanishes in dark mode', () => {
  assert.match(style, /\.auth-link \{[^}]*color:var\(--nav-active\)/);
});

test('chapter-complete stars are gold on the parchment page in both themes, and read out as a count', () => {
  assert.match(style, /\.story-stars \{[^}]*color:#8a5a00/);
  assert.match(HTML, /class="story-stars" role="img" aria-label="\$\{stars\} of 3 stars"/);
  assert.ok(ratio(rgb('#8a5a00'), rgb('#f5e8c8')) >= 3, 'stars stand out from the page');
});

test('the hearts row is announced as a plain count and stays in step as hearts are lost', () => {
  const { window, close } = loadApp();
  const el = window.document.createElement('div');
  get(window, 'setStoryHearts')(el, 2);
  assert.equal(el.getAttribute('role'), 'img');
  assert.equal(el.getAttribute('aria-label'), '2 of 3 hearts left');
  assert.equal(el.textContent, '❤️❤️🖤');
  get(window, 'setStoryHearts')(el, 0);
  assert.equal(el.getAttribute('aria-label'), '0 of 3 hearts left');
  assert.match(HTML, /class="story-hearts" role="img" aria-label="\$\{currentHearts\} of 3 hearts left"/);
  close();
});
