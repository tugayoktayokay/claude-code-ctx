'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const { runAnalyze } = require('../pipeline.js');
const { loadDefaults } = require('../config.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo-session.jsonl');

test('runAnalyze returns full pipeline output for a session path', () => {
  const config = loadDefaults();
  const pipe = runAnalyze({ sessionPath: FIXTURE, config });

  assert.ok(pipe, 'pipeline returns non-null');
  assert.ok(pipe.entries.length > 0);
  assert.ok(pipe.analysis.messageCount > 0);
  assert.ok(pipe.decision.level, 'decision.level set');
  assert.ok(pipe.decision.metrics.contextTokens > 0);
  assert.ok(pipe.strategy.compactPrompt.startsWith('/compact'));
  assert.ok(pipe.modelId, 'modelId set');
  assert.equal(pipe.sessionId, 'demo-session');
});

test('runAnalyze with missing session returns null', () => {
  const config = loadDefaults();
  const pipe = runAnalyze({ sessionPath: '/nonexistent/path.jsonl', config });
  assert.equal(pipe, null);
});

test('runAnalyze accepts pre-parsed entries', () => {
  const config = loadDefaults();
  const { parseJSONL } = require('../session.js');
  const entries = parseJSONL(FIXTURE);
  const pipe = runAnalyze({ entries, config, sessionPath: FIXTURE });

  assert.ok(pipe.analysis.messageCount > 0);
  assert.equal(pipe.sessionId, 'demo-session');
});
