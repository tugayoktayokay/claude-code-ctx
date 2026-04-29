# ctx Working Memory — Phase 2: Bash Tool-Call Dedup

**Date:** 2026-04-29
**Status:** Design draft
**Phase:** 2 of 4 (working memory roadmap)
**Targets:** v0.8.0 (rolls into the same release as Phase 1)
**Depends on:** Phase 1 (already merged)

## Problem

After Phase 1 ships file-read dedup, the next biggest token waste is **repeated Bash invocations** of the same command. Real-world patterns observed:

- `git status` / `git log --oneline -10` run 3-5 times in a 10-minute exploration session.
- `grep "useAuth" src/` repeated as Claude bounces between files.
- `npm list --depth=0` re-run while debugging a dependency.

Each repeat dumps the full output (often 5-50 KB) into context. Over a long session this approaches Phase-1-level waste — and in many sessions **exceeds it**, because Bash output is typically larger than file content.

## Goals

- Detect duplicate Bash invocations within a short time window for **read-only / state-probe commands**.
- Replace the 2nd+ call with a deny+redirect pointing to a cached `ctx_cache_get({ref})`.
- Keep mutation-risky commands (`npm test`, `git pull`, deploys) **outside** the dedup path.
- Reuse Phase 1 storage (`working_memory/<sid>.json`) with a new `bash_calls` field.
- Reuse existing `mcp_cache.js` — no new content store.
- Measurable: surface `bash_dedup_hits` + `bytes_saved` in `ctx metrics`.
- Zero false-negatives for mutation commands (they always pass through).

## Non-goals (explicit)

- **Re-execution-and-hash** (Option B from brainstorm). Doubles execution cost — bad UX.
- **Mtime / dependency hashing** (Option C). Too complex for v1; revisit if metrics show false-positive rate too high.
- **Auto-learning the allowlist.** Static list, configurable via user config.
- **Output diff / partial dedup.** Either full output is cached or nothing.
- **Dedup across sessions.** Per-session only, like Phase 1.
- **Wrapping `ctx_shell` / `ctx_grep` MCP tools.** They already cache. This phase targets *raw Bash*.

## Architecture

### Data model (extend Phase 1 working_memory)

`~/.config/ctx/working_memory/<sid>.json` gets a new top-level field:

```json
{
  "session_id": "...",
  "next_turn": 12,
  "reads": { ... },
  "bash_calls": {
    "<key>": [
      {
        "turn": 5,
        "cmd_norm": "git status",
        "cwd": "/Users/foo/proj",
        "ref": "9af8...",
        "output_hash": "sha256:e3b0c44...",
        "exit": 0,
        "size": 1247,
        "ts": "2026-04-29T10:01:12Z"
      }
    ]
  }
}
```

Key format: `<cwd>|<cmd_norm>` (pipe-joined). `cmd_norm` strips leading whitespace, collapses internal multi-space to single, trims trailing whitespace. Comment-stripping is NOT done (e.g. `# foo` stays — keeps things deterministic).

Capped to the latest 5 entries per key (older entries dropped).

### Allowlist (initial, in `config.default.json`)

```json
"working_memory": {
  ...phase 1 fields...,
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
}
```

Each command's matched bucket determines its window. If a command matches **both** buckets (rare with these patterns), `fs_read` wins (more permissive window). If it matches **neither**, dedup is skipped — pass through.

### Hook flow

#### PostToolUse on Bash

1. If `bash_dedup.enabled = false` → no-op.
2. If `tool_name !== 'Bash'` → no-op.
3. Match command against `fs_read_patterns` ∪ `state_probe_patterns`. If neither matches → skip recording.
4. Extract `tr.stdout || ''` and `tr.stderr || ''`. Combine: full output that Claude saw.
5. If output is empty → skip recording (nothing to dedup).
6. Write the full output to `mcp_cache.js::writeCache`, get `ref`.
7. Compute `output_hash = sha256(combined).slice(0,16)` for completeness/debug.
8. Append entry to `bash_calls[<cwd>|<cmd_norm>]` (cap to latest 5).
9. Persist working memory file (atomic write).

#### PreToolUse on Bash

1. If `bash_dedup.enabled = false` → no-op.
2. If `tool_name !== 'Bash'` → no-op.
3. Match command. Determine window (`fs_read_window_sec` vs `state_probe_window_sec`). If no match → no-op.
4. Look up `bash_calls[<cwd>|<cmd_norm>]`. If empty → no-op.
5. Compute elapsed: `Date.now() - Date.parse(prior.ts)`. If > window → no-op (let it re-run).
6. Verify the cached ref still resolves: `mcp_cache.readCache(ref, {limit:1})` → if not-found → no-op.
7. Dedup decision: return `permissionDecision: "deny"` with reason:
   ```
   [ctx working_memory] Same command ran ${elapsedSec}s ago (turn ${prior.turn}, exit ${prior.exit}, ${prior.size}B output). Output cached.
   • Recall: ctx_cache_get({ref: "${prior.ref}", offset: 0, limit: 4000})
   • Re-run anyway: outside the ${windowSec}s window dedup will pass through automatically.
   ```
8. Log `working_memory action=bash_dedup_hit session=... cmd_norm="..." prior_turn=N bytes_saved=N window_sec=N`.

### Module structure

| Action | File | Changes |
|--------|------|---------|
| Modify | `src/working_memory.js` | Add `recordBashCall()`, `lookupLatestBashCall()`, `bashDedupDecision()` |
| Modify | `src/test/working_memory.test.js` | Unit tests for the three new functions |
| Modify | `src/hooks.js` | PreToolUse + PostToolUse Bash branches |
| Modify | `src/test/hooks.test.js` | Integration tests |
| Modify | `src/metrics.js` | (no change — `bash_dedup_hit` reuses existing parser; aggregation needs new tally) |
| Modify | `src/output.js` | Render `bash dedup hits` line in `ctx metrics` |
| Modify | `src/test/metrics.test.js` + `output.test.js` | Test new tally + render |
| Modify | `config.default.json` | Add `bash_dedup` subsection |
| Modify | `CLAUDE.md` | Update working memory invariant to mention bash_calls |

No new MCP tool. `ctx_cache_get` (already exists) is the recall path.

### Config defaults (full)

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
}
```

Both `working_memory.enabled` and `working_memory.bash_dedup.enabled` must be `true` for Phase 2 to fire — gated independently so a user can opt into Phase 1 alone.

### Failure modes (degrade silently per ctx hook invariant)

| Mode | Handling |
|------|----------|
| Cached ref expired (mcp_cache GC) | Pass through, record fresh on PostToolUse |
| Working memory write fails | Log to hooks.log, continue without dedup |
| Allowlist regex compile error | Skip that pattern, continue with others |
| `tool_response` shape unexpected | Skip recording |
| Concurrent same-command (race) | Last-write-wins; not a correctness issue (cache content matches one of the calls) |

### Metrics

New event types in `~/.config/ctx/hooks.log`:
- `working_memory action=bash_dedup_hit session=... cmd_norm="..." prior_turn=N bytes_saved=N window_sec=N`
- `working_memory action=bash_record session=... cmd_norm="..." size=N exit=N` (optional debug — gate behind verbose flag)

`ctx metrics` rendering:

```
working memory (last 7d):
  file dedup hits:  42 (saved 187 KB)
  bash dedup hits:  18 (saved 56 KB)
  recall calls:     8 (recall rate 19%)
```

A high `bash_dedup_hits` count with low `recall_calls` means dedup is firing usefully — Claude trusts the cache hint and reuses without recall. A spike in recall calls relative to dedup hits is a signal that Claude can't reliably read the cached output (rare).

## Behavioral invariants

These join the Phase 1 invariants in `CLAUDE.md`:

- **Bash dedup applies only to commands matching the configured allowlist.** Mutation commands (`npm test`, `git pull`, anything not in the allowlist) always pass through.
- **Bash dedup is time-bounded.** Beyond the window, dedup never fires regardless of how many times the same command was cached.
- **The cached output is the EXACT bytes Claude saw on the original call.** Combined `stdout + stderr` in the same shape `handlePostToolUse` already records for size_bytes.
- **`bash_dedup` is independently gated** from file-read dedup. Either can be on/off.

## Rollout

1. **2.1** (1 PR): module + unit tests for `recordBashCall`, `lookupLatestBashCall`, `bashDedupDecision`. Default off.
2. **2.2** (1 PR): hook integration. Both enable flags default off.
3. **2.3** (1 PR): metrics aggregation + render.
4. **Test window** (1-2 weeks): user manually enables `bash_dedup.enabled = true` in their config alongside Phase 1's flag. Observes metrics.
5. **2.4** (1 PR): if `bash_dedup_hits > 0` and recall rate stays under 30%, default flips to `true` in v0.8.0.

## Rollback plan

Single line: `working_memory.bash_dedup.enabled = false`. No data migration needed (state field becomes inert).

## Test plan

| Layer | Cases |
|-------|-------|
| `working_memory.js` unit | recordBashCall stores entry + writes to mcp_cache; lookupLatestBashCall returns last; bashDedupDecision honors fs_read_window_sec, state_probe_window_sec, allowlist mismatch, expired ref |
| Hook integration | First Bash matching allowlist passes; second within window → deny redirect; second outside window → pass; non-allowlist Bash always passes; disabled flag bypasses |
| Metrics | bash_dedup_hit events parsed; aggregateMetrics tallies; output renders bash line |
| Edge | empty stdout+stderr → no record; ref-expired → pass through; cmd_norm collapses whitespace correctly |

Floor: 12 new tests. Total suite stays green.

## Open questions

None blocking. Two for the user to confirm before plan:

- **Q1:** Default `fs_read_window_sec = 60` — too long? Too short? **Proposed: 60.**
- **Q2:** Default `state_probe_window_sec = 30` — same question. **Proposed: 30.**

## Out of scope (Phase 3+ teaser)

- **Phase 3:** Task focus tracker — detect scope drift, surface "you're 4 dirs away from the original task" hints.
- **Phase 4:** Edit-size watchdog — flag overengineering signals.
- Mtime-based dependency hashing for grep/find (would replace time window with content stability check). Revisit if false-positive metrics warrant.
- Wall-clock vs turn-count: we already chose wall-clock for Phase 1's recency, so Phase 2 inherits it.
