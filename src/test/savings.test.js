'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateSavings, tokensForBytes } = require('../savings.js');

test('tokensForBytes uses rough 4 bytes per token estimate', () => {
  assert.equal(tokensForBytes(4000), 1000);
});

test('estimateSavings combines cache hit bytes and working memory saved bytes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-savings-'));
  const log = path.join(tmp, 'hooks.log');
  fs.writeFileSync(log, [
    '2026-05-18T10:00:00.000Z cache-write ref=abc bytes=4000',
    '2026-05-18T10:01:00.000Z cache-read ref=abc result=hit bytes=1000',
    '2026-05-18T10:02:00.000Z working_memory action=dedup_hit session=s path="/a" prior_turn=1 bytes_saved=2000',
  ].join('\n'));
  try {
    const s = estimateSavings(log, { now: Date.parse('2026-05-18T11:00:00.000Z'), rangeDays: 7 });
    assert.equal(s.cache_saved_tokens, 1000);
    assert.equal(s.wm_saved_tokens, 500);
    assert.equal(s.total_saved_tokens, 1500);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
