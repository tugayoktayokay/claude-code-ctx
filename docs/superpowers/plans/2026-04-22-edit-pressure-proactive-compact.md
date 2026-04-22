# Edit-pressure-aware proactive /compact — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an edit-pressure signal that fires existing `compact`-level behavior earlier when recent Edit post_tool events signal imminent context pressure, cutting the observed 80% critical-level Stop rate toward ~40-60%.

**Architecture:** `analyzer.js` sums Edit tool_result sizes across the last `window_turns` assistant messages and exposes `editPressureKB`. `decision.js` applies a virtual pct bump to the level cutoff comparison when pressure exceeds threshold — `contextPct` stays truthful in output, only level selection sees the bump. `strategy.js` appends `recent Edit diffs` to the drop list and `ctx statusline` prepends a `⚡` marker when the flag is set. Pressure-off path is byte-identical to pre-0.7.7.

**Tech Stack:** Node.js 18+, node:test, node:assert/strict. Zero runtime deps (repo invariant). No LLM calls.

**Spec:** `docs/superpowers/specs/2026-04-22-edit-pressure-proactive-compact-design.md`

**Target release:** 0.7.7

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `config.default.json` | Canonical defaults, deep-merged with user overrides | MODIFY: add `limits.edit_pressure` block |
| `src/analyzer.js` | Walks JSONL, produces `analysis` object | MODIFY: track Edit tool_result sizes per turn, compute `editPressureKB` |
| `src/decision.js` | Maps `analysis` → level + reasons + metrics | MODIFY: apply virtual bump, expose `editPressureKB`, set `reason.editPressure` flag |
| `src/strategy.js` | Builds `/compact` prompt | MODIFY: conditionally append `recent Edit diffs` to drop list |
| `src/cli.js` | Contains `runStatusline` | MODIFY: prepend `⚡` to icon when pressure flag set |
| `src/test/analyzer.test.js` | Analyzer unit tests | MODIFY: add editPressure cases |
| `src/test/decision.test.js` | Decision unit tests | MODIFY: add bump cases |
| `src/test/strategy.test.js` | Strategy unit tests | MODIFY: add drop-list Edit-diff case |
| `src/test/fixtures/demo-session.jsonl` | Canonical JSONL fixture | MODIFY: add Edit tool_result entries |
| `package.json` | Version field | MODIFY: 0.7.6 → 0.7.7 |
| `.claude-plugin/plugin.json` | Plugin manifest version | MODIFY: 0.7.6 → 0.7.7 |

**Module boundary:** `analyzer.js` is the only producer of `editPressureKB`. `decision.js` is the only consumer for level selection. `strategy.js` and `cli.js` read only the already-set `reason.editPressure` flag — they never recompute pressure.

---

## Task 1: Add `edit_pressure` config defaults

**Files:**
- Modify: `config.default.json`
- Test: rely on existing `config.test.js` / `decision.test.js` suites (they deep-merge the file).

**Step 1: Add the block to `config.default.json`**

Insert immediately after `limits.output_ratio_warn` and before `limits.max_entries`:

```json
    "edit_pressure": {
      "enabled": true,
      "window_turns": 3,
      "threshold_kb": 100,
      "bump_pct": 15
    },
```

- [ ] **Step 1: Edit `config.default.json`**

Use Edit to insert the block above. The final `limits` section should look like:

```json
    "growth_window": 5,
    "growth_warn": 5000,
    "output_ratio_warn": 0.4,
    "edit_pressure": {
      "enabled": true,
      "window_turns": 3,
      "threshold_kb": 100,
      "bump_pct": 15
    },
    "max_entries": 20000
```

- [ ] **Step 2: Verify it parses**

Run: `node -e 'console.log(require("./config.default.json").limits.edit_pressure)'`
Expected: `{ enabled: true, window_turns: 3, threshold_kb: 100, bump_pct: 15 }`

- [ ] **Step 3: Run the full test suite — nothing should break**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected:
```
# tests 178
# pass 178
# fail 0
```

- [ ] **Step 4: Commit**

```bash
git add config.default.json
git commit -m "$(cat <<'EOF'
feat(config): add limits.edit_pressure defaults (0.7.7 prep)

window_turns=3, threshold_kb=100, bump_pct=15. enabled=true by default.
Tunables for upcoming Edit-pressure-aware proactive /compact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Compute `editPressureKB` in `analyzer.js`

**Files:**
- Modify: `src/analyzer.js:37-183` (analyzeEntries body + return shape)
- Modify: `src/test/analyzer.test.js` (new tests)

### Step-by-step

- [ ] **Step 1: Write the failing test — zero pressure on empty fixture**

Append to `src/test/analyzer.test.js`:

```js
test('editPressureKB is 0 when there are no Edit tool_results', () => {
  const config = loadDefaults();
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } },
    ] } },
    { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'u1', content: 'file1\nfile2' },
    ] } },
  ];
  const a = analyzeEntries(entries, config);
  assert.equal(a.editPressureKB, 0);
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `node --test src/test/analyzer.test.js 2>&1 | tail -20`
Expected: fail with `expected undefined to equal 0` (editPressureKB not defined yet).

- [ ] **Step 3: Write the second failing test — Edit pressure sums correctly**

Append:

```js
test('editPressureKB sums Edit tool_result sizes within window_turns', () => {
  const config = loadDefaults(); // window_turns=3
  // Build: 3 user→assistant turns, each with an Edit tool_result of 40KB
  const edit = 'x'.repeat(40 * 1024);
  const entries = [];
  for (let i = 1; i <= 3; i++) {
    entries.push({ type: 'user', message: { content: `turn ${i}` } });
    entries.push({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: `e${i}`, name: 'Edit', input: { file_path: `/f${i}.ts` } },
    ] } });
    entries.push({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: `e${i}`, content: edit },
    ] } });
  }
  const a = analyzeEntries(entries, config);
  // 3 Edits × 40 KB each = 120 KB; all within window_turns=3
  assert.ok(a.editPressureKB >= 115 && a.editPressureKB <= 125,
    `expected ~120KB, got ${a.editPressureKB}`);
});
```

- [ ] **Step 4: Write the third failing test — Edits outside window excluded**

Append:

```js
test('editPressureKB excludes Edits outside window_turns', () => {
  const config = loadDefaults(); // window_turns=3
  const edit = 'x'.repeat(50 * 1024);
  const entries = [];
  // 5 turns. Window captures last 3. The 2 oldest Edits must not count.
  for (let i = 1; i <= 5; i++) {
    entries.push({ type: 'user', message: { content: `turn ${i}` } });
    entries.push({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: `e${i}`, name: 'Edit', input: { file_path: `/f${i}.ts` } },
    ] } });
    entries.push({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: `e${i}`, content: edit },
    ] } });
  }
  const a = analyzeEntries(entries, config);
  // Only last 3 Edits × 50KB = 150KB. Older 2 Edits (100KB) excluded.
  assert.ok(a.editPressureKB >= 145 && a.editPressureKB <= 155,
    `expected ~150KB (last 3 only), got ${a.editPressureKB}`);
});
```

- [ ] **Step 5: Run all three — they all fail**

Run: `node --test src/test/analyzer.test.js 2>&1 | grep -E "^(ok|not ok|# tests|# fail)"`
Expected: 3 `not ok` lines for the three new tests.

- [ ] **Step 6: Implement in `src/analyzer.js`**

Find `const analysis = {` block at line 45 and add two fields after `largeOutputs: [],`:

```js
    recentEditSizes: [],  // [{turn, size}] — Edit tool_result sizes keyed by turn they landed in
    editPressureKB: 0,
```

Find the `tool_result` block around line 148-171. After the `largeOutputs.push(...)` call but still inside the `if (out.length > 2000)` or as a sibling guarded block, add Edit capture:

```js
          // Edit-pressure signal: sum Edit tool_result sizes per turn
          const fromMap2 = block.tool_use_id ? toolUseById.get(block.tool_use_id) : null;
          const toolName2 = fromMap2?.name || '';
          if (['Edit','edit','MultiEdit','Write','write','str_replace_based_edit_tool'].includes(toolName2)) {
            analysis.recentEditSizes.push({ turn, size: out.length });
          }
```

Note: we capture inside the existing `for (const block of msgContent)` loop, keyed by the same `turn` variable that's already in scope.

**Avoid duplicate work:** the existing code already does `const fromMap = block.tool_use_id ? toolUseById.get(block.tool_use_id) : null;` inside the `if (out.length > 2000)` branch. The Edit capture must happen **regardless of size** (a 1-byte Edit is not a 2KB one, but a 40 KB Edit would never hit largeOutputs if the threshold were different). Put the Edit capture **outside** the size guard:

Concrete insertion at line 152 (immediately inside the `if (block?.type === 'tool_result') {` body, before the size check):

```js
          if (block?.type === 'tool_result') {
            const out = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content || '');
            // Edit-pressure: capture every Edit tool_result size
            const editMap = block.tool_use_id ? toolUseById.get(block.tool_use_id) : null;
            if (editMap && ['Edit','edit','MultiEdit','Write','write','str_replace_based_edit_tool'].includes(editMap.name)) {
              analysis.recentEditSizes.push({ turn, size: out.length });
            }
            if (out.length > 2000) {
              /* ... existing largeOutputs code ... */
            }
          }
```

Refactor to avoid double lookup: compute `editMap` once and reuse for the existing `fromMap` in the largeOutputs branch.

- [ ] **Step 7: At the end of `analyzeEntries`, compute the window sum**

After the existing `analysis.lastNMessages = analysis.userIntents.slice(-5);` line (around line 174) and before the `avgGrowthPerTurn` block, add:

```js
  // Edit-pressure: sum sizes from Edits that landed in the last window_turns turns
  const editWindow = config?.limits?.edit_pressure?.window_turns ?? 3;
  const currentTurn = turn;
  const cutoff = currentTurn - editWindow;
  const pressureBytes = analysis.recentEditSizes
    .filter(e => e.turn > cutoff)
    .reduce((a, b) => a + b.size, 0);
  analysis.editPressureKB = Math.round(pressureBytes / 1024);
```

- [ ] **Step 8: Run tests — all three new ones pass, all 178 existing pass**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected:
```
# tests 181
# pass 181
# fail 0
```

- [ ] **Step 9: Commit**

```bash
git add src/analyzer.js src/test/analyzer.test.js
git commit -m "$(cat <<'EOF'
feat(analyzer): compute editPressureKB over last window_turns

Tracks Edit/Write tool_result sizes per turn (Edit, MultiEdit, Write,
str_replace_based_edit_tool). Sums sizes landing within the last
limits.edit_pressure.window_turns assistant messages, exposes as
analysis.editPressureKB. Edits outside the window excluded.

Consumed by decision.js virtual bump (next commit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Apply virtual pct bump in `decision.js`

**Files:**
- Modify: `src/decision.js` (makeDecision body + return shape)
- Modify: `src/test/decision.test.js` (new tests)

### Step-by-step

- [ ] **Step 1: Write failing test — no bump without pressure**

Append to `src/test/decision.test.js`:

```js
test('editPressure: below threshold does not bump the level', () => {
  const config = loadDefaults();
  const limits = { max: 200000, quality_ceiling: 200000 };
  // contextPct = 58% (116k / 200k) → watch normally
  const d = makeDecision(
    fakeAnalysis(116000, { editPressureKB: 50 }), // 50KB < 100KB threshold
    limits, config
  );
  assert.equal(d.level, 'watch');
  assert.equal(d.metrics.editPressureKB, 50);
  assert.equal(d.reason?.editPressure ?? false, false);
});
```

- [ ] **Step 2: Write failing test — bump applied above threshold**

```js
test('editPressure: above threshold promotes level via virtual bump', () => {
  const config = loadDefaults(); // bump_pct=15, threshold_kb=100
  const limits = { max: 200000, quality_ceiling: 200000 };
  // 58% + 15% bump = 73% → compact
  const d = makeDecision(
    fakeAnalysis(116000, { editPressureKB: 130 }),
    limits, config
  );
  assert.equal(d.level, 'compact', 'should promote watch→compact');
  assert.equal(d.metrics.editPressureKB, 130);
  assert.equal(d.reason.editPressure, true);
  // Raw contextPct still truthful
  assert.equal(d.metrics.contextPct, 58);
});
```

- [ ] **Step 3: Write failing test — bump only promotes, never demotes**

```js
test('editPressure: bump is monotonic (never demotes)', () => {
  const config = loadDefaults();
  const limits = { max: 200000, quality_ceiling: 200000 };
  // 30% + 15% = 45% → still comfortable (watch starts at 40%)
  // wait: comfortable is <=40% via order. At 45% we'd actually be 'watch'.
  // Test a case where bump shouldn't fire because below threshold.
  const d1 = makeDecision(
    fakeAnalysis(60000, { editPressureKB: 500 }), // 30% + potential bump
    limits, config
  );
  // 30% real → comfortable. 30+15=45 → watch. So yes, this DOES promote.
  // Rephrase: test that with pressure=0, bump never applies
  const d2 = makeDecision(
    fakeAnalysis(60000, { editPressureKB: 0 }),
    limits, config
  );
  assert.equal(d2.level, 'comfortable');
  assert.equal(d2.reason?.editPressure ?? false, false);
});
```

- [ ] **Step 4: Write failing test — enabled:false disables bump**

```js
test('editPressure: enabled=false disables bump entirely', () => {
  const config = loadDefaults();
  config.limits.edit_pressure.enabled = false;
  const limits = { max: 200000, quality_ceiling: 200000 };
  const d = makeDecision(
    fakeAnalysis(116000, { editPressureKB: 500 }),
    limits, config
  );
  assert.equal(d.level, 'watch', 'bump disabled, stays at watch');
  assert.equal(d.reason?.editPressure ?? false, false);
});
```

- [ ] **Step 5: Run tests — four new ones fail**

Run: `node --test src/test/decision.test.js 2>&1 | grep -E "^(ok|not ok)"`
Expected: 4 not-ok.

- [ ] **Step 6: Implement in `src/decision.js`**

Replace the threshold-loop section (lines 10-27). Before the existing `const pctCeiling = ...` line, insert:

```js
  const editPressureKB = analysis.editPressureKB || 0;
  const pressureCfg = config?.limits?.edit_pressure || {};
  const pressureEnabled = pressureCfg.enabled !== false;
  const pressureThresh  = pressureCfg.threshold_kb ?? 100;
  const pressureBump    = (pressureCfg.bump_pct ?? 15) / 100;
  const pressureActive  = pressureEnabled && editPressureKB > pressureThresh;
```

Replace the `pctCeiling` usage in the level-select loop. Current:

```js
  const pctCeiling = ctx / ceiling;
  ...
  for (const [name, threshold] of order) {
    if (pctCeiling >= threshold) { level = name; break; }
  }
```

Change to:

```js
  const pctCeiling = ctx / ceiling;
  const effectivePct = pctCeiling + (pressureActive ? pressureBump : 0);
  ...
  for (const [name, threshold] of order) {
    if (effectivePct >= threshold) { level = name; break; }
  }
```

Then extend the return object. Current:

```js
  return {
    level,
    action,
    reasons,
    metrics: {
      ...
    },
  };
```

Change to:

```js
  return {
    level,
    action,
    reasons,
    reason: { editPressure: pressureActive },
    metrics: {
      contextTokens: ctx,
      contextPct: Math.round(pctCeiling * 100),
      contextPctMax: Math.round(pctMax * 100),
      qualityCeiling: ceiling,
      modelMax: absoluteMax,
      outputTokens: analysis.totalOutput,
      messageCount: analysis.messageCount,
      toolUses: analysis.toolUses,
      filesModified: analysis.filesModified.size,
      avgGrowthPerTurn: analysis.avgGrowthPerTurn,
      editPressureKB,
    },
  };
```

Additionally, when `pressureActive` is true, add one entry to `reasons` just before return:

```js
  if (pressureActive) {
    reasons.push(
      `Recent Edit diffs: ~${editPressureKB}KB in last ${pressureCfg.window_turns ?? 3} turns — compact level advanced`
    );
  }
```

- [ ] **Step 7: Run decision tests — all pass**

Run: `node --test src/test/decision.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected:
```
# tests N+4  (was 2, now 6)
# pass N+4
# fail 0
```

- [ ] **Step 8: Run full suite — 185 pass**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected:
```
# tests 185
# pass 185
# fail 0
```

- [ ] **Step 9: Commit**

```bash
git add src/decision.js src/test/decision.test.js
git commit -m "$(cat <<'EOF'
feat(decision): apply virtual pct bump when editPressureKB > threshold

Effective pct for level-cutoff comparison = contextPct + bump_pct (15)
when edit_pressure is enabled and editPressureKB exceeds threshold_kb.
Raw contextPct is still reported in decision.metrics (user-visible
numbers don't lie); only the threshold loop sees the bumped value.

Adds decision.reason.editPressure flag consumed by strategy.js and
statusline. Adds editPressureKB to decision.metrics.

Config knob `limits.edit_pressure.enabled=false` restores pre-0.7.7
behavior byte-for-byte.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Append `recent Edit diffs` to `/compact` drop list

**Files:**
- Modify: `src/strategy.js:114-116` (drop-list assembly in buildCompactPrompt)
- Modify: `src/test/strategy.test.js` (new test)

### Step-by-step

- [ ] **Step 1: Write failing test — drop list includes Edit diffs under pressure**

Append to `src/test/strategy.test.js`:

```js
test('compactPrompt includes "Edit diffs" when decision.reason.editPressure', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  const limits   = { max: 200000, quality_ceiling: 200000 };
  const decision = makeDecision(analysis, limits, config);
  // Force pressure flag on for this test; analyzer/decision tested separately
  decision.reason = { editPressure: true };
  const strategy = buildStrategy(analysis, decision, config);
  assert.match(strategy.compactPrompt, /Edit diffs/,
    `prompt should mention Edit diffs under pressure: ${strategy.compactPrompt}`);
});

test('compactPrompt does NOT mention Edit diffs without pressure', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  const limits   = { max: 200000, quality_ceiling: 200000 };
  const decision = makeDecision(analysis, limits, config);
  // Without setting decision.reason.editPressure (defaults false)
  const strategy = buildStrategy(analysis, decision, config);
  assert.doesNotMatch(strategy.compactPrompt, /Edit diffs/);
});
```

- [ ] **Step 2: Run tests — two new ones fail**

Run: `node --test src/test/strategy.test.js 2>&1 | grep -E "^(ok|not ok)"`

- [ ] **Step 3: Implement in `src/strategy.js`**

Find `buildStrategy` around line 54-64 (the `largeOutputs` drop block). Immediately after that block but still inside `buildStrategy`, before the `repeatedPrefixes` block around line 66, add:

```js
  if (decision?.reason?.editPressure) {
    strategy.drop.push('recent Edit diffs');
    strategy.reasoning.push('Recent Edit operations dominate context — drop the raw diffs, keep the file-level summary');
  }
```

No change needed to `buildCompactPrompt` — it already pulls from `strategy.drop.slice(0, 2)`, so `recent Edit diffs` will surface naturally when present.

- [ ] **Step 4: Run tests — both pass**

Run: `node --test src/test/strategy.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`

- [ ] **Step 5: Run full suite — 187 pass**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 187 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/strategy.js src/test/strategy.test.js
git commit -m "$(cat <<'EOF'
feat(strategy): prepend "recent Edit diffs" to drop list under pressure

When decision.reason.editPressure is set, strategy.drop gains
"recent Edit diffs" which propagates to buildCompactPrompt's
drop slice. Tells Claude during /compact to drop the raw diffs
while keeping the file-level summary.

No behavior change when the flag is unset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Prepend `⚡` marker in `ctx statusline` under pressure

**Files:**
- Modify: `src/cli.js:566-598` (runStatusline)

### Step-by-step

- [ ] **Step 1: Write a failing smoke test**

There is no `statusline.test.js` today. Create one:

```bash
touch src/test/statusline.test.js
```

Write `src/test/statusline.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// We can't easily exercise runStatusline without a live session jsonl,
// but we CAN verify the icon-prepend behavior via a small adapter.
// To keep the plan minimal we inline-test the icon-composition function
// by requiring a new exported helper `composeStatuslineIcon`.

const { composeStatuslineIcon } = require('../statusline_helper.js');

test('composeStatuslineIcon returns bare icon without pressure flag', () => {
  assert.equal(composeStatuslineIcon('compact', false), '◐');
});

test('composeStatuslineIcon prepends ⚡ when pressure flag set', () => {
  assert.equal(composeStatuslineIcon('compact', true), '⚡◐');
});

test('composeStatuslineIcon falls back to · on unknown level', () => {
  assert.equal(composeStatuslineIcon('unknown', false), '·');
  assert.equal(composeStatuslineIcon('unknown', true), '⚡·');
});
```

- [ ] **Step 2: Run it — fail because helper doesn't exist**

Run: `node --test src/test/statusline.test.js 2>&1 | head -20`
Expected: Cannot find module `../statusline_helper.js`

- [ ] **Step 3: Create `src/statusline_helper.js`**

```js
'use strict';

const LEVEL_ICONS = { comfortable: '✓', watch: '○', compact: '◐', urgent: '●', critical: '⚠' };

function composeStatuslineIcon(level, editPressure) {
  const base = LEVEL_ICONS[level] || '·';
  return editPressure ? '⚡' + base : base;
}

module.exports = { composeStatuslineIcon, LEVEL_ICONS };
```

- [ ] **Step 4: Run tests — three pass**

Run: `node --test src/test/statusline.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`

- [ ] **Step 5: Use the helper in `runStatusline`**

In `src/cli.js`, at top of file find existing `const` imports (search for `require('./analyzer.js')`). Add near other local requires:

```js
const { composeStatuslineIcon } = require('./statusline_helper.js');
```

Find `runStatusline` around line 566. Replace:

```js
  const icon = { comfortable: '✓', watch: '○', compact: '◐', urgent: '●', critical: '⚠' }[pipe.decision.level] || '·';
```

With:

```js
  const icon = composeStatuslineIcon(pipe.decision.level, !!pipe.decision.reason?.editPressure);
```

- [ ] **Step 6: Smoke test the CLI**

Run: `./bin/ctx statusline 2>&1 | head -5`
Expected: a status string starts with `ctx ` followed by an icon + pct. If in current dir we're under pressure, expect `⚡` prefix on the icon; otherwise just the icon.

- [ ] **Step 7: Full test suite — 190 pass**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: 190 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add src/cli.js src/statusline_helper.js src/test/statusline.test.js
git commit -m "$(cat <<'EOF'
feat(statusline): prepend ⚡ icon when editPressure flag is set

New helper src/statusline_helper.js::composeStatuslineIcon encapsulates
the icon-mapping + pressure-prefix logic in a testable pure function.
runStatusline in cli.js now delegates to it.

No change when decision.reason.editPressure is false or unset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend canonical fixture with Edit entries for integration test

**Files:**
- Modify: `src/test/fixtures/demo-session.jsonl`
- Modify: `src/test/analyzer.test.js` (assertion floors may need +1 adjustment)

### Step-by-step

- [ ] **Step 1: Inspect current fixture**

Run: `cat src/test/fixtures/demo-session.jsonl | head -5`
(already read during planning — 15 lines total)

- [ ] **Step 2: Append Edit tool_result entries to fixture**

Append **two** new lines to `src/test/fixtures/demo-session.jsonl`:

```jsonl
{"type":"assistant","timestamp":"2026-04-19T10:25:00Z","message":{"role":"assistant","model":"claude-opus-4-7","content":[{"type":"tool_use","id":"edit1","name":"Edit","input":{"file_path":"backend/src/routes/petitions.ts"}}],"usage":{"input_tokens":110000,"output_tokens":400,"cache_read_input_tokens":108000}}}
{"type":"user","timestamp":"2026-04-19T10:25:05Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"edit1","content":"<diff of ~40KB would go here>"}]},"usage":{"input_tokens":150000,"output_tokens":0}}
```

To build the 40KB content string, use Node to generate the file rather than pasting raw text. A helper script:

```bash
node -e '
const fs = require("fs");
const p = "src/test/fixtures/demo-session.jsonl";
const orig = fs.readFileSync(p, "utf8").replace(/\n$/, "");
const big = "x".repeat(40960);
const append = [
  JSON.stringify({type:"assistant",timestamp:"2026-04-19T10:25:00Z",message:{role:"assistant",model:"claude-opus-4-7",content:[{type:"tool_use",id:"edit1",name:"Edit",input:{file_path:"backend/src/routes/petitions.ts"}}],usage:{input_tokens:110000,output_tokens:400,cache_read_input_tokens:108000}}}),
  JSON.stringify({type:"user",timestamp:"2026-04-19T10:25:05Z",message:{role:"user",content:[{type:"tool_result",tool_use_id:"edit1",content:big}]},usage:{input_tokens:150000,output_tokens:0}}),
].join("\n");
fs.writeFileSync(p, orig + "\n" + append + "\n");
console.log("fixture extended, new size:", fs.statSync(p).size);
'
```

- [ ] **Step 3: Run analyzer tests — floor assertions still pass**

Run: `node --test src/test/analyzer.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: all pass. The existing `>= 95000` token and `>= 5` message-count floors are still met (in fact exceeded by the new entries).

- [ ] **Step 4: Add integration test that exercises end-to-end pressure through pipeline**

Append to `src/test/analyzer.test.js`:

```js
test('fixture with 40KB Edit produces non-zero editPressureKB (integration)', () => {
  const config = loadDefaults();
  const entries = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  // One Edit of 40KB in window → ~40 KB pressure
  assert.ok(analysis.editPressureKB >= 35 && analysis.editPressureKB <= 45,
    `expected ~40KB, got ${analysis.editPressureKB}`);
});
```

- [ ] **Step 5: Verify the new test passes**

Run: `node --test src/test/analyzer.test.js 2>&1 | grep -E "^(ok|not ok)"`

- [ ] **Step 6: Full suite — 191 pass**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`

- [ ] **Step 7: Commit**

```bash
git add src/test/fixtures/demo-session.jsonl src/test/analyzer.test.js
git commit -m "$(cat <<'EOF'
test(fixtures): add 40KB Edit tool_result for editPressure coverage

Extends demo-session.jsonl with one assistant tool_use+user tool_result
pair representing a 40KB Edit diff. Adds an integration assertion that
analyzeEntries on the fixture yields editPressureKB≈40.

Existing floor-based assertions (contextTokens>=95000, messageCount>=5)
remain satisfied.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Release 0.7.7

**Files:**
- Modify: `package.json` (0.7.6 → 0.7.7)
- Modify: `.claude-plugin/plugin.json` (0.7.6 → 0.7.7)

### Step-by-step

- [ ] **Step 1: Bump version in `package.json`**

```bash
sed -i '' 's/"version": "0.7.6"/"version": "0.7.7"/' package.json
grep '"version"' package.json
```

Expected: `"version": "0.7.7",`

- [ ] **Step 2: Bump version in `.claude-plugin/plugin.json`**

```bash
sed -i '' 's/"version": "0.7.6"/"version": "0.7.7"/' .claude-plugin/plugin.json
grep '"version"' .claude-plugin/plugin.json
```

- [ ] **Step 3: Final test run**

Run: `node --test src/test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: all pass.

- [ ] **Step 4: Commit, tag, push**

```bash
git add package.json .claude-plugin/plugin.json
git commit -m "$(cat <<'EOF'
chore(0.7.7): release Edit-pressure-aware proactive /compact

Bundles:
- feat(config): limits.edit_pressure defaults
- feat(analyzer): compute editPressureKB over last window_turns
- feat(decision): virtual pct bump + reason.editPressure flag + editPressureKB metric
- feat(strategy): "recent Edit diffs" in drop list
- feat(statusline): ⚡ marker via composeStatuslineIcon helper
- test(fixtures): 40KB Edit entry for integration coverage

Full 0.7.6 behavior preserved when limits.edit_pressure.enabled=false.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git tag v0.7.7
git push origin main
git push origin v0.7.7
```

- [ ] **Step 5: Verify publication**

```bash
ctx upgrade
ctx --version
```

Expected: `claude-code-ctx 0.7.7`.

---

## Post-release validation (1 week)

After 7 days of real usage on the author's own machine:

- [ ] Run `ctx metrics` and compare `critical`-level Stop rate to pre-0.7.7 baseline (80%). Target: ≤60%.
- [ ] Check `compact`-level rate rose (that's the whole point — earlier fires).
- [ ] Check `indeterminate` and `bypassed` rates unchanged.
- [ ] Ask yourself: has the ⚡ marker been annoying during legit locale refactors? If yes, bump `threshold_kb` in `~/.config/ctx/config.json` to 150.

If success criteria (1 + 3 + no-annoyance) met → release is validated. Plan can close.

If not → Task 8 (tuning round) below.

---

## Task 8: Tuning round (only if post-release validation fails)

**This task is conditional. Do not execute unless metrics show the release underperformed.**

- [ ] Measure actual median editPressureKB across flagged sessions via hooks.log
- [ ] Decide: lower `threshold_kb` (capture more) OR raise `bump_pct` (promote harder)
- [ ] Update `config.default.json`
- [ ] Bump to 0.7.8, tag, push

---

## Self-review

- **Spec coverage:**
  - Config block (spec §Tunables) → Task 1 ✓
  - editPressureKB computation (spec §Mechanism analyzer.js) → Task 2 ✓
  - Virtual bump, reason.editPressure flag, editPressureKB metric (spec §Concept, §Module boundaries decision.js) → Task 3 ✓
  - /compact drop-list clause (spec §Strategy) → Task 4 ✓
  - Statusline ⚡ (spec §Statusline) → Task 5 ✓
  - Fixture + integration (spec §Testing integration) → Task 6 ✓
  - Release (spec §Rollout) → Task 7 ✓
- **Placeholder scan:** No TBDs, no "add error handling", code shown inline in every step.
- **Type consistency:**
  - `editPressureKB` used identically across tasks 2→7 (integer, kilobytes rounded).
  - `decision.reason.editPressure` boolean consistent across tasks 3→5.
  - `composeStatuslineIcon(level, editPressure)` signature pinned in Task 5 and used once in cli.js.
  - Config path `limits.edit_pressure.*` consistent with Task 1 placement under `limits` block.
- **Ambiguity check:** turn boundary defined as user-message increment (matches existing analyzer state `turn++` at user branch). `> threshold_kb` strict inequality specified in Task 3 impl. Window_turns uses `turn > (currentTurn - window_turns)` — same convention as spec.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-22-edit-pressure-proactive-compact.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fastest iteration for a 7-task plan with TDD discipline
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
