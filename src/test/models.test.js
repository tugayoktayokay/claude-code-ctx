'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { detectModel, normalizeModelId, getLimits } = require('../models.js');
const { loadDefaults } = require('../config.js');

test('detectModel reads last assistant model', () => {
  const entries = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { model: 'claude-opus-4-7', content: 'yo' } },
    { type: 'user', message: { content: 'ok' } },
  ];
  assert.equal(detectModel(entries), 'claude-opus-4-7');
});

test('detectModel falls back to default', () => {
  assert.equal(detectModel([]), 'default');
  assert.equal(detectModel([{ type: 'user', message: { content: 'x' } }]), 'default');
});

test('normalizeModelId strips date + bracket suffix', () => {
  assert.equal(normalizeModelId('claude-opus-4-7-20250101'), 'claude-opus-4-7');
  assert.equal(normalizeModelId('claude-opus-4-7[1m]'), 'claude-opus-4-7');
  assert.equal(normalizeModelId('anthropic/claude-sonnet-4-6'), 'claude-sonnet-4-6');
});

test('getLimits resolves known model or falls back to default', () => {
  const config = loadDefaults();
  const opus = getLimits('claude-opus-4-7[1m]', config);
  assert.equal(opus.max, 1000000);
  assert.equal(opus.quality_ceiling, 200000);

  const haiku = getLimits('claude-haiku-4-5', config);
  assert.equal(haiku.quality_ceiling, 100000);

  const unknown = getLimits('mystery-model-v9', config);
  assert.equal(unknown.model, 'default');
});
