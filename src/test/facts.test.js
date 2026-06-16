'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const facts = require('../facts.js');

const CWD = '/Users/test/proj';

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-facts-'));
  return { facts_dir: dir };
}

test('factQuality: noisy hook residue scores 0', () => {
  assert.equal(facts.factQuality('note', 'UserPromptSubmit hook (completed)'), 0);
  assert.equal(facts.factQuality('note', 'hook context: restoring memory'), 0);
});

test('factQuality: decision text scores higher than bare note', () => {
  const decision = facts.factQuality('decision', 'decided to use Postgres because of analytics');
  const note = facts.factQuality('note', 'looked at the file');
  assert.ok(decision > note, `decision ${decision} should beat note ${note}`);
  assert.ok(decision >= 0.8);
});

test('rememberFact then readFacts returns the stored fact', () => {
  const cfg = tmpConfig();
  const res = facts.rememberFact(CWD, 'use Postgres for analytics', cfg, { kind: 'decision' });
  assert.equal(res.ok, true);
  const stored = facts.readFacts(CWD, cfg);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, 'use Postgres for analytics');
  assert.equal(stored[0].kind, 'decision');
  assert.equal(stored[0].source, 'manual');
});

test('rememberFact dedups by id and increments seen', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'use Redis for cache', cfg, { kind: 'decision' });
  facts.rememberFact(CWD, 'use Redis for cache', cfg, { kind: 'decision' });
  const stored = facts.readFacts(CWD, cfg);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].seen, 2);
});

test('rememberFact rejects empty text', () => {
  const cfg = tmpConfig();
  const res = facts.rememberFact(CWD, '   ', cfg, {});
  assert.equal(res.ok, false);
});

test('forgetFacts removes a fact by substring', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'use Postgres for analytics', cfg, { kind: 'decision' });
  facts.rememberFact(CWD, 'auth uses JWT tokens', cfg, { kind: 'decision' });
  const res = facts.forgetFacts(CWD, 'postgres', cfg, {});
  assert.equal(res.removed, 1);
  const stored = facts.readFacts(CWD, cfg);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].text, 'auth uses JWT tokens');
});

test('forgetFacts dryRun does not delete', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'use Postgres for analytics', cfg, { kind: 'decision' });
  const res = facts.forgetFacts(CWD, 'postgres', cfg, { dryRun: true });
  assert.equal(res.removed, 1);
  assert.equal(facts.readFacts(CWD, cfg).length, 1);
});

test('recallFacts returns matching fact, ignores unrelated', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'use Postgres for analytics queries', cfg, { kind: 'decision' });
  facts.rememberFact(CWD, 'mobile uses Expo dev client', cfg, { kind: 'workflow' });
  const hits = facts.recallFacts(CWD, 'which database for analytics', cfg, {});
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /Postgres/);
});

test('recallFacts returns empty for generic prompt', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'use Postgres for analytics', cfg, { kind: 'decision' });
  const hits = facts.recallFacts(CWD, 'ok', cfg, {});
  assert.equal(hits.length, 0);
});

test('pruneFacts drops facts below the prune bar', () => {
  const cfg = tmpConfig();
  // high quality decision (quality ~0.95)
  facts.rememberFact(CWD, 'decided to avoid global state', cfg, { kind: 'decision' });
  // borderline fact: passes write threshold (0.25) but below a higher prune bar
  facts.writeFacts(CWD, [{
    id: 'borderline1', cwd: CWD, kind: 'note', text: 'glanced at the config layout',
    paths: [], source: 'auto', ts: new Date().toISOString(),
    weight: 1, quality: 0.3, seen: 1,
  }], cfg);
  const before = facts.readFacts(CWD, cfg).length;
  assert.equal(before, 2);
  const res = facts.pruneFacts(CWD, cfg, { qualityBelow: 0.5 });
  assert.ok(res.removed >= 1, `expected prune to remove borderline, before=${before}`);
  assert.ok(facts.readFacts(CWD, cfg).every(f => f.quality >= 0.5));
});

test('extractFromPrompt captures a decision-like prompt as a fact', () => {
  const cfg = tmpConfig();
  const res = facts.extractFromPrompt(CWD, 'we decided to use Postgres for the analytics service', cfg);
  assert.equal(res.extracted, 1);
  const stored = facts.readFacts(CWD, cfg);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'decision');
  assert.equal(stored[0].source, 'prompt');
});

test('extractFromPrompt ignores chit-chat prompts', () => {
  const cfg = tmpConfig();
  const res = facts.extractFromPrompt(CWD, 'ok thanks', cfg);
  assert.equal(res.extracted, 0);
  assert.equal(facts.readFacts(CWD, cfg).length, 0);
});

test('extractFromPrompt disabled by config flag', () => {
  const cfg = { ...tmpConfig(), memory: { passive_prompt_extraction: false } };
  const res = facts.extractFromPrompt(CWD, 'decided to drop the cache layer', cfg);
  assert.equal(res.extracted, 0);
  assert.equal(facts.readFacts(CWD, cfg).length, 0);
});

test('redactSecrets masks api keys, tokens, and key=value secrets', () => {
  assert.match(facts.redactSecrets('use sk-ABCDEFGHIJKLMNOPQRSTUVWX for openai'), /\[redacted\]/);
  assert.doesNotMatch(facts.redactSecrets('use sk-ABCDEFGHIJKLMNOPQRSTUVWX'), /sk-ABCDEF/);
  const kv = facts.redactSecrets('set password: hunter2supersecret');
  assert.match(kv, /password/);          // key name kept
  assert.doesNotMatch(kv, /hunter2supersecret/);
});

test('rememberFact redacts secrets before persisting', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'deploy uses api_key=AKIAABCDEFGHIJKLMNOP in prod', cfg, { kind: 'decision' });
  const stored = facts.readFacts(CWD, cfg);
  assert.equal(stored.length, 1);
  assert.doesNotMatch(stored[0].text, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(stored[0].text, /\[redacted\]/);
});

test('extractFromPrompt redacts secrets', () => {
  const cfg = tmpConfig();
  facts.extractFromPrompt(CWD, 'decided to use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 for ci', cfg);
  const stored = facts.readFacts(CWD, cfg);
  assert.ok(stored.length >= 1);
  assert.ok(stored.every(f => !/ghp_ABCDEF/.test(f.text)));
});

test('harvestSnapshots lifts decision + failed bullets from snapshot bodies into facts', () => {
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-harvest-'));
  const cfg = { facts_dir: path.join(memDir, 'facts') };
  fs.writeFileSync(path.join(memDir, 'snap1.md'), [
    '---',
    'name: snap one',
    '---',
    '',
    '**Decisions made:**',
    '- decided to use Postgres for analytics because OLAP queries are heavy',
    '- avoid global mutable state in the analyzer module',
    '',
    '**Failed attempts / open questions:**',
    '- tried in-memory cache, it failed under concurrent load',
    '',
    '**Context snapshot:**',
    '- 42% of ceiling',
  ].join('\n'));
  // MEMORY.md must be skipped
  fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [snap1](snap1.md) — index line\n');

  const res = facts.harvestSnapshots(memDir, CWD, cfg, {});
  assert.equal(res.scanned, 1);
  assert.ok(res.extracted >= 3, `expected >=3 facts, got ${res.extracted}`);
  const stored = facts.readFacts(CWD, cfg);
  assert.ok(stored.some(f => f.kind === 'decision' && /Postgres/.test(f.text)));
  assert.ok(stored.some(f => f.kind === 'bug' && /concurrent load/.test(f.text)));
  assert.ok(stored.every(f => f.source === 'harvest'));
});

test('harvestSnapshots drops markdown-header bullets and dedups across sections', () => {
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-harvest-'));
  const cfg = { facts_dir: path.join(memDir, 'facts') };
  const shared = 'we must avoid recomputing the analyzer token max on every entry';
  fs.writeFileSync(path.join(memDir, 'snap.md'), [
    '**Decisions made:**',
    '## 🎯 critical finding section header that is really assistant prose',
    `- ${shared}`,
    '',
    '**Failed attempts / open questions:**',
    `- ${shared}`,
    '',
  ].join('\n'));
  const res = facts.harvestSnapshots(memDir, CWD, cfg, {});
  const stored = facts.readFacts(CWD, cfg);
  // header line is not a bullet → not captured; shared line appears once (decision wins)
  assert.equal(stored.filter(f => f.text.includes('recomputing the analyzer')).length, 1);
  assert.equal(stored[0].kind, 'decision');
  assert.ok(!stored.some(f => /🎯|^#/.test(f.text)));
});

test('harvestSnapshots skips noise bullets and is idempotent', () => {
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-harvest-'));
  const cfg = { facts_dir: path.join(memDir, 'facts') };
  fs.writeFileSync(path.join(memDir, 'snap.md'), [
    '**Decisions made:**',
    '- decided to gate passive extraction behind a config flag',
    '- Base directory for this skill: /tmp/junk',
    '',
  ].join('\n'));
  const first = facts.harvestSnapshots(memDir, CWD, cfg, {});
  const countAfterFirst = facts.readFacts(CWD, cfg).length;
  const second = facts.harvestSnapshots(memDir, CWD, cfg, {});
  const countAfterSecond = facts.readFacts(CWD, cfg).length;
  assert.equal(countAfterFirst, countAfterSecond, 'harvest must be idempotent');
  assert.ok(!facts.readFacts(CWD, cfg).some(f => /Base directory for this skill/.test(f.text)));
});

test('sessionDigest surfaces top durable facts, excludes plain notes', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'use Postgres for analytics, not SQLite', cfg, { kind: 'decision' });
  facts.rememberFact(CWD, 'never block the Stop hook — always exit 0', cfg, { kind: 'constraint' });
  facts.rememberFact(CWD, 'looked at the readme briefly', cfg, { kind: 'note' });
  const digest = facts.sessionDigest(CWD, cfg, {});
  assert.match(digest, /Postgres for analytics/);
  assert.match(digest, /always exit 0/);
  assert.doesNotMatch(digest, /looked at the readme/);
});

test('sessionDigest returns empty string when no durable facts', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'just a passing note', cfg, { kind: 'note' });
  assert.equal(facts.sessionDigest(CWD, cfg, {}), '');
});

test('auditFacts reports low_quality count', () => {
  const cfg = tmpConfig();
  facts.rememberFact(CWD, 'decided to use Postgres', cfg, { kind: 'decision' });
  facts.writeFacts(CWD, [{
    id: 'noisy1', cwd: CWD, kind: 'note', text: 'PostToolUse hook (completed)',
    paths: [], source: 'auto', ts: new Date().toISOString(),
    weight: 1, quality: 0, seen: 1,
  }], cfg);
  const out = JSON.parse(facts.auditFacts(CWD, cfg, { json: true }));
  assert.ok(out.total >= 1);
  assert.equal(typeof out.low_quality, 'number');
});
