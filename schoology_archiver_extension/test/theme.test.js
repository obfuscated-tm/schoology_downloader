// node --test test/*.test.js   (from schoology_archiver_extension/; "test/" alone doesn't work)
//
// overlays/theme.js is pure (no chrome.* at the top level besides ui.js's
// storage reads, which fail over to the extension-less defaults in tests),
// so themeCss() and preInvert() are checked directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, themeCss, preInvert } from '../overlays/theme.js';

test('schoology: no page changes at all', () => {
  assert.equal(themeCss('schoology'), '');
  assert.equal(themeCss('not-a-theme'), '');
});

test('a light theme colours the header and doesn\'t invert the page', () => {
  const css = themeCss('ocean');
  assert.match(css, /#header > header/);
  assert.match(css, new RegExp(THEMES.ocean.header));
  assert.doesNotMatch(css, /html \{ filter/);
});

test('a dark theme inverts the page and re-inverts real media', () => {
  const css = themeCss('dark');
  assert.match(css, /filter: invert\(1\) hue-rotate\(180deg\)/);
  assert.match(css, /:not\(picture\) > img/);
  assert.match(css, /iframe/);
  // The header is written pre-inverted, not as the colour it displays as.
  assert.doesNotMatch(css, new RegExp(THEMES.dark.header));
  assert.match(css, new RegExp(preInvert(THEMES.dark.header)));
});

test('midnight is dark too, with a gradient header pre-inverted stop by stop', () => {
  const css = themeCss('midnight');
  assert.match(css, /filter: invert\(1\)/);
  for (const stop of THEMES.midnight.header) assert.match(css, new RegExp(preInvert(stop)));
  assert.match(css, /linear-gradient\(90deg/);
});

test('a dark page: canvas and body pre-inverted, and no light rubber-band past the edges', () => {
  const t = THEMES.dracula, css = themeCss('dracula');
  assert.match(css, new RegExp(`html \\{[^}]*background: ${preInvert(t.page)}[^}]*overscroll-behavior: none`));
  assert.match(css, new RegExp(`body \\{ background: ${preInvert(t.page)}`));
});

test('the header covers Schoology\'s wrapped buttons (Courses, Groups, Apps, user menu)', () => {
  for (const key of ['ocean', 'sunset', 'nord']) {
    const css = themeCss(key);
    assert.match(css, /#header, #header > header \{/);
    assert.match(css, /nav > ul > li > div > :is\(a, button\)/);
    assert.match(css, /svg/);
  }
  assert.match(themeCss('rainbow'), /text-shadow/);
});

test('light themes with a page colour tint the page and its canvas', () => {
  assert.match(themeCss('sakura'), new RegExp(`html, body \\{ background: ${THEMES.sakura.page}`));
});

test('preInvert round-trips: applying the filter to it gives back the original colour', () => {
  // The filter is self-inverse, so applying it to preInvert(hex) once more
  // reproduces hex — check by comparing preInvert(preInvert(hex)) to hex.
  for (const hex of ['#24272B', '#16305C', '#FFFFFF', '#000000', '#1D5EA8', '#E7EFF8']) {
    const back = preInvert(preInvert(hex));
    const [r1, g1, b1] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
    const [r2, g2, b2] = [back.slice(1, 3), back.slice(3, 5), back.slice(5, 7)].map((h) => parseInt(h, 16));
    assert.ok(Math.abs(r1 - r2) <= 2, `${hex} r: ${r1} vs ${r2}`);
    assert.ok(Math.abs(g1 - g2) <= 2, `${hex} g: ${g1} vs ${g2}`);
    assert.ok(Math.abs(b1 - b2) <= 2, `${hex} b: ${b1} vs ${b2}`);
  }
});

test('every theme has a name and an accent', () => {
  for (const [key, t] of Object.entries(THEMES)) {
    assert.equal(typeof t.name, 'string', key);
    assert.match(t.accent, /^#[0-9a-fA-F]{6}$/, key);
    assert.match(t.accentSoft, /^#[0-9a-fA-F]{6}$/, key);
  }
  assert.equal(THEMES.schoology.header, null);
});
