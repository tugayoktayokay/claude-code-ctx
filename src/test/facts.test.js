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
