'use strict';

const test       = require('node:test');
const assert     = require('node:assert/strict');
const path       = require('path');
const { parseJSONL, extractText, encodeCwd } = require('../session.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo-session.jsonl');

test('parseJSONL reads every non-empty line', () => {
  const entries = parseJSONL(FIXTURE);
  assert.ok(entries.length >= 10, 'expected at least 10 entries');
  assert.equal(entries[0].type, 'user');
});

test('extractText handles string, array blocks, and empty', () => {
  assert.equal(extractText('hello'), 'hello');
  assert.equal(extractText([{ text: 'a' }, { text: 'b' }]), 'a b');
  assert.equal(extractText(null), '');
});

test('encodeCwd matches Claude Code project dir format', () => {
  assert.equal(encodeCwd('/Users/foo/bar'), '-Users-foo-bar');
  assert.equal(encodeCwd('/Users/foo/apps/Ik Kolay'), '-Users-foo-apps-Ik-Kolay');
});
