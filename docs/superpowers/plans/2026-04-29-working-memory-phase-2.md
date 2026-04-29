# Working Memory Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bash tool-call dedup. When Claude runs a read-only or state-probe command (grep, find, ls, cat, git status, etc.) twice within a short window (60s for fs reads, 30s for state probes), the second call is intercepted by PreToolUse and replaced with a deny+redirect that points to a cached `ctx_cache_get({ref})`.

**Architecture:** Extend Phase 1's `working_memory.js` module with `recordBashCall()`, `lookupLatestBashCall()`, `bashDedupDecision()`. Per-session state at `~/.config/ctx/working_memory/<sid>.json` gains a new `bash_calls` field keyed by `<cwd>|<cmd_norm>`. Output blobs go through the existing `mcp_cache.js`, no new storage. Two independent enable flags: `working_memory.enabled` (Phase 1) and `working_memory.bash_dedup.enabled` (Phase 2).

**Tech Stack:** Node 18+, `node:fs`, `node:crypto`, `node:test` + `node:assert/strict`. Zero runtime deps. No LLM calls.

---

## File structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/working_memory.js` | Add `matchBashAllowlist`, `recordBashCall`, `lookupLatestBashCall`, `bashDedupDecision`, `cmdNorm` |
| Modify | `src/test/working_memory.test.js` | Unit tests for the new functions |
| Modify | `src/hooks.js` | PreToolUse Bash dedup branch + PostToolUse Bash recording branch |
| Modify | `src/test/hooks.test.js` | Integration tests for both hook paths |
| Modify | `src/metrics.js` | Extend `aggregateMetrics` with `bash_dedup_hits` + `bash_bytes_saved` tally |
| Modify | `src/test/metrics.test.js` | New aggregation test |
| Modify | `src/output.js` | Render `bash dedup hits` line in the working memory section |
| Modify | `src/test/output.test.js` | Update fixture to assert bash line |
| Modify | `config.default.json` | Add `bash_dedup` subsection under `working_memory` |
| Modify | `CLAUDE.md` | Update working memory invariant to mention bash_calls |

No new files. No new MCP tools.

---

## Task 1: Allowlist matcher helper

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 1.1: Append failing tests**

Append to `src/test/working_memory.test.js`:

```js
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
```

- [ ] **Step 1.2: Run, verify FAIL**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.matchBashAllowlist is not a function`.

- [ ] **Step 1.3: Add `matchBashAllowlist` and `cmdNorm` to module**

Add to `src/working_memory.js` (anywhere in the function area):

```js
function cmdNorm(cmd) {
  return String(cmd || '').replace(/^\s+|\s+$/g, '').replace(/[ \t]+/g, ' ');
}

function matchBashAllowlist(cmd, cfg) {
  if (!cmd || !cfg) return null;
  const fsRead = cfg.fs_read_patterns || [];
  const stateProbe = cfg.state_probe_patterns || [];
  for (const pat of fsRead) {
    try { if (new RegExp(pat).test(cmd)) return { bucket: 'fs_read', window_sec: cfg.fs_read_window_sec ?? 60 }; }
    catch { continue; }
  }
  for (const pat of stateProbe) {
    try { if (new RegExp(pat).test(cmd)) return { bucket: 'state_probe', window_sec: cfg.state_probe_window_sec ?? 30 }; }
    catch { continue; }
  }
  return null;
}
```

Update `module.exports` to include `cmdNorm` and `matchBashAllowlist`.

- [ ] **Step 1.4: Run tests, verify PASS**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (all existing + 5 new).

- [ ] **Step 1.5: Run full suite**

Run: `node --test src/test/*.test.js`
Expected: 226 passing (221 prior + 5 new).

- [ ] **Step 1.6: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): matchBashAllowlist + cmdNorm helpers"
```

---

## Task 2: recordBashCall + lookupLatestBashCall

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 2.1: Append failing tests**

Append to `src/test/working_memory.test.js`:

```js
test('recordBashCall stores entry under <cwd>|<cmd_norm> key, caps to 5', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-bash-1';
    for (let i = 0; i < 7; i++) {
      wm.recordBashCall(sid, 'git status', '/proj', `out${i}`, { exit: 0, ref: `r${i}` });
    }
    const state = wm.loadSession(sid);
    const key = '/proj|git status';
    assert.equal(state.bash_calls[key].length, 5);
    assert.equal(state.bash_calls[key][4].ref, 'r6');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('recordBashCall normalizes whitespace in cmd key', () => {
  const home = tmpHome();
  try {
    wm.recordBashCall('sid-norm', '  git   status  ', '/proj', 'out', { exit: 0, ref: 'r1' });
    const state = wm.loadSession('sid-norm');
    assert.ok(state.bash_calls['/proj|git status']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('lookupLatestBashCall returns last entry or null', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-look';
    assert.equal(wm.lookupLatestBashCall(sid, 'git status', '/proj'), null);
    wm.recordBashCall(sid, 'git status', '/proj', 'old', { exit: 0, ref: 'r1' });
    wm.recordBashCall(sid, 'git status', '/proj', 'new', { exit: 0, ref: 'r2' });
    const last = wm.lookupLatestBashCall(sid, 'git status', '/proj');
    assert.equal(last.ref, 'r2');
    assert.equal(last.size, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 2.2: Run, verify FAIL**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.recordBashCall is not a function`.

- [ ] **Step 2.3: Add `recordBashCall` and `lookupLatestBashCall` to module**

Add to `src/working_memory.js`:

```js
const MAX_BASH_ENTRIES_PER_KEY = 5;

function bashKey(cwd, cmd) {
  return `${cwd}|${cmdNorm(cmd)}`;
}

function recordBashCall(sid, cmd, cwd, output, opts = {}) {
  const state = loadSession(sid);
  if (!state.bash_calls) state.bash_calls = {};
  const key = bashKey(cwd, cmd);
  const entry = {
    turn: state.next_turn,
    cmd_norm: cmdNorm(cmd),
    cwd: String(cwd || ''),
    ref: opts.ref || null,
    output_hash: hashContent(typeof output === 'string' ? output : ''),
    exit: typeof opts.exit === 'number' ? opts.exit : null,
    size: typeof output === 'string' ? output.length : 0,
    ts: new Date().toISOString(),
  };
  if (!state.bash_calls[key]) state.bash_calls[key] = [];
  state.bash_calls[key].push(entry);
  if (state.bash_calls[key].length > MAX_BASH_ENTRIES_PER_KEY) {
    state.bash_calls[key] = state.bash_calls[key].slice(-MAX_BASH_ENTRIES_PER_KEY);
  }
  state.next_turn++;
  saveSession(state);
  return entry;
}

function lookupLatestBashCall(sid, cmd, cwd) {
  const state = loadSession(sid);
  if (!state.bash_calls) return null;
  const arr = state.bash_calls[bashKey(cwd, cmd)];
  if (!arr || !arr.length) return null;
  return arr[arr.length - 1];
}
```

Update `module.exports` to include `recordBashCall`, `lookupLatestBashCall`, `bashKey`, `MAX_BASH_ENTRIES_PER_KEY`.

- [ ] **Step 2.4: Run, verify PASS**

Run: `node --test src/test/working_memory.test.js`
Expected: PASS (8 new tests added so far in this task batch).

- [ ] **Step 2.5: Full suite (229 passing)**

Run: `node --test src/test/*.test.js`

- [ ] **Step 2.6: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): recordBashCall + lookupLatestBashCall with cwd|cmd_norm key"
```

---

## Task 3: bashDedupDecision

**Files:**
- Modify: `src/working_memory.js`
- Test: `src/test/working_memory.test.js`

- [ ] **Step 3.1: Append failing tests**

```js
test('bashDedupDecision returns null when no prior call', () => {
  const home = tmpHome();
  try {
    const d = wm.bashDedupDecision('sid-bd1', 'git status', '/proj', { window_sec: 30 });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('bashDedupDecision returns dedup when within window', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-bd2';
    wm.recordBashCall(sid, 'git status', '/proj', 'output', { exit: 0, ref: 'r1' });
    const d = wm.bashDedupDecision(sid, 'git status', '/proj', { window_sec: 30, now: Date.now() });
    assert.equal(d.action, 'bash_dedup');
    assert.equal(d.priorTurn, 1);
    assert.equal(d.ref, 'r1');
    assert.equal(d.size, 6);
    assert.equal(d.exit, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('bashDedupDecision allows when window expired', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-bd3';
    wm.recordBashCall(sid, 'git status', '/proj', 'output', { exit: 0, ref: 'r1' });
    const future = Date.now() + 120 * 1000;
    const d = wm.bashDedupDecision(sid, 'git status', '/proj', { window_sec: 30, now: future });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('bashDedupDecision returns null when prior has no ref (cache write failed)', () => {
  const home = tmpHome();
  try {
    const sid = 'sid-bd4';
    wm.recordBashCall(sid, 'git status', '/proj', 'output', { exit: 0, ref: null });
    const d = wm.bashDedupDecision(sid, 'git status', '/proj', { window_sec: 30 });
    assert.equal(d, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 3.2: Run, verify FAIL**

Run: `node --test src/test/working_memory.test.js`
Expected: FAIL with `wm.bashDedupDecision is not a function`.

- [ ] **Step 3.3: Add `bashDedupDecision` to module**

```js
function bashDedupDecision(sid, cmd, cwd, opts = {}) {
  const prior = lookupLatestBashCall(sid, cmd, cwd);
  if (!prior) return null;
  if (!prior.ref) return null; // no cached output to point at

  const windowMs = (opts.window_sec ?? 60) * 1000;
  const priorMs = Date.parse(prior.ts);
  if (!Number.isFinite(priorMs)) return null;
  const elapsedMs = (opts.now ?? Date.now()) - priorMs;
  if (elapsedMs > windowMs) return null;

  return {
    action: 'bash_dedup',
    priorTurn: prior.turn,
    ref: prior.ref,
    size: prior.size,
    exit: prior.exit,
    elapsedSec: Math.round(elapsedMs / 1000),
    cmdNorm: prior.cmd_norm,
    recordedAt: prior.ts,
  };
}
```

Update `module.exports` to include `bashDedupDecision`.

- [ ] **Step 3.4: Run, verify PASS**

- [ ] **Step 3.5: Full suite (233 passing)**

- [ ] **Step 3.6: Commit**

```bash
git add src/working_memory.js src/test/working_memory.test.js
git commit -m "feat(working_memory): bashDedupDecision with wall-clock window gate"
```

---

## Task 4: Config defaults

**Files:**
- Modify: `config.default.json`

- [ ] **Step 4.1: Add `bash_dedup` subsection**

In `config.default.json`, find the existing `working_memory` block. Replace the closing `}` of `working_memory` with the bash_dedup section. The full new shape:

```json
  "working_memory": {
    "enabled": false,
    "min_dedup_size_bytes": 1024,
    "recency_window_minutes": 10,
    "ttl_hours": 24,
    "bash_dedup": {
      "enabled": false,
      "fs_read_window_sec": 60,
      "state_probe_window_sec": 30,
      "fs_read_patterns": [
        "^\\s*(grep|rg|egrep)\\s",
        "^\\s*find\\s",
        "^\\s*ls\\b",
        "^\\s*tree\\b",
        "^\\s*(cat|head|tail|wc|stat|file)\\s"
      ],
      "state_probe_patterns": [
        "^\\s*git\\s+(log|status|diff|show|blame|branch|tag|remote)\\b",
        "^\\s*(npm|pnpm|yarn)\\s+(ls|list)\\b",
        "^\\s*kubectl\\s+(get|describe|logs)\\b",
        "^\\s*docker\\s+(ps|images|logs)\\b"
      ]
    }
  },
```

- [ ] **Step 4.2: Verify JSON valid + suite still passes**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.default.json'))" && node --test src/test/*.test.js 2>&1 | tail -5`
Expected: no parse error, 233 tests pass.

- [ ] **Step 4.3: Commit**

```bash
git add config.default.json
git commit -m "feat(config): add working_memory.bash_dedup defaults (enabled=false)"
```

---

## Task 5: PostToolUse Bash recording

**Files:**
- Modify: `src/hooks.js`
- Test: `src/test/hooks.test.js`

- [ ] **Step 5.1: Append failing test**

Append to `src/test/hooks.test.js`:

```js
test('PostToolUse Bash records allowlist matches with cached ref', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-post-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: {
        enabled: true,
        fs_read_window_sec: 60,
        state_probe_window_sec: 30,
        fs_read_patterns: ['^\\s*grep\\s'],
        state_probe_patterns: ['^\\s*git\\s+status\\b'],
      },
    };

    const sid = 'sid-bash-post';
    await handlePostToolUse({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: { stdout: 'On branch main\nnothing to commit', stderr: '', interrupted: false },
    }, cfg);

    const wm = require('../working_memory.js');
    const last = wm.lookupLatestBashCall(sid, 'git status', process.cwd());
    assert.ok(last, 'recorded');
    assert.ok(last.ref, 'ref present');
    assert.equal(last.exit, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PostToolUse Bash skips non-allowlist commands', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-skip-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: {
        enabled: true,
        fs_read_window_sec: 60,
        state_probe_window_sec: 30,
        fs_read_patterns: ['^\\s*grep\\s'],
        state_probe_patterns: [],
      },
    };

    const sid = 'sid-bash-skip';
    await handlePostToolUse({
      session_id: sid,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'tests run', stderr: '', interrupted: false },
    }, cfg);

    const wm = require('../working_memory.js');
    const last = wm.lookupLatestBashCall(sid, 'npm test', process.cwd());
    assert.equal(last, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 5.2: Run, verify FAIL**

Run: `node --test src/test/hooks.test.js`
Expected: FAIL — `lookupLatestBashCall` returns null because nothing recorded yet.

- [ ] **Step 5.3: Add Bash recording branch to `handlePostToolUse`**

In `src/hooks.js`, find the existing `// --- working memory: record Read content (Phase 1) ---` block inside the PostToolUse try/catch. AFTER its closing comment line `// --- end working memory record ---`, add:

```js
    // --- working memory: record Bash output for dedup (Phase 2) ---
    try {
      const wmCfg = config?.working_memory;
      const bdCfg = wmCfg?.bash_dedup;
      if (wmCfg?.enabled && bdCfg?.enabled && toolName === 'Bash') {
        const cmd = ti.command || '';
        const cwd = String(input.cwd || process.cwd() || '');
        const sidBash = String(input.session_id || '-');
        const wm = require('./working_memory.js');
        if (sidBash !== '-' && cmd && wm.matchBashAllowlist(cmd, bdCfg)) {
          const tr3 = input.tool_response;
          const stdout = (tr3 && typeof tr3.stdout === 'string') ? tr3.stdout : '';
          const stderr = (tr3 && typeof tr3.stderr === 'string') ? tr3.stderr : '';
          const combined = stderr ? `${stdout}\n--- stderr ---\n${stderr}` : stdout;
          if (combined.length > 0) {
            const cache = require('./mcp_cache.js');
            const cached = cache.writeCache(combined, { gc: (config && config.cache && config.cache.gc) || {} });
            wm.recordBashCall(sidBash, cmd, cwd, combined, {
              exit: tr3?.interrupted ? 124 : 0,
              ref: cached.ref,
            });
          }
        }
      }
    } catch (err) {
      logHook(config, `working_memory bash post_tool error: ${err.message}`);
    }
    // --- end Bash dedup record ---
```

- [ ] **Step 5.4: Run, verify PASS**

Run: `node --test src/test/hooks.test.js`
Expected: PASS.

- [ ] **Step 5.5: Full suite (235 passing)**

- [ ] **Step 5.6: Commit**

```bash
git add src/hooks.js src/test/hooks.test.js
git commit -m "feat(hooks): PostToolUse Bash recording for working_memory dedup"
```

---

## Task 6: PreToolUse Bash dedup

**Files:**
- Modify: `src/hooks.js`
- Test: `src/test/hooks.test.js`

- [ ] **Step 6.1: Append failing tests**

```js
test('PreToolUse Bash: same command within window triggers dedup deny', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-pre-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: {
        enabled: true,
        fs_read_window_sec: 60,
        state_probe_window_sec: 30,
        fs_read_patterns: ['^\\s*grep\\s'],
        state_probe_patterns: ['^\\s*git\\s+status\\b'],
      },
    };

    const sid = 'sid-pre-1';
    const wm = require('../working_memory.js');
    // Pretend a prior call happened with a real cache ref
    const cache = require('../mcp_cache.js');
    const cached = cache.writeCache('On branch main', { gc: {} });
    wm.recordBashCall(sid, 'git status', process.cwd(), 'On branch main', { exit: 0, ref: cached.ref });

    const res = handlePreToolUse(
      { session_id: sid, tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: process.cwd() },
      cfg,
    );
    assert.equal(res.output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      res.output.hookSpecificOutput.permissionDecisionReason,
      /Same command ran.*ctx_cache_get.*ref/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Bash: non-allowlist command always passes through', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-pre2-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: {
        enabled: true,
        fs_read_window_sec: 60,
        state_probe_window_sec: 30,
        fs_read_patterns: ['^\\s*grep\\s'],
        state_probe_patterns: [],
      },
    };

    const res = handlePreToolUse(
      { session_id: 'sid-x', tool_name: 'Bash', tool_input: { command: 'npm test' } },
      cfg,
    );
    assert.equal(res.output, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Bash: bash_dedup disabled flag bypasses', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-pre3-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: { enabled: false }, // off
    };

    const wm = require('../working_memory.js');
    wm.recordBashCall('sid-off', 'git status', process.cwd(), 'out', { exit: 0, ref: 'r' });

    const res = handlePreToolUse(
      { session_id: 'sid-off', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: process.cwd() },
      cfg,
    );
    assert.equal(res.output, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Bash: cached ref expired → pass through', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-pre-expired-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: {
        enabled: true,
        fs_read_window_sec: 60,
        state_probe_window_sec: 30,
        fs_read_patterns: [],
        state_probe_patterns: ['^\\s*git\\s+status\\b'],
      },
    };

    const sid = 'sid-ref-gone';
    const wm = require('../working_memory.js');
    // Record with a ref that doesn't exist in mcp_cache
    wm.recordBashCall(sid, 'git status', process.cwd(), 'output', { exit: 0, ref: 'nonexistent-ref' });

    const res = handlePreToolUse(
      { session_id: sid, tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: process.cwd() },
      cfg,
    );
    assert.equal(res.output, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Bash: window expired → pass through', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-bash-pre4-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = {
      enabled: true,
      bash_dedup: {
        enabled: true,
        fs_read_window_sec: 60,
        state_probe_window_sec: 30,
        fs_read_patterns: [],
        state_probe_patterns: ['^\\s*git\\s+status\\b'],
      },
    };

    const sid = 'sid-stale';
    const wm = require('../working_memory.js');
    const state = wm.loadSession(sid);
    state.bash_calls = state.bash_calls || {};
    const key = `${process.cwd()}|git status`;
    state.bash_calls[key] = [{
      turn: 1,
      cmd_norm: 'git status',
      cwd: process.cwd(),
      ref: 'r1',
      output_hash: wm.hashContent('out'),
      exit: 0,
      size: 3,
      ts: new Date(Date.now() - 120 * 1000).toISOString(), // 2 min ago, > 30s window
    }];
    state.next_turn = 2;
    wm.saveSession(state);

    const res = handlePreToolUse(
      { session_id: sid, tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: process.cwd() },
      cfg,
    );
    assert.equal(res.output, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
```

- [ ] **Step 6.2: Run, verify FAIL**

Run: `node --test src/test/hooks.test.js`
Expected: FAIL — first test fails because PreToolUse has no Bash dedup branch.

- [ ] **Step 6.3: Add Bash dedup branch to `handlePreToolUse`**

In `src/hooks.js`, find the existing `// Working memory dedup branch (Phase 1)` block in `handlePreToolUse`. AFTER its `// --- end working memory branch ---` comment, BEFORE the `const pre = config?.hooks?.pre_tool_use;` line, add:

```js
  // Working memory Bash dedup branch (Phase 2)
  try {
    const wmCfg = config?.working_memory;
    const bdCfg = wmCfg?.bash_dedup;
    if (wmCfg?.enabled && bdCfg?.enabled && input.tool_name === 'Bash') {
      const sid = String(input.session_id || '-');
      const cmd = input.tool_input?.command || '';
      const cwd = String(input.cwd || process.cwd() || '');
      if (sid !== '-' && cmd) {
        const wm = require('./working_memory.js');
        const match = wm.matchBashAllowlist(cmd, bdCfg);
        if (match) {
          const decision = wm.bashDedupDecision(sid, cmd, cwd, { window_sec: match.window_sec });
          if (decision && decision.action === 'bash_dedup') {
            // Verify cached ref still resolves (mcp_cache may have GC'd it).
            const cache = require('./mcp_cache.js');
            const probe = cache.readCache(decision.ref, { offset: 0, limit: 1 });
            if (probe && probe.error === 'not-found') {
              // Ref expired — let the call go through and re-record.
              return { output: null, exitCode: 0 };
            }
            const reason =
              `[ctx working_memory] Same command ran ${decision.elapsedSec}s ago (turn ${decision.priorTurn}, exit ${decision.exit}, ${decision.size}B output). Output cached.\n` +
              `• Recall: ctx_cache_get({ref: "${decision.ref}", offset: 0, limit: 4000})\n` +
              `• Re-run anyway: outside the ${match.window_sec}s window dedup will pass through automatically.`;
            const sessLog = sid.replace(/\s+/g, '_');
            const cmdEsc = decision.cmdNorm.replace(/"/g, '\\"').slice(0, 200);
            logHook(config, `working_memory action=bash_dedup_hit session=${sessLog} cmd_norm="${cmdEsc}" prior_turn=${decision.priorTurn} bytes_saved=${decision.size} window_sec=${match.window_sec}`);
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
    logHook(config, `working_memory bash pre_tool error: ${err.message}`);
  }
  // --- end Bash dedup branch ---

```

- [ ] **Step 6.4: Run, verify PASS**

Run: `node --test src/test/hooks.test.js`
Expected: PASS.

- [ ] **Step 6.5: Full suite (239 passing)**

- [ ] **Step 6.6: Commit**

```bash
git add src/hooks.js src/test/hooks.test.js
git commit -m "feat(hooks): PreToolUse Bash dedup via working_memory module"
```

---

## Task 7: Metrics aggregation extension

**Files:**
- Modify: `src/metrics.js`
- Test: `src/test/metrics.test.js`

- [ ] **Step 7.1: Append failing test**

```js
test('aggregateMetrics surfaces working_memory bash_dedup counts', () => {
  const { parseLogString, aggregateMetrics } = require('../metrics.js');
  const lines = [
    '2026-04-29T10:00:00.000Z working_memory action=dedup_hit session=s1 path="/a.md" prior_turn=3 bytes_saved=2000',
    '2026-04-29T10:01:00.000Z working_memory action=bash_dedup_hit session=s1 cmd_norm="git status" prior_turn=4 bytes_saved=500 window_sec=30',
    '2026-04-29T10:02:00.000Z working_memory action=bash_dedup_hit session=s1 cmd_norm="grep foo src/" prior_turn=5 bytes_saved=1500 window_sec=60',
  ].join('\n');
  const { records } = parseLogString(lines);
  const agg = aggregateMetrics(records);
  assert.ok(agg.working_memory);
  assert.equal(agg.working_memory.dedup_hits, 1);
  assert.equal(agg.working_memory.bytes_saved, 2000);
  assert.equal(agg.working_memory.bash_dedup_hits, 2);
  assert.equal(agg.working_memory.bash_bytes_saved, 2000);
});
```

- [ ] **Step 7.2: Run, verify FAIL**

Run: `node --test src/test/metrics.test.js`
Expected: FAIL — `bash_dedup_hits` undefined or zero.

- [ ] **Step 7.3: Extend `aggregateMetrics` in `src/metrics.js`**

Find `function aggregateMetrics(records) {` and update the `wm` initialization plus the loop. Replace the existing function body with:

```js
function aggregateMetrics(records) {
  const corr = correlate(records);
  const wm = {
    dedup_hits: 0,
    bytes_saved: 0,
    recall_calls: 0,
    recall_rate: 0,
    bash_dedup_hits: 0,
    bash_bytes_saved: 0,
  };
  for (const r of records) {
    if (r.evType !== 'working_memory') continue;
    if (r.action === 'dedup_hit') {
      wm.dedup_hits++;
      const n = Number(r.bytes_saved);
      if (Number.isFinite(n)) wm.bytes_saved += n;
    } else if (r.action === 'recall_call') {
      wm.recall_calls++;
    } else if (r.action === 'bash_dedup_hit') {
      wm.bash_dedup_hits++;
      const n = Number(r.bytes_saved);
      if (Number.isFinite(n)) wm.bash_bytes_saved += n;
    }
  }
  wm.recall_rate = wm.dedup_hits ? wm.recall_calls / wm.dedup_hits : 0;
  return { ...(corr || {}), working_memory: wm };
}
```

- [ ] **Step 7.4: Run, verify PASS**

- [ ] **Step 7.5: Full suite**

- [ ] **Step 7.6: Commit**

```bash
git add src/metrics.js src/test/metrics.test.js
git commit -m "feat(metrics): aggregate working_memory bash_dedup_hits + bytes_saved"
```

---

## Task 8: Output rendering — bash dedup line

**Files:**
- Modify: `src/output.js`
- Test: `src/test/output.test.js`

- [ ] **Step 8.1: Append failing test**

Append to `src/test/output.test.js`:

```js
test('renderMetrics shows bash dedup line when bash_dedup_hits > 0', () => {
  const { printMetrics } = require('../output.js');
  const result = {
    pre_tool: { total: 0, deny: { total: 0 }, ask: { total: 0 } },
    cache:    { writes: 0, reads: 0, hits: 0, misses: 0 },
    working_memory: {
      dedup_hits: 0, bytes_saved: 0, recall_calls: 0, recall_rate: 0,
      bash_dedup_hits: 4, bash_bytes_saved: 8200,
    },
  };
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(String(s));
  try { printMetrics(result); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /bash dedup hits:\s+4/);
  assert.match(out, /8\.0 KB|8 KB/);
});
```

NOTE: If the function name is `renderMetrics` instead of `printMetrics`, use that. Read `src/output.js` to confirm — the Phase 1 implementer used `printMetrics`.

- [ ] **Step 8.2: Run, verify FAIL**

- [ ] **Step 8.3: Add bash dedup rendering to output**

In `src/output.js`, find the working memory rendering block (added in Phase 1, around the `if (r.working_memory && (r.working_memory.dedup_hits || r.working_memory.recall_calls)) {` line). Update the condition AND add a new line for bash dedup. Replace the entire block with:

```js
  if (r.working_memory && (r.working_memory.dedup_hits || r.working_memory.recall_calls || r.working_memory.bash_dedup_hits)) {
    const wm = r.working_memory;
    const kbSaved = (wm.bytes_saved / 1024).toFixed(1);
    const recallPct = (wm.recall_rate * 100).toFixed(0);
    const bashKbSaved = ((wm.bash_bytes_saved || 0) / 1024).toFixed(1);
    console.log('');
    console.log(C.dim + '  working memory (last 7d):' + C.reset);
    if (wm.dedup_hits) {
      console.log(`    file dedup hits:  ${C.green}${wm.dedup_hits}${C.reset} (saved ${kbSaved} KB)`);
    }
    if (wm.bash_dedup_hits) {
      console.log(`    bash dedup hits:  ${C.green}${wm.bash_dedup_hits}${C.reset} (saved ${bashKbSaved} KB)`);
    }
    if (wm.recall_calls || wm.dedup_hits) {
      console.log(`    recall calls:     ${wm.recall_calls}`);
      console.log(`    recall rate:      ${recallPct}% ${Number(recallPct) >= 50 ? '(high — consider disabling)' : '(healthy)'}`);
    }
  }
```

NOTE: This replaces the existing block. The new shape gracefully renders only the lines that have data — works whether Phase 1 or Phase 2 dedup hits exist alone or together.

- [ ] **Step 8.4: Run, verify PASS**

Run: `node --test src/test/output.test.js`

- [ ] **Step 8.5: Full suite**

- [ ] **Step 8.6: Commit**

```bash
git add src/output.js src/test/output.test.js
git commit -m "feat(output): render bash dedup hits line in working memory section"
```

---

## Task 9: CLAUDE.md invariant update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 9.1: Update the working_memory invariant bullet**

Find the existing bullet:

```markdown
- **Working memory is per-session and ephemeral.** Stored under `~/.config/ctx/working_memory/<sid>.{json,blobs/...}`. Hash-gated (changed files always re-Read) and wall-clock recency-gated (re-Read passes through after `recency_window_minutes`, default 10). Disable via `working_memory.enabled = false` (default).
```

Replace with:

```markdown
- **Working memory is per-session and ephemeral.** Stored under `~/.config/ctx/working_memory/<sid>.{json,blobs/...}`. Two dedup paths: (a) Read tool — hash-gated, wall-clock recency-gated (`recency_window_minutes`, default 10); (b) Bash tool — allowlist-gated for read-only and state-probe commands, time-windowed (`fs_read_window_sec` 60s, `state_probe_window_sec` 30s). Mutation commands always pass through. Both gated by `working_memory.enabled` and `working_memory.bash_dedup.enabled`, both default `false`.
```

- [ ] **Step 9.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): update working_memory invariant with Phase 2 bash dedup"
```

---

## Task 10: Final integration sweep + version bump

**Files:**
- Modify: `package.json`
- Modify: `.claude-plugin/plugin.json`

- [ ] **Step 10.1: Full test suite**

Run: `node --test src/test/*.test.js 2>&1 | tail -10`
Expected: all tests pass. Note final count (~241).

- [ ] **Step 10.2: Doctor check**

Run: `./bin/ctx doctor`
Expected: all checks green.

- [ ] **Step 10.3: Smoke test bash dedup flow**

```bash
node -e "
process.env.CTX_WORKING_MEMORY_DIR = require('os').tmpdir() + '/ctx-bash-smoke-' + Date.now();
const wm = require('./src/working_memory.js');
const cache = require('./src/mcp_cache.js');

const cmd = 'git status';
const cwd = '/proj';
const out = 'On branch main\\nnothing to commit';
const ref = cache.writeCache(out, { gc: {} }).ref;

wm.recordBashCall('smoke', cmd, cwd, out, { exit: 0, ref });

const cfg = {
  fs_read_patterns: ['^\\\\s*grep\\\\s'],
  state_probe_patterns: ['^\\\\s*git\\\\s+status\\\\b'],
  fs_read_window_sec: 60,
  state_probe_window_sec: 30,
};
const m = wm.matchBashAllowlist(cmd, cfg);
if (!m || m.bucket !== 'state_probe') { console.error('MATCH FAIL', m); process.exit(1); }

const decision = wm.bashDedupDecision('smoke', cmd, cwd, { window_sec: m.window_sec });
if (!decision || decision.action !== 'bash_dedup') { console.error('DEDUP FAIL', decision); process.exit(1); }

const cached = cache.readCache(decision.ref);
if (cached.error || !cached.content.includes('On branch main')) { console.error('RECALL FAIL', cached); process.exit(1); }

console.log('SMOKE PASS: bash dedup decision +', decision.size, 'B cached output recovered via ctx_cache_get');

require('fs').rmSync(process.env.CTX_WORKING_MEMORY_DIR, { recursive: true, force: true });
"
```

Expected: `SMOKE PASS: bash dedup decision + 30 B cached output recovered via ctx_cache_get`.

- [ ] **Step 10.4: Bump version**

Edit `package.json`: change `"version": "0.8.0-rc.1"` → `"0.8.0-rc.2"`.
Edit `.claude-plugin/plugin.json`: same change.

- [ ] **Step 10.5: Verify CLI**

Run: `./bin/ctx --version`
Expected: `claude-code-ctx 0.8.0-rc.2`.

- [ ] **Step 10.6: Final test sweep**

Run: `node --test src/test/*.test.js 2>&1 | tail -5`
Expected: same count, all green.

- [ ] **Step 10.7: Commit**

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "chore(0.8.0-rc.2): release candidate adds working_memory phase 2 bash dedup"
```

- [ ] **Step 10.8: Show final state**

```bash
git log --oneline -15
```

Should list all Phase 2 commits + the version bump on top.

---

## Self-review checklist

- [x] **Spec coverage:** all sections covered — module helpers (T1-T3), config (T4), hooks (T5-T6), metrics (T7-T8), invariant doc (T9), release (T10).
- [x] **No placeholders:** every step has concrete code or commands.
- [x] **Type consistency:** `recordBashCall(sid, cmd, cwd, output, opts)` signature matches all call sites; `bashDedupDecision` returns `{action, priorTurn, ref, size, exit, elapsedSec, cmdNorm, recordedAt}` consistently.
- [x] **Test count progression:** 221 → 226 → 229 → 233 → 235 → 239 → 240 → 241 (rough).
- [x] **Failing-test verification step** present in every task.

## Open notes for the implementer

- **Storage path env var.** `CTX_WORKING_MEMORY_DIR` overrides home-derived path (Phase 1 helper). Use it in tests to isolate state.
- **Hook degradation:** every Phase 2 branch wrapped in try/catch + logHook on error.
- **`process.cwd()` in tests.** Hook code uses `input.cwd || process.cwd()`. Tests must pass `cwd` in input (or accept that recorded entries use the test process's cwd — fine for unit tests, less fine for integration).
- **mcp_cache TTL:** 24h. If a session goes >24h with no activity then resumes, the ref expires. T6 handles this with a `cache.readCache(ref, {limit: 1})` probe before deciding to dedup; the "cached ref expired → pass through" test in T6.1 covers it.

## Phase 2 done condition

After Task 10, the branch should:
- Have ~10 new commits on top of Phase 1
- Pass ~241 tests
- Show `bash dedup hits` line in `ctx metrics` when events exist
- Be at version `0.8.0-rc.2`
- Ship with both flags off by default (opt-in for testing window)
