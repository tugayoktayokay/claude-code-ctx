# Working Memory Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-scoped working memory that detects duplicate `Read` calls within a session and replaces the 2nd+ read with a short reference, cutting token waste from re-read `.md` files and delaying mid-session compaction.

**Architecture:** Pure-Node module `src/working_memory.js` maintains per-session state at `~/.config/ctx/working_memory/<sid>.json` (path→hash map) and `blobs/<sid>/<hash>.txt` (content). Hooks intercept Read in `src/hooks.js`: PreToolUse denies-with-redirect on hash match; PostToolUse records hash + content blob. New MCP tool `ctx_recall_read` lets Claude fetch cached content. Feature ships behind a config flag (`enabled: false` by default).

**Tech Stack:** Node 18+, `node:fs`, `node:crypto` (sha256), `node:test` + `node:assert/strict`. Zero runtime deps. No LLM calls.

---

## File structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/working_memory.js` | Pure module: session state I/O, hash, dedup decision, blob store |
| Create | `src/test/working_memory.test.js` | Unit tests for the module |
| Modify | `src/hooks.js` | PreToolUse + PostToolUse cases for `Read`; `Stop` hook GC trigger |
| Modify | `src/mcp_tools.js` | Add `ctx_recall_read` tool definition |
| Modify | `src/test/hooks.test.js` | Integration: dedup behavior end-to-end |
| Modify | `src/test/mcp_tools.test.js` | Integration: `ctx_recall_read` tool |
| Modify | `src/metrics.js` | Recognize new event types in `EVENT_TYPES` |
| Modify | `src/output.js` | Render dedup section in `ctx metrics` |
| Modify | `src/test/metrics.test.js` | Parse new event types correctly |
| Modify | `src/prune.js` | GC sweep for `working_memory/` >24h files |
| Modify | `src/test/prune.test.js` | Working-memory GC test |
| Modify | `config.default.json` | Add `working_memory` section |

---

## Task 1: Working memory module skeleton

**Files:**
- Create: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 1.1: Write the first failing test — load returns empty state for new session**

```js
// src/test/working_memory.test.js
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
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `Cannot find module '../working_memory.js'`

- [ ] **Step 1.3: Create the module with minimal load implementation**

```js
// src/working_memory.js
'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function baseDir() {
  return process.env.CTX_WORKING_MEMORY_DIR
    || path.join(os.homedir(), '.config', 'ctx', 'working_memory');
}

function sessionFile(sid) {
  return path.join(baseDir(), `${sid}.json`);
}

function blobDir(sid) {
  return path.join(baseDir(), 'blobs', sid);
}

function emptyState(sid) {
  return { session_id: sid, next_turn: 1, reads: {} };
}

function loadSession(sid) {
  const file = sessionFile(sid);
  if (!fs.existsSync(file)) return emptyState(sid);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.reads) return emptyState(sid);
    return parsed;
  } catch {
    return emptyState(sid);
  }
}

module.exports = { loadSession, baseDir, sessionFile, blobDir, emptyState };
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (1 test)

- [ ] **Step 1.5: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): module skeleton + loadSession for empty state"
```

---

## Task 2: Save/persist session state

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 2.1: Write the failing test — saveSession + loadSession round-trip**

Append to `src/test/working_memory.test.js`:

```js
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
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.saveSession is not a function`

- [ ] **Step 2.3: Add saveSession to module**

In `src/working_memory.js`, add:

```js
function saveSession(state) {
  if (!state || !state.session_id) return;
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = sessionFile(state.session_id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}
```

Update exports:
```js
module.exports = { loadSession, saveSession, baseDir, sessionFile, blobDir, emptyState };
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (2 tests)

- [ ] **Step 2.5: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): atomic saveSession round-trips with loadSession"
```

---

## Task 3: Hash + content blob storage

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 3.1: Write the failing test — writeBlob + readBlob round-trip with hash key**

Append to `src/test/working_memory.test.js`:

```js
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
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.hashContent is not a function`

- [ ] **Step 3.3: Add hash + blob helpers to module**

In `src/working_memory.js`, add:

```js
function hashContent(content) {
  const buf = typeof content === 'string' ? content : String(content);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function blobPath(sid, hash) {
  // hash is "sha256:abcd..." — replace ':' so it's a valid filename
  const safe = hash.replace(/:/g, '_');
  return path.join(blobDir(sid), safe + '.txt');
}

function writeBlob(sid, hash, content) {
  const dir = blobDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = blobPath(sid, hash);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readBlob(sid, hash) {
  const file = blobPath(sid, hash);
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
```

Update exports:
```js
module.exports = { loadSession, saveSession, baseDir, sessionFile, blobDir, emptyState, hashContent, writeBlob, readBlob, blobPath };
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (5 tests)

- [ ] **Step 3.5: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): hashContent + writeBlob/readBlob primitives"
```

---

## Task 4: Record + lookup helpers (record a read, find prior)

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 4.1: Write the failing test — recordRead appends entry, increments turn, caps to 5**

Append to `src/test/working_memory.test.js`:

```js
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
    assert.equal(state.next_turn, 8); // started at 1, +7 calls
    assert.equal(state.reads[filePath].length, 5); // capped
    // newest is last
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
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.recordRead is not a function`

- [ ] **Step 4.3: Add recordRead + lookupLatestRead to module**

In `src/working_memory.js`, add:

```js
const MAX_ENTRIES_PER_PATH = 5;

function recordRead(sid, filePath, content, opts = {}) {
  const state = loadSession(sid);
  const hash = hashContent(content);
  const entry = {
    turn: state.next_turn,
    hash,
    size: typeof content === 'string' ? content.length : 0,
    mtime: opts.mtime || null,
    ts: new Date().toISOString(),
  };
  if (!state.reads[filePath]) state.reads[filePath] = [];
  state.reads[filePath].push(entry);
  if (state.reads[filePath].length > MAX_ENTRIES_PER_PATH) {
    state.reads[filePath] = state.reads[filePath].slice(-MAX_ENTRIES_PER_PATH);
  }
  state.next_turn++;
  saveSession(state);
  writeBlob(sid, hash, content);
  return entry;
}

function lookupLatestRead(sid, filePath) {
  const state = loadSession(sid);
  const arr = state.reads[filePath];
  if (!arr || !arr.length) return null;
  return arr[arr.length - 1];
}
```

Update exports:
```js
module.exports = {
  loadSession, saveSession, baseDir, sessionFile, blobDir, emptyState,
  hashContent, writeBlob, readBlob, blobPath,
  recordRead, lookupLatestRead, MAX_ENTRIES_PER_PATH,
};
```

- [ ] **Step 4.4: Run tests to verify they pass**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (8 tests)

- [ ] **Step 4.5: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): recordRead + lookupLatestRead with 5-entry cap"
```

---

## Task 5: Dedup decision (recency + size + hash gates)

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 5.1: Write failing tests — dedupDecision honors recency, size, hash gates**

Append to `src/test/working_memory.test.js`:

```js
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
    const content = 'a'.repeat(2000); // > 1024 size gate
    wm.recordRead(sid, '/x.md', content, { mtime: 'A' });
    const d = wm.dedupDecision(sid, '/x.md', content, {
      mtime: 'A', current_turn: 5, recency_window_turns: 30, min_dedup_size_bytes: 1024,
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
      mtime: 'A', current_turn: 2, recency_window_turns: 30, min_dedup_size_bytes: 1024,
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
      mtime: 'A', current_turn: 2, recency_window_turns: 30, min_dedup_size_bytes: 1024,
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
    const d = wm.dedupDecision(sid, '/x.md', content, {
      mtime: 'A', current_turn: 50, recency_window_turns: 30, min_dedup_size_bytes: 1024,
    });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.dedupDecision is not a function`

- [ ] **Step 5.3: Add dedupDecision to module**

In `src/working_memory.js`, add:

```js
function dedupDecision(sid, filePath, content, opts = {}) {
  const prior = lookupLatestRead(sid, filePath);
  if (!prior) return null;

  const minSize = opts.min_dedup_size_bytes ?? 1024;
  const recencyWindow = opts.recency_window_turns ?? 30;
  const currentTurn = opts.current_turn ?? (loadSession(sid).next_turn);

  const size = typeof content === 'string' ? content.length : 0;
  if (size < minSize) return null;

  if (currentTurn - prior.turn > recencyWindow) return null;

  const hash = hashContent(content);
  if (hash !== prior.hash) return null;

  return {
    action: 'dedup',
    priorTurn: prior.turn,
    hash: prior.hash,
    size: prior.size,
    recordedAt: prior.ts,
  };
}
```

Update exports to include `dedupDecision`.

- [ ] **Step 5.4: Run tests to verify they pass**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (13 tests)

- [ ] **Step 5.5: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): dedupDecision with hash/size/recency gates"
```

---

## Task 6: GC sweep for old session files

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 6.1: Write failing test — gcOldSessions removes files older than ttl**

Append to `src/test/working_memory.test.js`:

```js
test('gcOldSessions removes session files + blob dirs older than ttl', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-old';
    wm.recordRead(sid, '/x.md', 'content', { mtime: 'A' });
    const sessFile = wm.sessionFile(sid);
    const blobs = wm.blobDir(sid);
    assert.ok(fs.existsSync(sessFile));
    assert.ok(fs.existsSync(blobs));
    // backdate
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
```

- [ ] **Step 6.2: Run tests to verify they fail**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.gcOldSessions is not a function`

- [ ] **Step 6.3: Add gcOldSessions to module**

In `src/working_memory.js`, add:

```js
function gcOldSessions(opts = {}) {
  const dir = baseDir();
  if (!fs.existsSync(dir)) return { removed: 0, bytes_freed: 0 };
  const ttlMs = (opts.ttl_hours || 24) * 3600 * 1000;
  const now = Date.now();
  let removed = 0;
  let bytesFreed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { removed: 0, bytes_freed: 0 }; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs <= ttlMs) continue;
    const sid = n.slice(0, -5);
    const blobs = blobDir(sid);
    let blobSize = 0;
    try {
      if (fs.existsSync(blobs)) {
        for (const bf of fs.readdirSync(blobs)) {
          try { blobSize += fs.statSync(path.join(blobs, bf)).size; } catch {}
        }
        fs.rmSync(blobs, { recursive: true, force: true });
      }
    } catch {}
    try { fs.unlinkSync(file); removed++; bytesFreed += st.size + blobSize; } catch {}
  }
  return { removed, bytes_freed: bytesFreed };
}
```

Update exports to include `gcOldSessions`.

- [ ] **Step 6.4: Run tests to verify they pass**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (15 tests)

- [ ] **Step 6.5: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): gcOldSessions removes session + blobs >ttl"
```

---

## Task 7: Config defaults

**Files:**
- Modify: `config.default.json`
- Test: existing config tests should still pass.

- [ ] **Step 7.1: Add `working_memory` section to config.default.json**

Find the `"cache"` section (around line 56) and insert AFTER it:

```json
  "working_memory": {
    "enabled": false,
    "min_dedup_size_bytes": 1024,
    "recency_window_turns": 30,
    "ttl_hours": 24
  },
```

- [ ] **Step 7.2: Verify JSON is valid + full suite still passes**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.default.json'))" && node --test src/test/*.test.js`
Expected: no JSON parse error, 194 tests still pass.

- [ ] **Step 7.3: Commit**

```bash
git add config.default.json
git commit -m "feat(config): add working_memory section with safe defaults (enabled=false)"
```

---

## Task 8: PreToolUse hook integration — Read dedup

**Files:**
- Modify: `src/hooks.js`
- Test: `src/test/hooks.test.js`

- [ ] **Step 8.1: Write the failing integration test**

Append to `src/test/hooks.test.js`:

```js
test('PreToolUse Read: second identical Read triggers dedup deny + recall hint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-hook-'));
  const targetFile = path.join(tmp, 'CLAUDE.md');
  const content = 'a'.repeat(2000);
  fs.writeFileSync(targetFile, content);

  // Isolate working memory dir
  const wmDir = path.join(tmp, 'wm');
  process.env.CTX_WORKING_MEMORY_DIR = wmDir;

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: true, min_dedup_size_bytes: 1024, recency_window_turns: 30, ttl_hours: 24 };

    const sid = 'hook-sid-1';

    // Simulate first Read having already happened (record it)
    const wm = require('../working_memory.js');
    wm.recordRead(sid, targetFile, content, { mtime: 'A' });

    const res = handlePreToolUse(
      { session_id: sid, tool_name: 'Read', tool_input: { file_path: targetFile } },
      cfg,
    );

    assert.equal(res.output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      res.output.hookSpecificOutput.permissionDecisionReason,
      /working_memory.*Already read.*ctx_recall_read/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Read: first Read passes through (no prior record)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-hook-'));
  const targetFile = path.join(tmp, 'README.md');
  fs.writeFileSync(targetFile, 'x'.repeat(2000));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: true, min_dedup_size_bytes: 1024, recency_window_turns: 30, ttl_hours: 24 };

    const res = handlePreToolUse(
      { session_id: 'sid-fresh', tool_name: 'Read', tool_input: { file_path: targetFile } },
      cfg,
    );

    assert.equal(res.output, null); // pass through
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Read: disabled flag bypasses dedup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-hook-'));
  const targetFile = path.join(tmp, 'CLAUDE.md');
  const content = 'a'.repeat(2000);
  fs.writeFileSync(targetFile, content);
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: false };

    const wm = require('../working_memory.js');
    wm.recordRead('sid-off', targetFile, content, { mtime: 'A' });

    const res = handlePreToolUse(
      { session_id: 'sid-off', tool_name: 'Read', tool_input: { file_path: targetFile } },
      cfg,
    );

    assert.equal(res.output, null); // pass through, no dedup
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 8.2: Run tests to verify they fail**

Run: `node --test src/test/hooks.test.js`
Expected: FAIL on the new tests (Read goes through unconditionally; no working memory branch).

- [ ] **Step 8.3: Add working memory branch to handlePreToolUse**

In `src/hooks.js`, find `function handlePreToolUse(input, config) {` (line ~168) and insert this block at the top of the function body, BEFORE the `const pre = config?.hooks?.pre_tool_use;` line:

```js
  // Working memory dedup branch (Phase 1)
  try {
    const wmCfg = config?.working_memory;
    if (wmCfg?.enabled && input.tool_name === 'Read') {
      const sid = String(input.session_id || '-');
      const filePath = input.tool_input?.file_path || '';
      if (sid !== '-' && filePath && fs.existsSync(filePath)) {
        const wm = require('./working_memory.js');
        const stat = fs.statSync(filePath);
        const minSize = wmCfg.min_dedup_size_bytes ?? 1024;
        if (stat.size >= minSize) {
          const content = fs.readFileSync(filePath, 'utf8');
          const decision = wm.dedupDecision(sid, filePath, content, {
            mtime: stat.mtimeMs,
            min_dedup_size_bytes: minSize,
            recency_window_turns: wmCfg.recency_window_turns ?? 30,
          });
          if (decision && decision.action === 'dedup') {
            const reason =
              `[ctx working_memory] Already read at turn ${decision.priorTurn} (${decision.size}B). Content unchanged.\n` +
              `• Recall: ctx_recall_read({path: "${filePath}"}) returns cached content with ~200B meta.\n` +
              `• Trust your context: the prior read is still in your conversation history.`;
            const sessLog = sid.replace(/\s+/g, '_');
            logHook(config, `working_memory action=dedup_hit session=${sessLog} path="${filePath}" prior_turn=${decision.priorTurn} bytes_saved=${decision.size}`);
            return {
              output: {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: 'deny',
                  permissionDecisionReason: reason,
                },
              },
              exitCode: 0,
            };
          }
        }
      }
    }
  } catch (err) {
    logHook(config, `working_memory error in pre_tool: ${err.message}`);
  }
  // --- end working memory branch ---

```

- [ ] **Step 8.4: Run hook tests to verify they pass**

Run: `node --test src/test/hooks.test.js`
Expected: PASS (29 tests — 26 prior + 3 new).

- [ ] **Step 8.5: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: 197 passing (194 prior + 3 new).

- [ ] **Step 8.6: Commit**

```bash
git add src/hooks.js src/test/hooks.test.js
git commit -m "feat(hooks): PreToolUse Read dedup via working_memory module"
```

---

## Task 9: PostToolUse hook integration — record reads

**Files:**
- Modify: `src/hooks.js`
- Test: `src/test/hooks.test.js`

- [ ] **Step 9.1: Write the failing test**

Append to `src/test/hooks.test.js`:

```js
test('PostToolUse Read records content in working memory', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-post-'));
  const targetFile = path.join(tmp, 'README.md');
  const content = 'r'.repeat(1500);
  fs.writeFileSync(targetFile, content);
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: true, min_dedup_size_bytes: 1024, recency_window_turns: 30, ttl_hours: 24 };

    const sid = 'sid-post-1';
    await handlePostToolUse(
      {
        session_id: sid,
        tool_name: 'Read',
        tool_input: { file_path: targetFile },
        tool_response: { content },
      },
      cfg,
    );

    const wm = require('../working_memory.js');
    const last = wm.lookupLatestRead(sid, targetFile);
    assert.ok(last);
    assert.equal(last.size, 1500);
    assert.equal(last.hash, wm.hashContent(content));

    const blob = wm.readBlob(sid, last.hash);
    assert.equal(blob, content);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 9.2: Run test to verify it fails**

Run: `node --test src/test/hooks.test.js`
Expected: FAIL — `lookupLatestRead` returns null (no record happened).

- [ ] **Step 9.3: Add recording branch to handlePostToolUse**

In `src/hooks.js`, find `async function handlePostToolUse(input, config) {` (line ~211). Inside the existing `try { ... } catch {}` block (after the `logHook(config, post_tool ...)` line, around line 244), append:

```js
    // --- working memory: record Read content (Phase 1) ---
    try {
      const wmCfg = config?.working_memory;
      if (wmCfg?.enabled && toolName === 'Read') {
        const filePath = ti.file_path || '';
        const tr2 = input.tool_response;
        const body = (tr2 && typeof tr2.content === 'string') ? tr2.content : null;
        const sidRec = String(input.session_id || '-');
        if (filePath && body !== null && sidRec !== '-' && body.length >= (wmCfg.min_dedup_size_bytes ?? 1024)) {
          const wm = require('./working_memory.js');
          const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
          wm.recordRead(sidRec, filePath, body, { mtime: stat ? stat.mtimeMs : null });
        }
      }
    } catch (err) {
      logHook(config, `working_memory error in post_tool: ${err.message}`);
    }
    // --- end working memory record ---
```

- [ ] **Step 9.4: Run test to verify it passes**

Run: `node --test src/test/hooks.test.js`
Expected: PASS (30 tests).

- [ ] **Step 9.5: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: 198 passing.

- [ ] **Step 9.6: Commit**

```bash
git add src/hooks.js src/test/hooks.test.js
git commit -m "feat(hooks): PostToolUse Read records content in working_memory"
```

---

## Task 10: ctx_recall_read MCP tool

**Files:**
- Modify: `src/mcp_tools.js`
- Test: `src/test/mcp_tools.test.js`

- [ ] **Step 10.1: Write the failing test**

Append to `src/test/mcp_tools.test.js`:

```js
const fs2 = require('node:fs');
const os2 = require('node:os');
const path2 = require('node:path');

test('ctx_recall_read returns cached content for previously recorded path', async () => {
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ctx-wm-mcp-'));
  process.env.CTX_WORKING_MEMORY_DIR = path2.join(tmp, 'wm');
  const wm = require('../working_memory.js');

  try {
    const sid = 'sid-mcp-1';
    const filePath = '/abs/CLAUDE.md';
    const content = 'CLAUDE rules go here';
    wm.recordRead(sid, filePath, content);

    const { allTools } = require('../mcp_tools.js');
    const tool = allTools().find(t => t.name === 'ctx_recall_read');
    assert.ok(tool, 'ctx_recall_read tool registered');

    const res = await tool.handler({ path: filePath, session_id: sid }, { config: {} });
    assert.match(res, /CLAUDE rules go here/);
    assert.match(res, /turn=1/);
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('ctx_recall_read returns error for unknown path', async () => {
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ctx-wm-mcp-'));
  process.env.CTX_WORKING_MEMORY_DIR = path2.join(tmp, 'wm');
  try {
    const { allTools } = require('../mcp_tools.js');
    const tool = allTools().find(t => t.name === 'ctx_recall_read');
    const res = await tool.handler({ path: '/nope.md', session_id: 'sid-x' }, { config: {} });
    assert.match(res, /no working memory record/);
  } finally {
    fs2.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 10.2: Run tests to verify they fail**

Run: `node --test src/test/mcp_tools.test.js`
Expected: FAIL — tool not registered.

- [ ] **Step 10.3: Register `ctx_recall_read` in `src/mcp_tools.js`**

In `src/mcp_tools.js`, find the line `const memoryTools = [` and append a new entry to that array (insert just BEFORE the closing `];` of `memoryTools`):

```js
  {
    name: 'ctx_recall_read',
    description: 'Recall the contents of a file you previously Read in this session — returns cached content without re-reading from disk. Use after seeing a [ctx working_memory] dedup notice in a denied Read.',
    inputSchema: {
      type: 'object',
      properties: {
        path:       { type: 'string', description: 'Absolute path of the previously-read file.' },
        session_id: { type: 'string', description: 'Session id (the harness usually fills this; pass-through).' },
      },
      required: ['path'],
    },
    handler: async (args, { config: _config } = {}) => {
      const wm = require('./working_memory.js');
      const filePath = String(args.path || '');
      const sid = String(args.session_id || process.env.CLAUDE_SESSION_ID || '-');
      if (!filePath) return okText('error: missing path');
      const last = wm.lookupLatestRead(sid, filePath);
      if (!last) return okText(`error: no working memory record for ${filePath}`);
      const blob = wm.readBlob(sid, last.hash);
      if (blob == null) return okText(`error: blob missing for hash ${last.hash}`);
      return okText(
        `[ctx_recall_read ${filePath}, ${last.size}B, turn=${last.turn}, hash=${last.hash.slice(0, 22)}, recorded=${last.ts}]\n${blob}`,
      );
    },
  },
```

- [ ] **Step 10.4: Run tests to verify they pass**

Run: `node --test src/test/mcp_tools.test.js`
Expected: PASS (existing + 2 new).

- [ ] **Step 10.5: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: 200 passing.

- [ ] **Step 10.6: Commit**

```bash
git add src/mcp_tools.js src/test/mcp_tools.test.js
git commit -m "feat(mcp): ctx_recall_read tool returns cached content for prior Reads"
```

---

## Task 11: Metrics — recognize new event types

**Files:**
- Modify: `src/metrics.js`
- Test: `src/test/metrics.test.js`

- [ ] **Step 11.1: Write the failing test**

Append to `src/test/metrics.test.js`:

```js
test('parseLog recognizes working_memory event types', () => {
  const { parseLogString } = require('../metrics.js');
  const lines = [
    '2026-04-29T10:00:00.000Z working_memory action=dedup_hit session=sid-1 path="/x.md" prior_turn=3 bytes_saved=2000',
    '2026-04-29T10:01:00.000Z working_memory action=recall_call session=sid-1 path="/x.md" hit=true',
  ].join('\n');
  const { records, parseErrors } = parseLogString(lines);
  assert.equal(parseErrors, 0);
  assert.equal(records.length, 2);
  assert.equal(records[0].evType, 'working_memory');
  assert.equal(records[0].action, 'dedup_hit');
  assert.equal(records[0].path, '/x.md');
  assert.equal(records[1].action, 'recall_call');
  assert.equal(records[1].hit, 'true');
});
```

- [ ] **Step 11.2: Run test to verify it fails**

Run: `node --test src/test/metrics.test.js`
Expected: FAIL with parseErrors > 0 (`unknown event type`).

- [ ] **Step 11.3: Add `working_memory` to EVENT_TYPES in `src/metrics.js`**

Change line 5:

```js
const EVENT_TYPES = ['pre_tool', 'post_tool', 'cache-write', 'cache-read', 'cache-gc', 'working_memory'];
```

- [ ] **Step 11.4: Run test to verify it passes**

Run: `node --test src/test/metrics.test.js`
Expected: PASS.

- [ ] **Step 11.5: Commit**

```bash
git add src/metrics.js src/test/metrics.test.js
git commit -m "feat(metrics): recognize working_memory event type"
```

---

## Task 12: Metrics aggregation — dedup hit rate + recall rate

**Files:**
- Modify: `src/metrics.js`
- Modify: `src/output.js`
- Test: `src/test/metrics.test.js` and `src/test/output.test.js`

- [ ] **Step 12.1: Write the failing test for aggregation**

Append to `src/test/metrics.test.js`:

```js
test('aggregateMetrics surfaces working_memory dedup + recall counts', () => {
  const { parseLogString, aggregateMetrics } = require('../metrics.js');
  const lines = [
    '2026-04-29T10:00:00.000Z working_memory action=dedup_hit session=s1 path="/a.md" prior_turn=3 bytes_saved=2000',
    '2026-04-29T10:01:00.000Z working_memory action=dedup_hit session=s1 path="/b.md" prior_turn=4 bytes_saved=1500',
    '2026-04-29T10:02:00.000Z working_memory action=recall_call session=s1 path="/a.md" hit=true',
  ].join('\n');
  const { records } = parseLogString(lines);
  const agg = aggregateMetrics(records);
  assert.ok(agg.working_memory);
  assert.equal(agg.working_memory.dedup_hits, 2);
  assert.equal(agg.working_memory.bytes_saved, 3500);
  assert.equal(agg.working_memory.recall_calls, 1);
  assert.equal(agg.working_memory.recall_rate, 0.5); // 1 recall / 2 dedups
});
```

- [ ] **Step 12.2: Run test to verify it fails**

Run: `node --test src/test/metrics.test.js`
Expected: FAIL — `aggregateMetrics` is missing or doesn't include `working_memory`.

- [ ] **Step 12.3: Locate or add `aggregateMetrics` in `src/metrics.js`**

Find the existing aggregate function (search for `function aggregate` or `correlate`). The existing module exports `correlate`. Add a new exported helper that calls `correlate` AND tallies working memory:

In `src/metrics.js`, append before the `module.exports` block:

```js
function aggregateMetrics(records) {
  const corr = correlate(records);
  const wm = { dedup_hits: 0, bytes_saved: 0, recall_calls: 0, recall_rate: 0 };
  for (const r of records) {
    if (r.evType !== 'working_memory') continue;
    if (r.action === 'dedup_hit') {
      wm.dedup_hits++;
      const n = Number(r.bytes_saved);
      if (Number.isFinite(n)) wm.bytes_saved += n;
    } else if (r.action === 'recall_call') {
      wm.recall_calls++;
    }
  }
  wm.recall_rate = wm.dedup_hits ? wm.recall_calls / wm.dedup_hits : 0;
  return { ...(corr || {}), working_memory: wm };
}
```

Update module.exports to include `aggregateMetrics`.

NOTE: The `correlate()` function exists; verify by running `node -e "console.log(Object.keys(require('./src/metrics.js')))"` — it should list `correlate`. If `aggregateMetrics` already exists in some form, integrate the working_memory tally into the existing function instead of creating a new wrapper.

- [ ] **Step 12.4: Run test to verify it passes**

Run: `node --test src/test/metrics.test.js`
Expected: PASS.

- [ ] **Step 12.5: Add output rendering test**

Append to `src/test/output.test.js` (find existing test that renders metrics output and add):

```js
test('renderMetrics shows working memory section when records present', () => {
  const { renderMetrics } = require('../output.js');
  const result = {
    pre_tool: { total: 0, deny: { total: 0 }, ask: { total: 0 } },
    cache:    { writes: 0, reads: 0, hits: 0, misses: 0 },
    working_memory: { dedup_hits: 5, bytes_saved: 12345, recall_calls: 1, recall_rate: 0.2 },
  };
  // Capture stdout
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try { renderMetrics(result); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /working memory/);
  assert.match(out, /dedup hits:\s+5/);
  assert.match(out, /12.*KB/); // bytes_saved formatted
});
```

- [ ] **Step 12.6: Run output test — verify it fails**

Run: `node --test src/test/output.test.js`
Expected: FAIL — no working memory rendering yet.

- [ ] **Step 12.7: Add rendering to `src/output.js::renderMetrics`**

Find `renderMetrics` (around line 269 — search for `function renderMetrics`). Inside the function, AFTER the cache section block but BEFORE the function returns/closes, add:

```js
  if (r.working_memory && (r.working_memory.dedup_hits || r.working_memory.recall_calls)) {
    const wm = r.working_memory;
    const kbSaved = (wm.bytes_saved / 1024).toFixed(1);
    const recallPct = (wm.recall_rate * 100).toFixed(0);
    console.log('');
    console.log(C.dim + '  working memory (last 7d):' + C.reset);
    console.log(`    dedup hits:    ${C.green}${wm.dedup_hits}${C.reset} (saved ${kbSaved} KB)`);
    console.log(`    recall calls:  ${wm.recall_calls}`);
    console.log(`    recall rate:   ${recallPct}% ${recallPct >= 50 ? '(high — consider disabling)' : '(healthy)'}`);
  }
```

- [ ] **Step 12.8: Run output test — verify it passes**

Run: `node --test src/test/output.test.js`
Expected: PASS.

- [ ] **Step 12.9: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: 203 passing (or so — confirm count rose to match additions).

- [ ] **Step 12.10: Commit**

```bash
git add src/metrics.js src/output.js src/test/metrics.test.js src/test/output.test.js
git commit -m "feat(metrics): aggregate + render working_memory dedup/recall stats"
```

---

## Task 13: Wire recall_call logging when ctx_recall_read is invoked

**Files:**
- Modify: `src/mcp_tools.js`
- Test: `src/test/mcp_tools.test.js`

- [ ] **Step 13.1: Write the failing test**

Append to `src/test/mcp_tools.test.js`:

```js
test('ctx_recall_read logs working_memory recall_call event', async () => {
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'ctx-wm-mcp-log-'));
  const fakeHome = path2.join(tmp, 'home');
  fs2.mkdirSync(path2.join(fakeHome, '.config', 'ctx'), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.CTX_WORKING_MEMORY_DIR = path2.join(tmp, 'wm');
  const wm = require('../working_memory.js');

  try {
    wm.recordRead('sid-log', '/x.md', 'big content here that is large enough');

    // Bust require cache so mcp_tools picks up env-aware logHook path
    delete require.cache[require.resolve('../mcp_tools.js')];
    const { allTools } = require('../mcp_tools.js');
    const tool = allTools().find(t => t.name === 'ctx_recall_read');
    await tool.handler({ path: '/x.md', session_id: 'sid-log' }, { config: {} });

    const logFile = path2.join(fakeHome, '.config', 'ctx', 'hooks.log');
    assert.ok(fs2.existsSync(logFile));
    const log = fs2.readFileSync(logFile, 'utf8');
    assert.match(log, /working_memory action=recall_call session=sid-log .*hit=true/);
  } finally {
    process.env.HOME = origHome;
    fs2.rmSync(tmp, { recursive: true, force: true });
    delete require.cache[require.resolve('../mcp_tools.js')];
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 13.2: Run test to verify it fails**

Run: `node --test src/test/mcp_tools.test.js`
Expected: FAIL — log line not found (no logging in handler yet).

- [ ] **Step 13.3: Add logging in `ctx_recall_read` handler**

In `src/mcp_tools.js`, modify the `ctx_recall_read` handler (added in Task 10) to log. Place this snippet at the TOP of the handler, after `const filePath = ...`:

```js
      const logRecall = (hit) => {
        try {
          const osMod = require('node:os');
          const pathMod = require('node:path');
          const fsMod = require('node:fs');
          const logPath = pathMod.join(osMod.homedir(), '.config', 'ctx', 'hooks.log');
          fsMod.mkdirSync(pathMod.dirname(logPath), { recursive: true });
          const safeSid = sid.replace(/\s+/g, '_');
          fsMod.appendFileSync(logPath, `${new Date().toISOString()} working_memory action=recall_call session=${safeSid} path="${filePath}" hit=${hit}\n`);
        } catch {}
      };
```

Then in the handler logic, call `logRecall(true)` when content found, `logRecall(false)` on the error branches. Final handler:

```js
    handler: async (args, { config: _config } = {}) => {
      const wm = require('./working_memory.js');
      const filePath = String(args.path || '');
      const sid = String(args.session_id || process.env.CLAUDE_SESSION_ID || '-');
      const logRecall = (hit) => {
        try {
          const osMod = require('node:os');
          const pathMod = require('node:path');
          const fsMod = require('node:fs');
          const logPath = pathMod.join(osMod.homedir(), '.config', 'ctx', 'hooks.log');
          fsMod.mkdirSync(pathMod.dirname(logPath), { recursive: true });
          const safeSid = sid.replace(/\s+/g, '_');
          fsMod.appendFileSync(logPath, `${new Date().toISOString()} working_memory action=recall_call session=${safeSid} path="${filePath}" hit=${hit}\n`);
        } catch {}
      };
      if (!filePath) { logRecall(false); return okText('error: missing path'); }
      const last = wm.lookupLatestRead(sid, filePath);
      if (!last) { logRecall(false); return okText(`error: no working memory record for ${filePath}`); }
      const blob = wm.readBlob(sid, last.hash);
      if (blob == null) { logRecall(false); return okText(`error: blob missing for hash ${last.hash}`); }
      logRecall(true);
      return okText(
        `[ctx_recall_read ${filePath}, ${last.size}B, turn=${last.turn}, hash=${last.hash.slice(0, 22)}, recorded=${last.ts}]\n${blob}`,
      );
    },
```

- [ ] **Step 13.4: Run test to verify it passes**

Run: `node --test src/test/mcp_tools.test.js`
Expected: PASS.

- [ ] **Step 13.5: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: previous count + 1.

- [ ] **Step 13.6: Commit**

```bash
git add src/mcp_tools.js src/test/mcp_tools.test.js
git commit -m "feat(mcp): ctx_recall_read logs working_memory recall_call event"
```

---

## Task 14: GC integration in `ctx prune`

**Files:**
- Modify: `src/prune.js`
- Modify: `src/cli.js` (verify prune entry already calls a top-level prune function)
- Test: `src/test/prune.test.js`

- [ ] **Step 14.1: Write the failing test**

Append to `src/test/prune.test.js`:

```js
test('applyPrune cascades to working_memory.gcOldSessions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-prune-wm-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');
  const wm = require('../working_memory.js');
  try {
    wm.recordRead('sid-old', '/x.md', 'content');
    const sessFile = wm.sessionFile('sid-old');
    const old = (Date.now() - 48 * 3600 * 1000) / 1000;
    fs.utimesSync(sessFile, old, old);

    const { pruneWorkingMemory } = require('../prune.js');
    const result = pruneWorkingMemory({ ttl_hours: 24 });
    assert.equal(result.removed, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 14.2: Run test to verify it fails**

Run: `node --test src/test/prune.test.js`
Expected: FAIL — `pruneWorkingMemory` is not defined.

- [ ] **Step 14.3: Add wrapper in `src/prune.js`**

In `src/prune.js`, add at module level:

```js
function pruneWorkingMemory(opts = {}) {
  const wm = require('./working_memory.js');
  return wm.gcOldSessions(opts);
}
```

Update exports:
```js
module.exports = {
  parseDuration,
  listProjectMemoryDirs,
  planPrune,
  applyPrune,
  planFromOpts,
  pruneWorkingMemory,
};
```

- [ ] **Step 14.4: Wire from CLI: when `ctx prune` runs, invoke working memory GC too**

Find `cli.js` prune handler (search `case 'prune'` or similar). Inside that handler, AFTER existing memory-dir prune logic but BEFORE the final summary print, add:

```js
      try {
        const { pruneWorkingMemory } = require('./prune.js');
        const wmRes = pruneWorkingMemory({ ttl_hours: 24 });
        if (wmRes.removed) {
          console.log(`  working_memory: removed ${wmRes.removed} session file(s), freed ${(wmRes.bytes_freed/1024).toFixed(1)} KB`);
        }
      } catch {}
```

- [ ] **Step 14.5: Run prune test — verify it passes**

Run: `node --test src/test/prune.test.js`
Expected: PASS.

- [ ] **Step 14.6: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: full pass.

- [ ] **Step 14.7: Commit**

```bash
git add src/prune.js src/cli.js src/test/prune.test.js
git commit -m "feat(prune): cascade ctx prune to working_memory GC sweep"
```

---

## Task 15: Doctor + statusline awareness (optional polish)

**Files:**
- Modify: `src/doctor.js`
- Modify: `src/test/doctor.test.js` if it exists, otherwise skip the test step

- [ ] **Step 15.1: Add a doctor check entry**

Find `src/doctor.js` and locate the array of checks. Add a new check entry after the existing cache check:

```js
  {
    label: 'Working memory dir',
    fn: () => {
      const dir = process.env.CTX_WORKING_MEMORY_DIR
        || require('node:path').join(require('node:os').homedir(), '.config', 'ctx', 'working_memory');
      const fsMod = require('node:fs');
      if (!fsMod.existsSync(dir)) return { ok: true, info: 'not yet created (will create on first use)' };
      try {
        const entries = fsMod.readdirSync(dir).filter(n => n.endsWith('.json'));
        return { ok: true, info: `${entries.length} session file(s)` };
      } catch (e) {
        return { ok: false, info: `cannot read: ${e.message}` };
      }
    },
  },
```

NOTE: the exact array shape in `doctor.js` may differ — use the existing entries as a template. If the file uses a procedural style, append a console.log section in the same pattern.

- [ ] **Step 15.2: Run `./bin/ctx doctor` to verify the new line appears**

Run: `./bin/ctx doctor`
Expected: a `Working memory dir` line in the output.

- [ ] **Step 15.3: Commit**

```bash
git add src/doctor.js
git commit -m "feat(doctor): add working_memory dir health check"
```

---

## Task 16: Documentation update in CLAUDE.md invariants

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 16.1: Add invariant entry**

Open `CLAUDE.md`. Find the `## Hard invariants (do not violate)` section. Add a new bullet at the end of the list:

```markdown
- **Working memory is per-session and ephemeral.** Stored under `~/.config/ctx/working_memory/<sid>.{json,blobs/...}`. Hash-gated — files that changed always get a fresh Read. Disable via `working_memory.enabled = false` (default).
```

- [ ] **Step 16.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document working_memory invariant"
```

---

## Task 17: Final integration sweep

- [ ] **Step 17.1: Run full test suite**

Run: `node --test src/test/*.test.js`
Expected: All tests pass. Note final count.

- [ ] **Step 17.2: Run doctor**

Run: `./bin/ctx doctor`
Expected: `all checks passed`. Working memory line present.

- [ ] **Step 17.3: Smoke test — manually flip flag on**

Edit `~/.config/ctx/config.json` (create if missing):
```json
{ "working_memory": { "enabled": true } }
```
Then in a real Claude Code session: open a project, `Read` `CLAUDE.md`, then ask Claude to `Read` it again. Confirm second read returns dedup deny + reason. Confirm `ctx_recall_read({path: "..."})` returns content.

- [ ] **Step 17.4: Verify metrics**

Run: `./bin/ctx metrics`
Expected: a `working memory` section appears with `dedup hits: 1+` after smoke test.

- [ ] **Step 17.5: Bump version + tag**

Edit `package.json` and `.claude-plugin/plugin.json`: bump version to `0.8.0-rc.1`.

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore(0.8.0-rc.1): release candidate for working_memory phase 1"
```

- [ ] **Step 17.6: Final commit if any drift**

Run `git status` — if anything stray, address. Otherwise: done.

---

## Self-review checklist

- [x] Spec coverage: all 4 hook flow steps, ctx_recall_read tool, metrics events, GC sweep, config defaults — all have tasks.
- [x] No placeholders: every step shows code or exact commands.
- [x] Type consistency: `recordRead` signature `(sid, path, content, opts)` matches all call sites.
- [x] Test count: each task adds tests; final suite should reach ~210 tests.

## Open notes for the implementer

- **Storage path env var.** `CTX_WORKING_MEMORY_DIR` overrides the home-derived path. Use it in tests to isolate state. Production code never sets it.
- **`.tmp + rename` pattern** for atomic writes follows the existing `snapshot.js` and `mcp_cache.js` style.
- **Hook degradation:** every working_memory branch is wrapped in `try { ... } catch (err) { logHook(...) }` so a module bug never blocks Claude's Read.
- **Faz 1.4 (default flips to enabled=true)** is NOT in this plan. After 1-2 weeks of metrics on opt-in users, open a follow-up PR that flips the default.
