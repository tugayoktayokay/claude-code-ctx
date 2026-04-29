'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wm = require('../working_memory.js');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(dir, 'working_memory');
  return dir;
}

test('loadSession returns empty shape when session file does not exist', () => {
  const home = tmpHome();
  try {
    const state = wm.loadSession('sid-1');
    assert.deepEqual(state, { session_id: 'sid-1', next_turn: 1, reads: {} });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
