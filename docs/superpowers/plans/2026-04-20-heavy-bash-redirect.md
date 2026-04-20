# Heavy-Bash Redirect (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand and sharpen `pre_tool_use` rules so Claude gets redirected to `ctx_shell` / `ctx_read` / `ctx_grep` for heavy Bash commands, and log each deny/ask decision in a structured format that phase 2 can mine.

**Architecture:** No new code paths. The per-rule `mode` override is already honored by `src/hooks.js::handlePreToolUse` (see existing test `pre-tool-use ask mode vs deny mode per rule` at `src/test/hooks.test.js:288`). This plan adds `mode: "deny"` to 4 rules, adds 6 new rules, rewrites MCP tool descriptions, and changes one log line format.

**Tech Stack:** Node ≥18, built-ins only, no new deps.

**Spec:** `docs/superpowers/specs/2026-04-20-heavy-bash-redirect-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `config.default.json` | Modify | Replace `hooks.pre_tool_use.rules` array with 15-rule list (4 deny + 11 ask). |
| `src/mcp_tools.js` | Modify | Rewrite `description` strings on `ctx_shell`, `ctx_read`, `ctx_grep`. No handler changes. |
| `src/hooks.js` | Modify | Change the `logHook(...)` call inside `handlePreToolUse` to the structured format. |
| `src/test/hooks.test.js` | Modify | Add one test that exercises the structured log line format. Existing tests untouched. |
| `README.md` | Modify | Add one bullet mentioning the expanded rule set + redirect behavior. |
| `package.json` | Modify | Bump `version` to `0.6.0`. |

---

## Task 1: Expand pre_tool_use rules in `config.default.json`

**Files:**
- Modify: `config.default.json` (lines 80-94, the `pre_tool_use` block)

- [ ] **Step 1: Open `config.default.json` and replace the `pre_tool_use.rules` array**

Find this section (currently lines 80-94):

```json
    "pre_tool_use": {
      "enabled": true,
      "default_mode": "ask",
      "rules": [
        { "tool": "Bash", "match": "^\\s*find\\s+[/~]",                  "reason": "Unbounded filesystem traversal from root/home. Add -maxdepth and a -name pattern, or scope to a specific subdirectory." },
        { "tool": "Bash", "match": "^\\s*ls\\s+-R(\\s|$)",                "reason": "Recursive ls usually floods context. Scope to a specific dir, or pipe through head -50." },
        { "tool": "Bash", "match": "^\\s*tree(\\s+[/~]|\\s*$)",           "reason": "Unbounded tree dump. Add -L depth flag and/or scope to a subpath." },
        { "tool": "Bash", "match": "^\\s*grep\\s+-r(\\s+|$)",             "reason": "Recursive grep without scope. Use the Grep tool with head_limit, or narrow the path + pattern." },
        { "tool": "Bash", "match": "^\\s*cat\\s+/var/log/",               "reason": "Log files are almost always too large. Use tail -n 200 or grep a specific pattern." },
        { "tool": "Bash", "match": "^\\s*(journalctl|dmesg)(\\s|$)(?!.*-n)", "reason": "System logs need a -n limit. Try journalctl -n 200 or dmesg | tail -200." },
        { "tool": "Bash", "match": "^\\s*(npm|pnpm|yarn)\\s+ls(\\s|$)(?!.*--depth)", "reason": "Dependency tree needs --depth. Try --depth=0 or --depth=1." },
        { "tool": "Bash", "match": "^\\s*git\\s+log(\\s|$)(?!.*-n\\b)(?!.*--oneline)", "reason": "Full git log is huge. Add -n 20 or --oneline." },
        { "tool": "Bash", "match": "^\\s*history(\\s|$)(?!.*\\|)",        "reason": "history dumps everything. Pipe through tail -50 or grep." }
      ]
    },
```

Replace the entire `"pre_tool_use"` object with:

```json
    "pre_tool_use": {
      "enabled": true,
      "default_mode": "ask",
      "rules": [
        { "tool": "Bash", "match": "^\\s*find\\s+[/~]",                  "mode": "deny", "reason": "Unbounded filesystem traversal from root/home. Use ctx_shell({command: \"find ...\"}) — full output cached, returns ~500B summary + ref. Or scope: find ./src -maxdepth 3 -name '*.js'." },
        { "tool": "Bash", "match": "^\\s*grep\\s+-r(\\s|$)",              "mode": "deny", "reason": "Recursive grep floods context. Use ctx_grep({pattern, path}) — inline if small, summary+ref if big. Drop-in replacement." },
        { "tool": "Bash", "match": "^\\s*cat\\s+/var/log/",               "mode": "deny", "reason": "Log files are huge. Use ctx_read({path, limit_bytes: 5000}) for head/tail summary, or tail -n 200." },
        { "tool": "Bash", "match": "^\\s*du\\s+-a",                       "mode": "deny", "reason": "du -a lists every file. Use du -sh <path> for totals, or ctx_shell if you really need per-file." },

        { "tool": "Bash", "match": "^\\s*ls\\s+-R(\\s|$)",                "reason": "Recursive ls usually floods. Scope to a subdir, pipe through head -50, or use ctx_shell for summary." },
        { "tool": "Bash", "match": "^\\s*tree(\\s+[/~]|\\s*$)",           "reason": "Unbounded tree. Add -L <depth> or use ctx_shell." },
        { "tool": "Bash", "match": "^\\s*(journalctl|dmesg)(\\s|$)(?!.*-n)", "reason": "System logs need -n. Try journalctl -n 200 or ctx_shell." },
        { "tool": "Bash", "match": "^\\s*(npm|pnpm|yarn)\\s+ls(\\s|$)(?!.*--depth)", "reason": "Dep tree needs --depth. Try --depth=0." },
        { "tool": "Bash", "match": "^\\s*git\\s+log(\\s|$)(?!.*-n\\b)(?!.*--oneline)", "reason": "Full git log is huge. Add -n 20 or --oneline." },
        { "tool": "Bash", "match": "^\\s*history(\\s|$)(?!.*\\|)",        "reason": "history dumps everything. Pipe through tail -50 or grep." },
        { "tool": "Bash", "match": "^\\s*docker\\s+logs(\\s|$)(?!.*--tail)", "reason": "Container logs need --tail N. Use docker logs --tail 200 <container>." },
        { "tool": "Bash", "match": "^\\s*kubectl\\s+logs(\\s|$)(?!.*--tail)", "reason": "Pod logs need --tail N. Use kubectl logs --tail 200 <pod>." },
        { "tool": "Bash", "match": "^\\s*ps\\s+-ef(\\s|$)",               "reason": "Full process list is noisy. Use pgrep <name> or ps -ef | grep <pattern>." },
        { "tool": "Bash", "match": "^\\s*head\\s+-n\\s+\\d{4,}",          "reason": "head -n with 4+ digit count. Use ctx_read({path, limit_bytes: 5000})." },
        { "tool": "Bash", "match": "^\\s*tail\\s+-n\\s+\\d{4,}",          "reason": "tail -n with 4+ digit count. Use ctx_read or a smaller -n." }
      ]
    },
```

Note: The first 4 rules (`find`, `grep -r`, `cat /var/log/`, `du -a`) each have `"mode": "deny"`. The other 11 inherit `default_mode: "ask"`.

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.default.json'))"`
Expected: no output (success). If it errors, fix the syntax before proceeding.

- [ ] **Step 3: Verify each regex is a valid JS RegExp**

Run:
```bash
node -e "
const cfg = JSON.parse(require('fs').readFileSync('config.default.json'));
const rules = cfg.hooks.pre_tool_use.rules;
console.log('rule count:', rules.length);
for (const r of rules) {
  try { new RegExp(r.match); }
  catch (e) { console.error('BAD regex:', r.match, e.message); process.exit(1); }
}
console.log('all', rules.length, 'regexes valid');
console.log('deny count:', rules.filter(r => r.mode === 'deny').length);
console.log('ask inherit count:', rules.filter(r => !r.mode).length);
"
```
Expected:
```
rule count: 15
all 15 regexes valid
deny count: 4
ask inherit count: 11
```

- [ ] **Step 4: Run the full test suite**

Run: `node --test src/test/*.test.js`
Expected: all tests PASS (no test pins exact reason strings from defaults).

- [ ] **Step 5: Commit**

```bash
git add config.default.json
git commit -m "feat(hooks): expand pre_tool_use rules, deny 4 heaviest patterns

Add mode:\"deny\" to find, grep -r, cat /var/log/, du -a.
Add 6 new ask rules: docker logs, kubectl logs, ps -ef,
head -n NNNN, tail -n NNNN. Reason strings now name
ctx_shell/ctx_read/ctx_grep explicitly."
```

---

## Task 2: Rewrite MCP tool descriptions

**Files:**
- Modify: `src/mcp_tools.js` (descriptions on `ctx_shell`, `ctx_read`, `ctx_grep`)

- [ ] **Step 1: Update `ctx_shell` description**

Find the line (around line 159):

```javascript
    description: 'Run a shell command and return a summarized output if large. PREFER THIS OVER raw Bash for commands that may produce >5KB of output (ls -R, find, grep -r, logs, etc). Full output is cached; retrieve chunks via ctx_cache_get with the returned ref.',
```

Replace with:

```javascript
    description: 'Run a shell command. Returns inline if output <limit_bytes (default 5000), otherwise a ~500B summary plus a ref — full output cached, paginate via ctx_cache_get({ref,offset,limit}). **Use instead of raw Bash** for anything likely to produce >5KB: find, grep -r, ls -R, tree, journalctl, docker logs, du -a, large git log. Raw Bash dumps everything into context; this returns a summary.',
```

- [ ] **Step 2: Update `ctx_read` description**

Find the line (around line 257, the `ctx_read` tool object):

```javascript
    name: 'ctx_read',
```

and the `description:` field just below it. Replace its value with:

```javascript
    description: 'Read a file. Returns inline if <limit_bytes (default 5000), otherwise head+tail summary + cached ref. **Use instead of raw cat/Read** for files >5KB, especially logs, generated output, or large JSON. Paginate full content via ctx_cache_get.',
```

- [ ] **Step 3: Update `ctx_grep` description**

Find the `name: 'ctx_grep'` entry (around line 295) and replace its `description:` value with:

```javascript
    description: 'Run grep with a pattern + path. Returns matches inline if <limit_bytes (default 5000), otherwise summary + cached ref. **Use instead of raw `grep -r`** — same semantics, safe against huge codebases. Paginate via ctx_cache_get.',
```

- [ ] **Step 4: Run the full test suite**

Run: `node --test src/test/*.test.js`
Expected: all tests PASS (no test asserts on description text).

- [ ] **Step 5: Commit**

```bash
git add src/mcp_tools.js
git commit -m "feat(mcp): rewrite ctx_shell/ctx_read/ctx_grep descriptions

Make the 'use this instead of raw Bash' framing explicit,
call out the 5KB threshold, and list the specific command
families each wrapper replaces."
```

---

## Task 3: Structured deny/ask log format

**Files:**
- Modify: `src/hooks.js` (lines 168-205, `handlePreToolUse`)
- Modify: `src/test/hooks.test.js` (append one test)

- [ ] **Step 1: Append failing test to `src/test/hooks.test.js`**

Append at the end of the file:

```javascript
test('pre-tool-use writes structured single-line log entry', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-log-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const cfg = configWithDirs();
    cfg.hooks.pre_tool_use = {
      enabled: true,
      default_mode: 'ask',
      rules: [
        { tool: 'Bash', match: '^\\s*find\\s+[/~]', mode: 'deny', reason: 'use ctx_shell' },
      ],
    };
    const res = handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'find / -name testfile' } },
      cfg
    );
    assert.equal(res.output.hookSpecificOutput.permissionDecision, 'deny');

    const logPath = path.join(tmpHome, '.config', 'ctx', 'hooks.log');
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop();

    // Structured format: <ISO8601> pre_tool action=X tool=Y pattern="..." cmd_head="..." reason="..."
    assert.match(log, /^\S+Z pre_tool action=deny tool=Bash pattern=".+" cmd_head=".+" reason=".+"$/,
      `log line did not match format: ${log}`);
    assert.ok(log.includes('cmd_head="find / -name testfile"'), `cmd_head missing: ${log}`);
    assert.ok(log.includes('reason="use ctx_shell"'), `reason missing: ${log}`);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('pre-tool-use log escapes embedded double quotes and newlines in cmd_head', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-log-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const cfg = configWithDirs();
    cfg.hooks.pre_tool_use = {
      enabled: true,
      default_mode: 'ask',
      rules: [
        { tool: 'Bash', match: '^\\s*find\\s', mode: 'deny', reason: 'heavy' },
      ],
    };
    handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'find / -name "x"\nfoo' } },
      cfg
    );
    const logPath = path.join(tmpHome, '.config', 'ctx', 'hooks.log');
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop();
    // Inner double quote becomes \"
    assert.ok(log.includes('cmd_head="find / -name \\"x\\" foo"'),
      `expected escaped quotes + newline→space in cmd_head: ${log}`);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node --test src/test/hooks.test.js`
Expected: the new test fails because the current log format is `pre-tool-use ${action} tool=... rule="..." reason="..."` — missing `pre_tool ` event tag and `cmd_head`.

- [ ] **Step 3: Update `handlePreToolUse` log line**

Open `src/hooks.js`. Find the `handlePreToolUse` function (starts around line 168). Find this line inside it:

```javascript
    logHook(config, `pre-tool-use ${action} tool=${toolName} rule="${rule.match}" reason="${reason}"`);
```

Replace with:

```javascript
    const cmdHead = String(cmd).slice(0, 40).replace(/"/g, '\\"').replace(/\n/g, ' ');
    const patternEsc = String(rule.match).replace(/"/g, '\\"');
    const reasonEsc  = String(reason).replace(/"/g, '\\"').replace(/\n/g, ' ');
    logHook(config, `pre_tool action=${action} tool=${toolName} pattern="${patternEsc}" cmd_head="${cmdHead}" reason="${reasonEsc}"`);
```

Also check that `logHook` prepends an ISO8601 timestamp. Look at `logHook` (around line 26-34):

```javascript
function logHook(config, line) {
  try {
    const os = require('os');
    const logPath = path.join(os.homedir(), '.config', 'ctx', 'hooks.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}
```

It already prepends `new Date().toISOString()` + a space. Good — the test regex expects `\S+T\S+Z ` at the start. No change to `logHook` needed.

- [ ] **Step 4: Run the test again**

Run: `node --test src/test/hooks.test.js`
Expected: the new test PASSES. Existing tests still PASS.

- [ ] **Step 5: Run full suite to catch cross-file regressions**

Run: `node --test src/test/*.test.js`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks.js src/test/hooks.test.js
git commit -m "feat(hooks): structured pre_tool deny/ask log lines

Format: <ISO8601> pre_tool action=... tool=... pattern=... cmd_head=... reason=...
Enables phase-2 correlation with post-tool-use events to
measure whether Claude obeys redirect suggestions."
```

---

## Task 4: README + version bump + tag

**Files:**
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Bump version in `package.json`**

Change `"version": "0.5.0"` to `"version": "0.6.0"`.

- [ ] **Step 2: Add README bullet**

Open `README.md`. Find the "Hooks (event-driven)." section (around the "What it does" area). Find the existing PreToolUse bullet:

```markdown
- **PreToolUse** on Bash: catches `find /`, `ls -R`, unbounded `grep -r`, `cat /var/log/…` and similar, tells Claude to narrow scope before the command runs.
```

Replace with:

```markdown
- **PreToolUse** on Bash (15 rules): denies 4 unambiguously heavy patterns (`find /`, `grep -r`, `cat /var/log/`, `du -a`) with a reason pointing at the matching `ctx_shell` / `ctx_read` / `ctx_grep` wrapper; asks for 11 others (`ls -R`, `tree`, `journalctl`, `docker logs`, `kubectl logs`, `ps -ef`, `head/tail -n <big>`, `npm ls`, `git log`, `history`). All deny/ask events are logged as parseable single-line records in `~/.config/ctx/hooks.log`.
```

- [ ] **Step 3: Run full test suite**

Run: `node --test src/test/*.test.js`
Expected: all PASS.

- [ ] **Step 4: Smoke test**

Run:
```bash
echo '{"tool_name":"Bash","tool_input":{"command":"find / -name foo"}}' | ./bin/ctx hook pre-tool-use
```
Expected: JSON output with `"permissionDecision":"deny"` and a reason mentioning `ctx_shell`. Also check `~/.config/ctx/hooks.log` — most recent line should match the structured format.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json
git commit -m "chore(0.6.0): bump version, document expanded pre_tool_use rules"
```

- [ ] **Step 6: Tag**

```bash
git tag v0.6.0
```

(Do NOT push the tag unless the user asks.)

---

## Verification checklist

- [ ] `node --test src/test/*.test.js` — all green
- [ ] `find / -name foo` via hook → deny with ctx_shell reason
- [ ] `tree /tmp` via hook → ask mode
- [ ] `ls -la` via hook → no match, passes through
- [ ] `~/.config/ctx/hooks.log` has `pre_tool action=deny ... cmd_head="find / -name foo" ...` on latest line
- [ ] `package.json` version is `0.6.0`
- [ ] No new runtime deps
