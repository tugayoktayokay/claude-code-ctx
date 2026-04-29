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

test('hashContent returns deterministic sha256 prefix', () => {
  const h1 = wm.hashContent('hello world');
  const h2 = wm.hashContent('hello world');
  const h3 = wm.hashContent('different');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^sha256:[0-9a-f]{16}$/);
});

test('writeBlob + readBlob round-trip', () => {
  const home = tmpHome();
  try {
    const content = 'CLAUDE.md body here';
    const hash = wm.hashContent(content);
    wm.writeBlob('sid-3', hash, content);
    const back = wm.readBlob('sid-3', hash);
    assert.equal(back, content);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('readBlob returns null when blob missing', () => {
  const home = tmpHome();
  try {
    const back = wm.readBlob('sid-x', 'sha256:nope');
    assert.equal(back, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
