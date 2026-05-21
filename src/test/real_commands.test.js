'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// File-level HOME isolation. handlePreToolUse logs each deny/ask decision via
// `os.homedir()` at runtime, so without this every corpus case below would
// append a synthetic deny event (session=curated-corpus / regression-corpus)
// to the real `~/.config/ctx/hooks.log` and skew `ctx metrics` obey rate.
const FILE_TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-realcmd-test-home-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = FILE_TMP_HOME;
process.on('exit', () => {
  process.env.HOME = ORIG_HOME;
  try { fs.rmSync(FILE_TMP_HOME, { recursive: true, force: true }); } catch {}
});

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

test('regression: corpus handler calls do not pollute the real hooks.log', () => {
  const cfg = loadDefaults();
  const sentinel = `corpus-isolation-probe-${process.pid}`;
  handlePreToolUse({
    session_id: sentinel,
    tool_name: 'Bash',
    tool_input: { command: 'grep -rn "x" /tmp' }, // triggers recursive-grep deny → logged
  }, cfg);

  // os.homedir() is redirected to FILE_TMP_HOME above; assert the REAL home log
  // (ORIG_HOME) never received the synthetic event.
  const tmpLog = path.join(FILE_TMP_HOME, '.config', 'ctx', 'hooks.log');
  assert.ok(fs.existsSync(tmpLog), 'deny event lands under the isolated temp HOME');
  assert.match(fs.readFileSync(tmpLog, 'utf8'), new RegExp(`session=${sentinel}`));

  if (ORIG_HOME) {
    const realLog = path.join(ORIG_HOME, '.config', 'ctx', 'hooks.log');
    if (fs.existsSync(realLog)) {
      assert.equal(fs.readFileSync(realLog, 'utf8').includes(sentinel), false,
        'synthetic corpus sessions must NOT leak into the real ~/.config/ctx/hooks.log ' +
        '(they inflate deny/ask events and skew `ctx metrics` obey rate)');
    }
  }
});
