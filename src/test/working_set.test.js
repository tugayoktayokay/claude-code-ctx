'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatWorkingSet } = require('../working_set.js');

test('formatWorkingSet renders empty sections without crashing', () => {
  const out = formatWorkingSet({
    cwd: '/tmp/project',
    session: null,
    level: null,
    context_pct: null,
    git_changes: [],
    files_modified: [],
    recent_commands: [],
    last_test: null,
    last_guard_or_error: null,
    large_outputs: [],
    last_user: '',
  });
  assert.match(out, /ctx working-set/);
  assert.match(out, /Git changes/);
  assert.match(out, /\(none\)/);
});
