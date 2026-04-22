# Edit-pressure-aware proactive /compact — design

**Date:** 2026-04-22
**Status:** spec, pre-implementation
**Target release:** 0.7.7 (follows 0.7.6 which bundles the in-flight cmd_head / indeterminate / upgrade-UX patches)

## Problem

Real-user telemetry (2.2 days of one heavy user, 55 sessions, 8 projects) shows a structural gap in the current Stop-hook decision pipeline:

- **%80 of Stop events fire at `critical` level** — the user is almost always past the 200k quality ceiling by the time ctx alerts.
- **Edit tool accounts for ~%40 of context weight** (3.1 MB across 132 calls, avg 23 KB, max 160 KB for locale files) and **cannot be wrapped or redirected** — it is a writer, not a reader. ctx has no mechanism to react to it.
- Existing PreToolUse rules only match `Bash`; Edit bypasses the entire guardrail layer.
- Existing Stop-level thresholds react to **token%** only; they are blind to the nature of what pushed the counter up. A session that slowly accumulates reasoning traffic is treated identically to one that just dumped a 150 KB locale diff.

Result: by the time `compact`/`urgent`/`critical` fires, Claude has already absorbed the heavy diff into context. The alert is post-mortem.

## Goal

Cut the `critical`-level Stop rate from %80 toward ~%40 without regressing the comfortable-path UX. Fire the existing `compact` behavior **earlier when recent Edit activity signals imminent ceiling pressure**, so the user pastes `/compact` while there is still room to summarize productively.

Non-goal: blocking, prompting on, or modifying Edit operations themselves. Edit is always allowed through unchanged.

## Design

### Concept: Edit pressure as a virtual pct bump

`decision.js` currently maps `contextPct` (token usage against `quality_ceiling`) to a level:

```
contextPct    level
------        -----
<=40          comfortable
<=55          watch
<=70          compact
<=85          urgent
>85           critical
```

The spec adds a second signal — **recent Edit pressure** — computed by `analyzer.js`:

```
editPressureKB = Σ size_bytes of Edit post_tool events that fall
                 within the last `window_turns` assistant messages / 1024
```

Turn boundary = assistant message in the JSONL (same boundary `analyzer.js` already uses for its token-usage walk). Default `window_turns = 3`. When `editPressureKB > threshold_kb` (strict inequality, default 100), `decision.js` treats the effective pct as `contextPct + bump_pct` (default +15) **purely for level selection**. The raw `contextPct` is still reported verbatim in decision output and statusline numerics — only the level-cutoff comparison sees the bumped value.

Example:

| contextPct | editPressureKB | level without bump | level with bump |
|------------|----------------|--------------------|------------------|
| 40         | 0              | comfortable        | comfortable      |
| 58         | 0              | watch              | watch            |
| 58         | 130            | watch              | **compact** (58+15=73) |
| 72         | 130            | compact            | **urgent** (72+15=87) |

The bump is monotonic: it only ever promotes a level, never demotes.

### Tunables (config)

```json
"edit_pressure": {
  "window_turns": 3,
  "threshold_kb": 100,
  "bump_pct": 15,
  "enabled": true
}
```

Lives under the existing `decision` section of `config.default.json`. Each field user-overridable via `~/.config/ctx/config.json`. `enabled: false` disables the entire mechanism → behavior identical to pre-0.7.6.

### Strategy / prompt content

When `compact` or higher fires due to Edit pressure (flag `decision.reason.editPressure = true`), `strategy.js::compactPrompt` adds one clause to the existing `keep/drop` template:

```
/compact focus on <cats> — keep: <...> — drop: <...>, recent Edit diffs — continue: "<intent>"
```

The new clause `recent Edit diffs` signals Claude that the heaviest context is in the last couple of Edit operations. No other shape change to the prompt — existing `strategy.test.js` pins remain honored (the tests assert presence of `keep:` / `drop:` / `continue:` segments, not exhaustive content).

### Statusline

`src/statusline` output already shows a level icon (`✓ ○ ◐ ● ⚠`). When `editPressure` flag is set, prepend `⚡` to the icon (e.g. `⚡◐ 58%`). One character, no layout reflow. No new config.

### What the user sees

- **Light usage (no Edits):** nothing changes. Pre-0.7.6 behavior.
- **Normal Edit work:** occasional ⚡ marker, usually self-clears after 3 turns. Thresholds unchanged.
- **Heavy Edit session (locale file refactor, big rewrite):**
  - ⚡ appears in statusline within one turn of the Edit landing
  - `compact`-level clipboard prompt fires earlier (possibly around %55 instead of %70)
  - Prompt keep/drop guidance mentions `recent Edit diffs`
  - User pastes `/compact`; Claude drops Edit diffs preferentially

## Mechanism — module boundaries

```
session.jsonl
    │
    ▼
analyzer.js ── computes: contextTokens, contextPct, editPressureKB (new)
    │           reads: last window_turns post_tool events, sums Edit size_bytes
    ▼
decision.js ── maps: {contextPct, editPressureKB} → level
    │          logic: effectivePct = contextPct + (editPressureKB > threshold ? bump_pct : 0)
    │          output: { level, reason: { editPressure: bool, ... }, metrics }
    ▼
strategy.js ── builds: /compact prompt with conditional "recent Edit diffs" clause
    │
    ▼
hooks.js (Stop) ── existing: clipboard copy + snapshot + alert
                    unchanged downstream; consumes decision.level as before
```

**Key property:** `analyzer.js` is the only module that computes `editPressureKB`. `decision.js` is the only module that consumes it for level selection. Isolated, testable.

## Files touched

| File | Change | ~LoC |
|------|--------|-----:|
| `src/analyzer.js` | Add Edit sum over last N post_tool entries; expose in return shape | +30 |
| `src/decision.js` | Read `editPressureKB`, apply virtual bump, set `reason.editPressure` flag | +25 |
| `src/strategy.js` | Append `recent Edit diffs` to drop list when `reason.editPressure` | +15 |
| `src/statusline.js` | Prepend `⚡` when pressure flag set | +5 |
| `config.default.json` | Add `decision.edit_pressure` block | +6 |
| `src/test/analyzer.test.js` | New suite: editPressureKB computation from fixture | +25 |
| `src/test/decision.test.js` | New cases: same pct, different pressure → different level | +35 |
| `src/test/strategy.test.js` | New case: pressure flag → drop-list contains `Edit diffs` | +15 |
| `src/test/fixtures/demo-session.jsonl` | Add 2–3 Edit post_tool entries with size_bytes for test realism | +3 |

Total ~160 LoC across production + tests. Fits one commit.

## Testing strategy

### Unit

- `analyzer.test.js`
  - fixture with no Edit events → `editPressureKB = 0`
  - fixture with 1 Edit of 80KB in last N → `80`
  - fixture with 3 Edits summing 150KB across N=3 window → `150`
  - fixture where Edit is outside window (turn N+2) → excluded

- `decision.test.js`
  - `contextPct=58, editPressureKB=50, threshold=100` → `watch` (no bump applied)
  - `contextPct=58, editPressureKB=130, threshold=100, bump=15` → `compact` (58+15=73 > 55 cutoff)
  - `contextPct=85, editPressureKB=130` → `urgent` → `critical` (85+15=100)
  - `contextPct=30, editPressureKB=500` → `comfortable` stays (bump only promotes across cutoffs, doesn't invent one)
  - `enabled: false` in config → bump never applied, pre-0.7.6 behavior

- `strategy.test.js`
  - `decision.reason.editPressure = true` → prompt contains substring `recent Edit diffs`
  - `decision.reason.editPressure = false` → prompt does NOT contain that substring
  - Prompt shape (keep:/drop:/continue:) unchanged either way — existing pinned test passes

### Regression

All existing tests under `src/test/` must pass unchanged. Pressure-off path must be byte-identical to pre-0.7.6 output.

### Integration (light)

Extend `src/test/fixtures/demo-session.jsonl` with a handful of Edit entries; add one end-to-end test that runs `pipeline.runAnalyze(fixture)` and asserts the decision shape includes `reason.editPressure` when appropriate.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Bump promotes too aggressively, users spam /compact | Defaults conservative (100 KB / 3 turns / 15 pct); 7-day `ctx metrics` review post-release; tunable via config |
| Legitimate locale refactors trigger every turn | `window_turns=3` decays fast; ⚡ clears after 3 non-Edit turns; intentional — large refactor sessions SHOULD compact sooner |
| Edit size_bytes shape changes in Claude Code payload | Field is already consumed by post_tool hook metric in v0.7; same exposure surface. If Claude Code changes shape, both systems break together, not just this |
| Config field conflicts with future features | Namespaced under `decision.edit_pressure.*` — isolated from other future keys |

## Rollout

- **0.7.7 patch release.** Depends on 0.7.6 landing first (cmd_head expansion + indeterminate bucket + upgrade UX). `chore(0.7.7)` commit after the Edit-pressure fix commit, tag `v0.7.7`, push.
- Default `edit_pressure.enabled: true`. No opt-in friction.
- One week after release, review the reporter's own `ctx metrics`:
  - Compare `critical` rate (expect drop from %80 toward ~%50 in first pass)
  - Compare `compact` rate (expect rise — that's the whole point, earlier fires)
  - Check `indeterminate` and bypass rates — should be untouched
- If `critical` stays >%60 after a week, threshold tuning round: drop `bump_pct` from 15 → 20, or `threshold_kb` from 100 → 80. Config-only, no code change.

## Out of scope (deferred)

| Item | Lives in |
|------|----------|
| Edit deny/ask PreToolUse rule | Sub-project 1C (future) |
| Locale/JSON file whitelist | Sub-project 1C |
| Retroactive Edit trim | Impossible (context immutable) |
| Adaptive correlation window for metrics | Sub-project 2-bonus (future micro-spec) |
| Per-project metrics breakdown | Sub-project 2 |
| Snapshot pruning / log rotation | Sub-project 3 |

## Success criteria

Release is considered successful if **one week post-deployment**:

1. Reporter's `ctx metrics` shows `critical`-level Stop rate ≤ %60 (was %80)
2. No regression in `bypassed` or `indeterminate` rates
3. No user-reported annoyance (false-positive alerts on light sessions)
4. All existing tests continue to pass; no pressure-off behavior change

If any of 1–3 fails, roll back to 0.7.5 via `config.default.json` override `edit_pressure.enabled: false` in a 0.7.7 patch — no code revert needed.
