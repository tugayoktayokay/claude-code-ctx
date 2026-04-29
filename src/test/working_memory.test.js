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

test('recordRead appends entry, increments next_turn, caps to 5 entries per path', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-rec';
    const filePath = '/abs/file.md';
    const content = 'X';
    for (let i = 0; i < 7; i++) {
      wm.recordRead(sid, filePath, content + i, { mtime: 'T' + i });
    }
    const state = wm.loadSession(sid);
    assert.equal(state.next_turn, 8);
    assert.equal(state.reads[filePath].length, 5);
    assert.equal(state.reads[filePath][4].turn, 7);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('lookupLatestRead returns last entry for a path', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-lookup';
    wm.recordRead(sid, '/x.md', 'one', { mtime: 'A' });
    wm.recordRead(sid, '/x.md', 'two', { mtime: 'B' });
    const last = wm.lookupLatestRead(sid, '/x.md');
    assert.equal(last.turn, 2);
    assert.equal(last.size, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('lookupLatestRead returns null for unknown path', () => {
  const home = tmpHome();
  try {
    const last = wm.lookupLatestRead('sid-empty', '/nope.md');
    assert.equal(last, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('dedupDecision returns null when no prior entry', () => {
  const home = tmpHome();
  try {
    const d = wm.dedupDecision('sid-d1', '/x.md', 'content', { mtime: 'A' });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('dedupDecision returns dedup when same hash + within recency + above size', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-d2';
    const content = 'a'.repeat(2000);
    wm.recordRead(sid, '/x.md', content, { mtime: 'A' });
    const d = wm.dedupDecision(sid, '/x.md', content, {
      mtime: 'A', now: Date.now(), recency_window_minutes: 10, min_dedup_size_bytes: 1024,
    });
    assert.equal(d.action, 'dedup');
    assert.equal(d.priorTurn, 1);
    assert.equal(d.size, 2000);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('dedupDecision allows when content changed (different hash)', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-d3';
    const c1 = 'a'.repeat(2000);
    const c2 = 'b'.repeat(2000);
    wm.recordRead(sid, '/x.md', c1, { mtime: 'A' });
    const d = wm.dedupDecision(sid, '/x.md', c2, {
      mtime: 'A', now: Date.now(), recency_window_minutes: 10, min_dedup_size_bytes: 1024,
    });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('dedupDecision allows when below size gate', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-d4';
    const small = 'tiny';
    wm.recordRead(sid, '/x.md', small, { mtime: 'A' });
    const d = wm.dedupDecision(sid, '/x.md', small, {
      mtime: 'A', now: Date.now(), recency_window_minutes: 10, min_dedup_size_bytes: 1024,
    });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('dedupDecision allows when recency window expired (refresh)', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-d5';
    const content = 'a'.repeat(2000);
    wm.recordRead(sid, '/x.md', content, { mtime: 'A' });
    // Inject `now` 20 minutes after the prior record
    const future = Date.now() + 20 * 60_000;
    const d = wm.dedupDecision(sid, '/x.md', content, {
      mtime: 'A', now: future, recency_window_minutes: 10, min_dedup_size_bytes: 1024,
    });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('gcOldSessions removes session files + blob dirs older than ttl', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-old';
    wm.recordRead(sid, '/x.md', 'content', { mtime: 'A' });
    const sessFile = wm.sessionFile(sid);
    const blobs = wm.blobDir(sid);
    assert.ok(fs.existsSync(sessFile));
    assert.ok(fs.existsSync(blobs));
    const old = (Date.now() - 48 * 3600 * 1000) / 1000;
    fs.utimesSync(sessFile, old, old);
    const result = wm.gcOldSessions({ ttl_hours: 24 });
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(sessFile), false);
    assert.equal(fs.existsSync(blobs), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('gcOldSessions keeps fresh sessions', () => {
  const home = tmpHome();
  try {
    wm.recordRead('sid-fresh', '/x.md', 'content', { mtime: 'A' });
    const result = wm.gcOldSessions({ ttl_hours: 24 });
    assert.equal(result.removed, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('matchBashAllowlist categorizes fs_read commands', () => {
  const cfg = {
    fs_read_patterns: ['^\\s*(grep|rg|egrep)\\s', '^\\s*find\\s', '^\\s*ls\\b', '^\\s*(cat|head|tail|wc)\\s'],
    state_probe_patterns: ['^\\s*git\\s+(log|status|diff)\\b'],
    fs_read_window_sec: 60,
    state_probe_window_sec: 30,
  };
  assert.deepEqual(wm.matchBashAllowlist('grep useAuth src/', cfg), { bucket: 'fs_read', window_sec: 60 });
  assert.deepEqual(wm.matchBashAllowlist('find . -name x', cfg),    { bucket: 'fs_read', window_sec: 60 });
  assert.deepEqual(wm.matchBashAllowlist('ls -la src',  cfg),       { bucket: 'fs_read', window_sec: 60 });
  assert.deepEqual(wm.matchBashAllowlist('cat README.md', cfg),     { bucket: 'fs_read', window_sec: 60 });
});

test('matchBashAllowlist categorizes state_probe commands', () => {
  const cfg = {
    fs_read_patterns: ['^\\s*(grep|rg|egrep)\\s'],
    state_probe_patterns: ['^\\s*git\\s+(log|status|diff)\\b', '^\\s*(npm|pnpm)\\s+(ls|list)\\b'],
    fs_read_window_sec: 60,
    state_probe_window_sec: 30,
  };
  assert.deepEqual(wm.matchBashAllowlist('git status', cfg),        { bucket: 'state_probe', window_sec: 30 });
  assert.deepEqual(wm.matchBashAllowlist('git log -10', cfg),       { bucket: 'state_probe', window_sec: 30 });
  assert.deepEqual(wm.matchBashAllowlist('npm ls --depth=0', cfg),  { bucket: 'state_probe', window_sec: 30 });
});

test('matchBashAllowlist returns null for unmatched commands', () => {
  const cfg = {
    fs_read_patterns: ['^\\s*grep\\s'],
    state_probe_patterns: ['^\\s*git\\s+status\\b'],
    fs_read_window_sec: 60,
    state_probe_window_sec: 30,
  };
  assert.equal(wm.matchBashAllowlist('npm test', cfg), null);
  assert.equal(wm.matchBashAllowlist('git pull', cfg), null);
  assert.equal(wm.matchBashAllowlist('rm -rf foo', cfg), null);
});

test('matchBashAllowlist prefers fs_read when both buckets match', () => {
  const cfg = {
    fs_read_patterns: ['ls'],
    state_probe_patterns: ['ls'],
    fs_read_window_sec: 60,
    state_probe_window_sec: 30,
  };
  assert.deepEqual(wm.matchBashAllowlist('ls /tmp', cfg), { bucket: 'fs_read', window_sec: 60 });
});

test('matchBashAllowlist tolerates broken patterns and skips them', () => {
  const cfg = {
    fs_read_patterns: ['(unclosed', '^\\s*grep\\s'],
    state_probe_patterns: [],
    fs_read_window_sec: 60,
    state_probe_window_sec: 30,
  };
  assert.deepEqual(wm.matchBashAllowlist('grep foo .', cfg), { bucket: 'fs_read', window_sec: 60 });
});
