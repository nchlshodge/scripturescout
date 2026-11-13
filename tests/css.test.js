// Keeps the stylesheet free of rules nothing uses. Dead styles make the file heavy and make real styles harder to find.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML } = require('./helpers');

const m = HTML.match(/<style>([\s\S]*?)<\/style>/);
const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
const rest = HTML.slice(0, m.index) + HTML.slice(m.index + m[0].length);

// Names built up in code (`badge-${level}` or 'badge-' + level) can't be searched for in full, so classes
// starting with those prefixes count as used.
const dynamicPrefixes = new Set([
  ...[...rest.matchAll(/([A-Za-z][\w-]*-)\$\{/g)].map(x => x[1]),
  ...[...rest.matchAll(/['"`]([A-Za-z][\w-]*-)['"`]\s*\+/g)].map(x => x[1]),
]);
const token = n => new RegExp('(?<![\\w-])' + n.replace(/[$()*+.?[\\\]^{|}-]/g, '\\$&') + '(?![\\w-])');
const used = n => token(n).test(rest) || [...dynamicPrefixes].some(p => n.startsWith(p));

function parse(text, ctx = '', out = []) {
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf('{', i); if (j < 0) break;
    const sel = text.slice(i, j).trim();
    let d = 1, k = j + 1;
    while (k < text.length && d > 0) { if (text[k] === '{') d++; else if (text[k] === '}') d--; k++; }
    const body = text.slice(j + 1, k - 1);
    if (/^@(media|supports)/.test(sel)) parse(body, ctx + sel + ' | ', out);
    else out.push({ sel, body, ctx });
    i = k;
  }
  return out;
}
const rules = parse(css);

test('every style rule is used by some element', () => {
  const dead = [];
  for (const r of rules) {
    if (r.sel.startsWith('@')) continue;
    const allDead = r.sel.split(',').every(part => {
      const core = part.replace(/:(?:not|is|where|has)\([^)]*\)/g, '');
      const classes = [...core.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(x => x[1]);
      const ids = [...core.matchAll(/#([A-Za-z_][\w-]*)/g)].map(x => x[1]);
      return classes.some(c => !used(c)) || ids.some(i => !used(i));
    });
    if (allDead) dead.push((r.ctx + r.sel).slice(0, 90));
  }
  assert.deepEqual(dead, []);
});

test('every animation that is defined is used', () => {
  const unused = rules.filter(r => r.sel.startsWith('@keyframes')).map(r => r.sel.split(/\s+/)[1])
    .filter(n => !new RegExp('animation[^;{}]*\\b' + n + '\\b').test(css) && !token(n).test(rest));
  assert.deepEqual(unused, []);
});

test('every colour/size variable that is defined is used', () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(x => x[1]));
  const unused = [...defined].filter(v => !new RegExp('var\\(\\s*' + v + '\\b').test(css + rest));
  assert.deepEqual(unused, []);
});

test('no animation is defined twice (the last one silently wins)', () => {
  const names = rules.filter(r => r.sel.startsWith('@keyframes')).map(r => r.sel.split(/\s+/)[1]);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});
