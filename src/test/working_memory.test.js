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

test('saveSession persists state and loadSession reads it back', () => {
  const home = tmpHome();
  try {
    const state = {
      session_id: 'sid-2',
      next_turn: 3,
      reads: { '/foo/bar.md': [{ turn: 1, hash: 'sha256:abc', size: 100, mtime: 'X', ts: 'Y' }] },
    };
    wm.saveSession(state);
    const loaded = wm.loadSession('sid-2');
    assert.deepEqual(loaded, state);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
