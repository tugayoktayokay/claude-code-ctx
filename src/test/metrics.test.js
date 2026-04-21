'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseLine, parseKeyValues, parseLog, parseLogString, parseLogPath } = require('../metrics.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'hooks_sample.log');

test('parseKeyValues handles bareword and quoted values with escapes', () => {
  const kv = parseKeyValues('session=abc action=deny pattern="^grep -r" cmd_head="grep \\"foo\\" ."');
  assert.equal(kv.session, 'abc');
  assert.equal(kv.action, 'deny');
  assert.equal(kv.pattern, '^grep -r');
  assert.equal(kv.cmd_head, 'grep "foo" .');
});

test('parseKeyValues preserves regex backslashes (not only \\" unescape)', () => {
  // Real log line written by hooks.js for the find rule:
  //   pattern="^\s*find\s+[/~]"
  // The reader must preserve \s and \+ exactly, only unescape \" and \\.
  const kv = parseKeyValues('pattern="^\\s*find\\s+[/~]" cmd_head="find / -name x"');
  assert.equal(kv.pattern, '^\\s*find\\s+[/~]');
  assert.equal(kv.cmd_head, 'find / -name x');
});

test('parseKeyValues correctly unescapes \\\\ to single backslash', () => {
  const kv = parseKeyValues('path="C:\\\\Users\\\\foo"');
  assert.equal(kv.path, 'C:\\Users\\foo');
});

test('parseLine returns record for pre_tool', () => {
  const { record, error } = parseLine('2026-04-21T10:00:00.000Z pre_tool session=S1 action=deny tool=Bash pattern="^x" cmd_head="x" reason="r"');
  assert.equal(error, null);
  assert.equal(record.evType, 'pre_tool');
  assert.equal(record.session, 'S1');
  assert.equal(record.action, 'deny');
  assert.equal(record.tool, 'Bash');
});

test('parseLine returns null record for blank line with no error', () => {
  const r = parseLine('');
  assert.equal(r.record, null);
  assert.equal(r.error, null);
});

test('parseLine marks unrecognized event as error', () => {
  const r = parseLine('2026-04-21T10:00:00.000Z nonsense session=x');
  assert.equal(r.record, null);
  assert.equal(r.error, 'unknown event type');
});

test('parseLine silently ignores legitimate non-metric events (no parse error)', () => {
  const samples = [
    '2026-04-21T10:00:00.000Z session-start restored project_x.md (68 bytes)',
    '2026-04-21T10:00:00.000Z stop clipboard_compact level=urgent prompt_len=37',
    '2026-04-21T10:00:00.000Z pre-compact level=critical userInput=no',
    '2026-04-21T10:00:00.000Z pre-tool-use ask tool=Bash rule="^grep -r" reason="redirect"',
    '2026-04-21T10:00:00.000Z post-tool-use snapshot tool=Bash dedup=false',
    '2026-04-21T10:00:00.000Z auto-retrieve prompt_turn=1 score=0.73',
  ];
  for (const line of samples) {
    const r = parseLine(line);
    assert.equal(r.record, null, `should not emit a record for: ${line}`);
    assert.equal(r.error, null, `should NOT count as parse error: ${line}`);
  }
});

test('parseLine marks no-timestamp line as error', () => {
  const r = parseLine('this line is not valid and should be skipped by the parser');
  assert.equal(r.record, null);
  assert.equal(r.error, 'no timestamp');
});

test('parseLog reads canonical fixture', () => {
  const { records, parseErrors } = parseLog(FIXTURE);
  assert.ok(records.length >= 20, `expected >=20 records, got ${records.length}`);
  assert.equal(parseErrors, 1);
  const preCount = records.filter(r => r.evType === 'pre_tool').length;
  assert.ok(preCount >= 11, `expected >=11 pre_tool records, got ${preCount}`);
  const postCount = records.filter(r => r.evType === 'post_tool').length;
  assert.ok(postCount >= 8);
  const cacheCount = records.filter(r => r.evType.startsWith('cache-')).length;
  assert.equal(cacheCount, 4);
});

test('parseLog on single-line raw string does not crash', () => {
  const r = parseLog('2026-04-21T10:00:00.000Z pre_tool session=x action=deny tool=Bash pattern="^x" cmd_head="x" reason="r"');
  assert.equal(r.records.length, 1);
  assert.equal(r.parseErrors, 0);
});

test('parseLog on multi-line raw string parses all lines', () => {
  const raw = '2026-04-21T10:00:00.000Z pre_tool session=x action=deny tool=Bash pattern="^x" cmd_head="x" reason="r"\n2026-04-21T10:00:05.000Z post_tool session=x tool=Bash cmd_head="x" exit=0 size_bytes=10';
  const r = parseLog(raw);
  assert.equal(r.records.length, 2);
});

test('parseLogString ignores filesystem', () => {
  const r = parseLogString('garbage-that-might-be-a-real-path-or-not');
  assert.equal(r.records.length, 0);
  assert.equal(r.parseErrors, 1);
});

test('parseLog with Buffer works', () => {
  const buf = Buffer.from('2026-04-21T10:00:00.000Z pre_tool session=x action=deny tool=Bash pattern="^x" cmd_head="x" reason="r"');
  const r = parseLog(buf);
  assert.equal(r.records.length, 1);
});

const { correlate } = require('../metrics.js');

test('correlate: deny + ctx_grep post within window → obeyed', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^grep' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:10.000Z', session: 'S', tool: 'mcp__ctx__ctx_grep', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.total, 1);
  assert.equal(r.pre_tool.deny.obeyed, 1);
  assert.equal(r.pre_tool.deny.bypassed, 0);
});

test('correlate: deny + Bash post exit=0 → bypassed, per_rule updated', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^find' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:20.000Z', session: 'S', tool: 'Bash', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.bypassed, 1);
  assert.equal(r.per_rule[0].pattern, '^find');
  assert.equal(r.per_rule[0].bypasses, 1);
  assert.equal(r.per_rule[0].bypass_rate, 1);
});

test('correlate: deny + Bash post exit=1 → bypass_failed, not bypassed', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^x' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:15.000Z', session: 'S', tool: 'Bash', exit: '1' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.bypass_failed, 1);
  assert.equal(r.pre_tool.deny.bypassed, 0);
  assert.equal(r.per_rule[0].bypasses, 0);
});

test('correlate: native Read bystander does not close pre; next ctx post wins', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^grep' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:03.000Z', session: 'S', tool: 'Read', exit: '0' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:12.000Z', session: 'S', tool: 'mcp__ctx__ctx_grep', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.obeyed, 1);
});

test('correlate: plugin-form MCP tool name (real Claude Code format) → obeyed', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^grep' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:10.000Z', session: 'S', tool: 'mcp__plugin_claude-code-ctx_ctx__ctx_grep', exit: '-' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.obeyed, 1);
  assert.equal(r.pre_tool.deny.abandoned, 0);
});

test('correlate: ctx_cache_get is bystander (NOT in the obey bucket)', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^grep' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:05.000Z', session: 'S', tool: 'mcp__plugin_claude-code-ctx_ctx__ctx_cache_get', exit: '-' },
  ];
  const r = correlate(records);
  // cache_get is a bystander — no classification bucket was reached
  assert.equal(r.pre_tool.deny.obeyed, 0);
  assert.equal(r.pre_tool.deny.abandoned, 1);
});

test('correlate: Bash post with exit="-" (unknown) classified as bypassed, not bypass_failed', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^x' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:10.000Z', session: 'S', tool: 'Bash', exit: '-' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.bypassed, 1);
  assert.equal(r.pre_tool.deny.bypass_failed, 0);
});

test('correlate: native Grep bystander then nothing → abandoned', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^x' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:05.000Z', session: 'S', tool: 'Grep', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.abandoned, 1);
});

test('correlate: two consecutive pre, one post → first obeyed, second abandoned', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^x' },
    { evType: 'pre_tool', ts: '2026-04-21T10:00:30.000Z', session: 'S', action: 'deny', tool: 'Bash', pattern: '^x' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:45.000Z', session: 'S', tool: 'mcp__ctx__ctx_grep', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.obeyed, 1);
  assert.equal(r.pre_tool.deny.abandoned, 1);
});

test('correlate: ask + Bash exit=0 → user_approved', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: 'S', action: 'ask', tool: 'Bash', pattern: '^ls' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:10.000Z', session: 'S', tool: 'Bash', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.pre_tool.ask.user_approved, 1);
});

test('correlate: session=- events go to unscoped bucket, not correlated', () => {
  const records = [
    { evType: 'pre_tool', ts: '2026-04-21T10:00:00.000Z', session: '-', action: 'deny', tool: 'Bash', pattern: '^x' },
    { evType: 'post_tool', ts: '2026-04-21T10:00:10.000Z', session: '-', tool: 'Bash', exit: '0' },
  ];
  const r = correlate(records);
  assert.equal(r.unscoped, 2);
  assert.equal(r.pre_tool.deny.total, 0);
});

test('correlate end-to-end on canonical fixture', () => {
  const { records } = parseLog(FIXTURE);
  const r = correlate(records);
  assert.equal(r.pre_tool.deny.total, 8);
  assert.equal(r.pre_tool.deny.obeyed, 3);
  assert.equal(r.pre_tool.deny.bypassed, 2);
  assert.equal(r.pre_tool.deny.bypass_failed, 1);
  assert.equal(r.pre_tool.deny.abandoned, 2);
  assert.equal(r.pre_tool.ask.total, 3);
  assert.equal(r.pre_tool.ask.user_approved, 1);
  assert.equal(r.pre_tool.ask.redirected, 1);
  assert.equal(r.pre_tool.ask.canceled, 1);
  assert.equal(r.unscoped, 2);
});

const { aggregate, aggregateCache } = require('../metrics.js');

test('aggregate produces full record shape on canonical fixture', () => {
  const r = aggregate(FIXTURE, { now: Date.parse('2026-04-21T10:15:00.000Z'), rangeDays: 7 });
  assert.equal(r.range_days, 7);
  assert.equal(r.window_seconds, 60);
  assert.equal(r.pre_tool.total, 11);
  assert.equal(r.pre_tool.deny.total, 8);
  assert.equal(r.pre_tool.ask.total, 3);
  assert.equal(r.cache.writes, 1);
  assert.equal(r.cache.reads, 2);
  assert.equal(r.cache.read_hits, 1);
  assert.equal(r.cache.read_misses, 1);
  assert.equal(r.cache.hit_rate, 0.5);
  assert.equal(r.cache.gc_sweeps, 1);
  assert.equal(r.unscoped, 2);
  assert.equal(r.parse_errors, 1);
});

test('aggregate excludes events outside range', () => {
  const r = aggregate(FIXTURE, { now: Date.parse('2026-05-01T00:00:00.000Z'), rangeDays: 1 });
  assert.equal(r.pre_tool.total, 0);
  assert.equal(r.cache.writes, 0);
});

test('aggregate with empty log returns zero record, no division by zero', () => {
  const emptyPath = path.join(__dirname, 'fixtures', 'empty.log');
  require('fs').writeFileSync(emptyPath, '');
  try {
    const r = aggregate(emptyPath, { now: Date.now() });
    assert.equal(r.pre_tool.total, 0);
    assert.equal(r.cache.hit_rate, 0);
    assert.equal(r.parse_errors, 0);
  } finally {
    require('fs').unlinkSync(emptyPath);
  }
});
