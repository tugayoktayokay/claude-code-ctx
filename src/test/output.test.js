'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { printMetrics } = require('../output.js');

// capture console.log for substring assertions
function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

test('printMetrics empty record prints no-events message', () => {
  const out = capture(() => printMetrics({
    range_days: 7, window_seconds: 60,
    pre_tool: { total: 0, deny: { total: 0, obeyed: 0, bypassed: 0, bypass_failed: 0, abandoned: 0 },
                           ask:  { total: 0, user_approved: 0, redirected: 0, canceled: 0, approved_failed: 0 } },
    per_rule: [],
    cache: { writes: 0, reads: 0, read_hits: 0, read_misses: 0, hit_rate: 0, gc_sweeps: 0, gc_evicted: 0, gc_bytes_freed: 0 },
    unscoped: 0, parse_errors: 0,
  }));
  assert.match(out, /no events recorded/i);
});

test('renderMetrics shows working memory section when records present', () => {
  const { printMetrics: renderMetrics } = require('../output.js');
  const result = {
    pre_tool: { total: 0, deny: { total: 0 }, ask: { total: 0 } },
    cache:    { writes: 0, reads: 0, hits: 0, misses: 0 },
    working_memory: { dedup_hits: 5, bytes_saved: 12345, recall_calls: 1, recall_rate: 0.2 },
  };
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try { renderMetrics(result); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /working memory/);
  assert.match(out, /dedup hits:\s+5/);
  assert.match(out, /12.*KB/);
});

test('renderMetrics shows bash dedup line when bash_dedup_hits > 0', () => {
  const { printMetrics } = require('../output.js');
  const result = {
    pre_tool: { total: 0, deny: { total: 0 }, ask: { total: 0 } },
    cache:    { writes: 0, reads: 0, hits: 0, misses: 0 },
    working_memory: {
      dedup_hits: 0, bytes_saved: 0, recall_calls: 0, recall_rate: 0,
      bash_dedup_hits: 4, bash_bytes_saved: 8200,
    },
  };
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try { printMetrics(result); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /bash dedup hits:\s+4/);
  assert.match(out, /8\.0 KB|8 KB/);
});

test('printMetrics populated record includes key substrings', () => {
  const out = capture(() => printMetrics({
    range_days: 7, window_seconds: 60,
    pre_tool: {
      total: 11,
      deny: { total: 8, obeyed: 3, bypassed: 2, bypass_failed: 1, abandoned: 2 },
      ask:  { total: 3, user_approved: 1, redirected: 1, canceled: 1, approved_failed: 0 },
    },
    per_rule: [
      { pattern: '^grep -r', triggers: 4, bypasses: 1, bypass_rate: 0.25 },
      { pattern: '^find /',  triggers: 1, bypasses: 1, bypass_rate: 1.0 },
    ],
    cache: { writes: 1, reads: 2, read_hits: 1, read_misses: 1, hit_rate: 0.5, gc_sweeps: 1, gc_evicted: 3, gc_bytes_freed: 81788928 },
    unscoped: 2, parse_errors: 1,
  }));
  assert.match(out, /obeyed/);
  assert.match(out, /bypassed/);
  assert.match(out, /top bypassed rules/i);
  assert.match(out, /cache/i);
  assert.match(out, /malformed log lines skipped/i);
  assert.match(out, /without session_id/i);
});
