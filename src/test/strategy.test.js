'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const { parseJSONL } = require('../session.js');
const { analyzeEntries } = require('../analyzer.js');
const { makeDecision }   = require('../decision.js');
const { buildStrategy }  = require('../strategy.js');
const { loadDefaults }   = require('../config.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo-session.jsonl');

test('strategy produces a /compact prompt with focus/keep/continue', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  const limits   = { max: 200000, quality_ceiling: 200000 };
  const decision = makeDecision(analysis, limits, config);
  const strategy = buildStrategy(analysis, decision, config);

  assert.ok(strategy.compactPrompt.startsWith('/compact focus on'));
  assert.ok(strategy.compactPrompt.includes('keep:'));
  assert.ok(strategy.compactPrompt.includes('continue:'));
  assert.ok(strategy.keep.length > 0, 'keep sections populated');
});
