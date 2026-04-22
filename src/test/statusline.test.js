'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { composeStatuslineIcon } = require('../statusline_helper.js');

test('composeStatuslineIcon returns bare icon without pressure flag', () => {
  assert.equal(composeStatuslineIcon('compact', false), '◐');
});

test('composeStatuslineIcon prepends ⚡ when pressure flag set', () => {
  assert.equal(composeStatuslineIcon('compact', true), '⚡◐');
});

test('composeStatuslineIcon falls back to · on unknown level', () => {
  assert.equal(composeStatuslineIcon('unknown', false), '·');
  assert.equal(composeStatuslineIcon('unknown', true), '⚡·');
});
