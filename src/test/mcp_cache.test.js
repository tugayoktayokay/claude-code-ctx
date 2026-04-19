'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const cache  = require('../mcp_cache.js');

test('writeCache + readCache round-trip', () => {
  const big = 'line\n'.repeat(10000);
  const w = cache.writeCache(big);
  assert.match(w.ref, /^[a-f0-9]{12}$/);
  const r1 = cache.readCache(w.ref, { offset: 0, limit: 100 });
  assert.equal(r1.total, big.length);
  assert.equal(r1.returned, 100);
  const r2 = cache.readCache(w.ref, { offset: big.length - 5, limit: 100 });
  assert.equal(r2.returned, 5);
  try { fs.unlinkSync(w.path); } catch {}
  try { fs.unlinkSync(w.path + '.meta'); } catch {}
});

test('readCache not-found returns error', () => {
  const r = cache.readCache('nonexistent123');
  assert.equal(r.error, 'not-found');
});

test('summarizeLines compresses long output with head/tail', () => {
  const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const s = cache.summarizeLines(content, { head: 5, tail: 3 });
  assert.match(s, /line 0/);
  assert.match(s, /line 499/);
  assert.match(s, /more lines omitted/);
  assert.doesNotMatch(s, /line 250/);
});

test('summarizeLines passes short content unchanged', () => {
  const s = cache.summarizeLines('only a line');
  assert.equal(s, 'only a line');
});
