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
