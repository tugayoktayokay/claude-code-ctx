'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { handlePreToolUse } = require('../hooks.js');
const { loadDefaults } = require('../config.js');

const CURATED_FIXTURE = path.join(__dirname, 'fixtures', 'real_bash_commands.json');
const REGRESSION_FIXTURE = path.join(__dirname, 'fixtures', 'regression_bash_commands.json');

function loadCases(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runAllCases(cases, label) {
  const cfg = loadDefaults();
  const failures = [];
  for (const c of cases) {
    const res = handlePreToolUse({
      session_id: label,
      tool_name: 'Bash',
      tool_input: { command: c.command },
    }, cfg);
    const decision = res.output?.hookSpecificOutput?.permissionDecision || 'pass';
    if (decision !== c.expect) {
      failures.push(`[${c.label}] expected ${c.expect}, got ${decision}: ${c.command}`);
    }
  }
  return failures;
}

test('real-world Bash command corpus keeps expected pre-tool decisions', () => {
  const cases = loadCases(CURATED_FIXTURE);
  assert.ok(cases.length >= 10, 'curated fixture should cover multiple real command shapes');
  const failures = runAllCases(cases, 'curated-corpus');
  assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
});

test('regression corpus (100 real commands from hooks.log) keeps current decisions', () => {
  const cases = loadCases(REGRESSION_FIXTURE);
  assert.ok(cases.length >= 50, `regression corpus should be large (got ${cases.length})`);
  const failures = runAllCases(cases, 'regression-corpus');
  assert.equal(failures.length, 0, `\n${failures.join('\n')}`);
});
