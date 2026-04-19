'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const { parseJSONL } = require('../session.js');
const { analyzeEntries } = require('../analyzer.js');
const { loadDefaults } = require('../config.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo-session.jsonl');

test('largeOutputs carry tool name from tool_use_id + hint', () => {
  const { analyzeEntries } = require('../analyzer.js');
  const { loadDefaults } = require('../config.js');
  const config = loadDefaults();
  const big = 'x'.repeat(50000);
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls -R /' } },
      { type: 'tool_use', id: 'u2', name: 'Read', input: { file_path: '/x' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'u1', content: big },
      { type: 'tool_result', tool_use_id: 'u2', content: big },
    ] } },
  ];
  const a = analyzeEntries(entries, config);
  const tools = a.largeOutputs.map(o => o.tool).sort();
  assert.deepEqual(tools, ['Bash', 'Read']);
  const bash = a.largeOutputs.find(o => o.tool === 'Bash');
  assert.ok(bash.hint, 'hint populated');
  assert.match(bash.hint, /ls|head|narrow/i);
});

test('analyzeEntries pulls token, tool, and content metrics', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);

  assert.ok(analysis.contextTokens >= 95000, `contextTokens=${analysis.contextTokens}`);
  assert.ok(analysis.messageCount >= 5);
  assert.ok(analysis.toolUses >= 5);
  assert.ok(analysis.filesModified.size >= 3, `files=${analysis.filesModified.size}`);
  assert.ok(analysis.bashCommands.length >= 1);
  assert.ok(analysis.activeCategories.size > 0);
  assert.ok(analysis.decisions.length >= 1, 'decisions extracted');
  assert.ok(analysis.failedAttempts.length >= 1, 'failed attempts extracted');
  assert.ok(analysis.criticalBits.length > 0, 'critical bits extracted');
  assert.ok(analysis.userIntents.length >= 5);
});

test('categories include schema and api for petition fixture', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  const keys = [...analysis.activeCategories.keys()];
  assert.ok(keys.includes('api'),    `expected api in ${keys}`);
  assert.ok(keys.includes('schema'), `expected schema in ${keys}`);
});
