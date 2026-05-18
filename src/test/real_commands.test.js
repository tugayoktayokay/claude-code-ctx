'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const { handlePreToolUse } = require('../hooks.js');
const { loadDefaults } = require('../config.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'real_bash_commands.json');

function loadCases() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

test('real-world Bash command corpus keeps expected pre-tool decisions', () => {
  const cfg = loadDefaults();
  const cases = loadCases();
  assert.ok(cases.length >= 10, 'fixture should cover multiple real command shapes');

  for (const c of cases) {
    const res = handlePreToolUse({
      session_id: 'real-corpus',
      tool_name: 'Bash',
      tool_input: { command: c.command },
    }, cfg);
    const decision = res.output?.hookSpecificOutput?.permissionDecision || 'pass';
    assert.equal(
      decision,
      c.expect,
      `[${c.label}] expected ${c.expect}, got ${decision}: ${c.command}`,
    );
  }
});
