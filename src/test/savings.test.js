'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { estimateSavings, formatSavings, tokensForBytes } = require('../savings.js');

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

test('estimateSavings splits working-memory bytes by source (read vs bash dedup)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-savings-split-'));
  const log = path.join(tmp, 'hooks.log');
  fs.writeFileSync(log, [
    '2026-05-18T10:00:00.000Z working_memory action=dedup_hit session=s path="/a" prior_turn=1 bytes_saved=3000',
    '2026-05-18T10:01:00.000Z working_memory action=bash_dedup_hit session=s cmd_norm="ls" prior_turn=2 bytes_saved=1000',
  ].join('\n'));
  try {
    const s = estimateSavings(log, { now: Date.parse('2026-05-18T11:00:00.000Z'), rangeDays: 7 });
    assert.equal(s.wm_read_bytes, 3000);
    assert.equal(s.wm_bash_bytes, 1000);
    assert.equal(s.working_memory_bytes_saved, 4000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('formatSavings reports measured bytes separately from the estimated token figure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-savings-fmt-'));
  const log = path.join(tmp, 'hooks.log');
  fs.writeFileSync(log, [
    '2026-05-18T10:00:00.000Z cache-write ref=abc bytes=4096 source=mcp',
    '2026-05-18T10:01:00.000Z cache-read ref=abc result=hit bytes=4096',
    '2026-05-18T10:02:00.000Z working_memory action=dedup_hit session=s path="/a" prior_turn=1 bytes_saved=2048',
    '2026-05-18T10:03:00.000Z working_memory action=bash_dedup_hit session=s cmd_norm="ls" prior_turn=2 bytes_saved=1024',
  ].join('\n'));
  try {
    const s = estimateSavings(log, { now: Date.parse('2026-05-18T11:00:00.000Z'), rangeDays: 7 });
    const out = formatSavings(s);
    // measured byte section, broken down by source
    assert.match(out, /measured/i);
    assert.match(out, /cache reuse:\s+4\.0 KB/);
    assert.match(out, /read dedup:\s+2\.0 KB/);
    assert.match(out, /bash dedup:\s+1\.0 KB/);
    assert.match(out, /total measured:\s+7\.0 KB/);
    // token figure is explicitly the estimated/derived part (7168 / 4 = 1792)
    assert.match(out, /1,792 tokens/);
    assert.match(out, /byte counts measured/i);
    assert.match(out, /token figure estimated/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
