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

test('editPressure: below threshold does not bump the level', () => {
  const config = loadDefaults();
  const limits = { max: 200000, quality_ceiling: 200000 };
  // contextPct = 48% (96k / 200k) → watch normally
  const d = makeDecision(
    fakeAnalysis(96000, { editPressureKB: 50 }), // 50KB < 100KB threshold
    limits, config
  );
  assert.equal(d.level, 'watch');
  assert.equal(d.metrics.editPressureKB, 50);
  assert.equal(d.reason?.editPressure ?? false, false);
});

test('editPressure: above threshold promotes level via virtual bump', () => {
  const config = loadDefaults(); // bump_pct=15, threshold_kb=100
  const limits = { max: 200000, quality_ceiling: 200000 };
  // 48% + 15% bump = 63% → compact
  const d = makeDecision(
    fakeAnalysis(96000, { editPressureKB: 130 }),
    limits, config
  );
  assert.equal(d.level, 'compact', 'should promote watch→compact');
  assert.equal(d.metrics.editPressureKB, 130);
  assert.equal(d.reason.editPressure, true);
  // Raw contextPct still truthful
  assert.equal(d.metrics.contextPct, 48);
});

test('editPressure: bump is monotonic (never demotes)', () => {
  const config = loadDefaults();
  const limits = { max: 200000, quality_ceiling: 200000 };
  // pressure=0 means no bump applied — at 30% stays comfortable
  const d = makeDecision(
    fakeAnalysis(60000, { editPressureKB: 0 }),
    limits, config
  );
  assert.equal(d.level, 'comfortable');
  assert.equal(d.reason?.editPressure ?? false, false);
});

test('editPressure: enabled=false disables bump entirely', () => {
  const config = loadDefaults();
  config.limits.edit_pressure.enabled = false;
  const limits = { max: 200000, quality_ceiling: 200000 };
  const d = makeDecision(
    fakeAnalysis(96000, { editPressureKB: 500 }),
    limits, config
  );
  assert.equal(d.level, 'watch', 'bump disabled, stays at watch');
  assert.equal(d.reason?.editPressure ?? false, false);
});
