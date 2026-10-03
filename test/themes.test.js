import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, C, applyTheme, findTheme, currentTheme } from '../src/theme.js';
import { logo } from '../src/logo.js';

const ROLES = ['neon', 'chart', 'lime', 'green', 'mid', 'deep', 'moss', 'dimg', 'gray', 'white', 'red', 'yellow', 'bar'];

test('ships Peridot plus the five requested themes', () => {
  assert.deepEqual(THEMES.map((t) => t.name), [
    'Peridot', 'Indigo Bridle Path', 'Galactic Neon Magenta', 'NYC Yellow', 'Seattle Blue', 'Cyan Atlantis',
  ]);
  for (const t of THEMES) {
    assert.deepEqual(Object.keys(t.palette).sort(), [...ROLES].sort(), `${t.name} has every color role`);
    for (const c of Object.values(t.palette)) {
      assert.ok(c.length === 3 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255));
    }
  }
});

test('the original Peridot palette is unchanged', () => {
  assert.deepEqual(THEMES[0].palette, {
    neon: [128, 255, 0], chart: [204, 255, 0], lime: [57, 255, 20], green: [0, 220, 60],
    mid: [34, 197, 94], deep: [24, 140, 60], moss: [110, 150, 90], dimg: [70, 110, 60],
    gray: [140, 160, 140], white: [235, 255, 235], red: [255, 90, 90], yellow: [255, 220, 90], bar: [10, 26, 8],
  });
});

test('themes resolve by id, full name, or unambiguous fragment', () => {
  assert.equal(findTheme('nyc-yellow').name, 'NYC Yellow');
  assert.equal(findTheme('NYC Yellow').name, 'NYC Yellow');
  assert.equal(findTheme('Galactic Neon Magenta').id, 'galactic-neon-magenta');
  assert.equal(findTheme('seattle').id, 'seattle-blue');
  assert.equal(findTheme('cyan').id, 'cyan-atlantis');
  assert.equal(findTheme('indigo').id, 'indigo-bridle-path');
  assert.equal(findTheme('nope'), null);
  assert.equal(findTheme(''), null);
});

test('applyTheme switches the live palette and recolors the wordmark', () => {
  const peridotLogo = logo();
  applyTheme('seattle-blue');
  assert.equal(currentTheme().id, 'seattle-blue');
  assert.deepEqual(C.neon, findTheme('seattle-blue').palette.neon);
  assert.notEqual(logo(), peridotLogo);
  applyTheme('does-not-exist');
  assert.equal(currentTheme().id, 'peridot', 'unknown themes fall back to Peridot');
  assert.equal(logo(), peridotLogo);
});
