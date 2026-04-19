'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { makeDecision } = require('../decision.js');
const { loadDefaults } = require('../config.js');

function fakeAnalysis(tokens, extras = {}) {
  return {
    contextTokens: tokens,
    totalOutput: 0,
    tokenHistory: [],
    tokenPerTurn: [],
    avgGrowthPerTurn: 0,
    activeCategories: new Map(),
    filesModified: new Set(),
    bashCommands: [],
    criticalBits: [],
    userIntents: [],
    decisions: [],
    failedAttempts: [],
    lastNMessages: [],
    toolCounts: {},
    largeOutputs: [],
    messageCount: 0,
    toolUses: 0,
    ...extras,
  };
}

test('decision levels ladder correctly against quality ceiling', () => {
  const config = loadDefaults();
  const limits = { max: 200000, quality_ceiling: 200000 };

  const cases = [
    [10000,  'comfortable'],
    [50000,  'comfortable'],
    [85000,  'watch'],
    [120000, 'compact'],
    [160000, 'urgent'],
    [185000, 'critical'],
  ];

  for (const [tokens, expected] of cases) {
    const d = makeDecision(fakeAnalysis(tokens), limits, config);
    assert.equal(d.level, expected, `at ${tokens} expected ${expected}, got ${d.level}`);
  }
});

test('opus 1M uses 200k ceiling by default', () => {
  const config = loadDefaults();
  const limits = { max: 1000000, quality_ceiling: 200000 };
  const d = makeDecision(fakeAnalysis(160000), limits, config);
  assert.equal(d.level, 'urgent');
  assert.equal(d.metrics.qualityCeiling, 200000);
  assert.equal(d.metrics.modelMax, 1000000);
});
