# ctx Working Memory — Phase 1: File-hash Dedup

**Date:** 2026-04-29
**Status:** Design draft
**Phase:** 1 of 4 (working memory roadmap)
**Targets:** v0.8.0
**Author:** brainstorm with byneutron33@gmail.com

## Problem

Two concrete pains observed in real Claude Code sessions:

1. **`.md` re-read waste.** Files like `CLAUDE.md`, `README.md`, `package.json` are read 3-8 times per long session. Each read re-injects the full content into context. Pure token waste — content didn't change between reads.
2. **Mid-session compaction.** Wasted tokens push sessions over the quality ceiling sooner, triggering compaction. Compaction is a productivity killer: tool output details, error messages, decision rationale — all collapse to summaries. Avoiding compaction beats any single-feature optimization.

Both problems share one root cause: **Claude has no working memory of what it read this session.** A human dev doesn't re-read the same file every 10 minutes.

## Goals

- Detect duplicate `Read` calls within a session (same path, same content hash).
- Replace the 2nd+ read with a short reference, not the full content.
- Preserve attention freshness: refresh content if recency window expired.
- Zero false-negatives: never dedup a file that actually changed.
- Measurable ROI: surface dedup hits + bytes saved in `ctx metrics`.
- Reversible: single config flag flips it off.

## Non-goals (explicit, to keep Phase 1 small)

- Bash/grep tool-call dedup → Phase 2.
- Cross-session memory linkage → already passive via SessionStart hook.
- Code structure indexing / semantic search → Phase 3.
- Edit-size watchdog / overengineering hints → Phase 4.
- LLM-augmented features → permanently out (preserves no-LLM invariant).
- Replacing or wrapping the system-prompt MEMORY.md / CLAUDE.md preload (different mechanism, not in `Read` tool path).

## Architecture

### Data model

Per-session ephemeral state at `~/.config/ctx/working_memory/<session_id>.json`:

```json
{
  "session_id": "abc-123",
  "started_at": "2026-04-29T10:00:00Z",
  "reads": {
    "/abs/path/CLAUDE.md": [
      { "turn": 3,  "hash": "sha256:af23...", "size": 4567, "mtime": "2026-04-29T09:55:00Z", "ts": "2026-04-29T10:01:12Z" },
      { "turn": 12, "hash": "sha256:af23...", "size": 4567, "mtime": "2026-04-29T09:55:00Z", "ts": "2026-04-29T10:08:44Z" }
    ]
  }
}
```

Capped to the latest 5 entries per path (older entries dropped).

### Hook flow

#### PreToolUse on `Read`

1. If `working_memory.enabled = false` → no-op, return allow.
2. Look up `tool_input.file_path` in session reads.
3. No prior entry → allow (first read).
4. Prior entry exists:
   - **Fast check:** `stat()` the file. If `mtime` and `size` match the most recent prior entry → dedup candidate.
   - **Slow check** (only if fast check ambiguous, e.g. mtime drift): read file, compute hash, compare with prior. Match → dedup.
5. Recency gate: if last read was more than `recency_window_turns` ago → allow (attention refresh).
6. Size gate: if `size < min_dedup_size_bytes` → allow (saving too small to justify friction).
7. Dedup decision: return `permissionDecision: "deny"` with reason:
   ```
   [ctx working_memory] Already read at turn {N} ({size}B). Content unchanged.
   • Recall: ctx_recall_read({path: "..."}) returns cached content with no token cost beyond ~200B meta.
   • Trust your context: the prior read is still in your conversation history.
   ```

#### PostToolUse on `Read`

1. Extract file content from `tool_response`.
2. Compute `sha256` hash.
3. Append entry to `reads[path]` (cap to latest 5).
4. Write content to `mcp_cache.js` keyed by `<session>:<hash>` so `ctx_recall_read` can serve it without disk re-read.
5. Persist session memory file (atomic write).
6. Increment session-local turn counter (stored in same file as `next_turn: N`).

#### Stop hook (existing)

No change — but document that working memory file is left for 24h then GC'd by `ctx prune`.

### New MCP tool: `ctx_recall_read`

Input: `{ path: string }`
Behavior:
1. Look up most recent entry in working memory for current session.
2. If found: fetch content from `mcp_cache.js` (key `<session>:<hash>`); return content + meta `{turn, hash, size, recorded_at}`.
3. If working memory has entry but cache miss (rare — cache GC'd): re-read file from disk if hash still matches, else return error.
4. If no working memory record: return error `{ error: "no working memory record for this path" }`.

No new storage tier — `working_memory/<sid>.json` holds the path→hash map; `mcp_cache.js` holds the keyed content blobs.

### Module structure

| New | File | Responsibility |
|-----|------|----------------|
| ✓ | `src/working_memory.js` | Pure module: load/save session file, record/lookup/dedup decision |
| ✓ | `src/test/working_memory.test.js` | Unit tests |

| Modified | File | Changes |
|----------|------|---------|
| ✓ | `src/hooks.js` | PreToolUse + PostToolUse cases for `Read` |
| ✓ | `src/mcp_tools.js` | `ctx_recall_read` tool definition |
| ✓ | `src/metrics.js` | New event types: `working_memory.dedup_hit`, `.recall_call` |
| ✓ | `src/output.js` | Render dedup stats in `ctx metrics` |
| ✓ | `src/prune.js` | GC sweep for old `working_memory/<sid>.json` (>24h) |
| ✓ | `config.default.json` | New `working_memory` config section |
| ✓ | `src/test/hooks.test.js` | Integration: PreToolUse dedup behavior |
| ✓ | `src/test/metrics.test.js` | New event types render correctly |

### Config defaults

```json
"working_memory": {
  "enabled": false,
  "min_dedup_size_bytes": 1024,
  "recency_window_turns": 30,
  "max_entries_per_path": 5,
  "session_dir": "~/.config/ctx/working_memory",
  "ttl_hours": 24
}
```

`enabled: false` is intentional — opt-in for the first 1-2 weeks while metrics accumulate. Default flips to `true` only after a clean review (see Rollout).

### Failure modes (all degrade silently per ctx hook invariant)

| Mode | Handling |
|------|----------|
| `stat()` fails (permission, file gone) | Allow, do not record |
| Tool response not parseable | Allow, log to `hooks.log` |
| JSON state file corrupt | Reset that session's state, log warning |
| Hash mismatch race (file changed mid-flight) | Allow Read, refresh entry on PostToolUse |
| Disk write fails on persist | Log to `hooks.log`, continue without persist (in-memory only) |

### Metrics (new event types)

In `~/.config/ctx/hooks.log`:
- `working_memory dedup_hit session=... path=... turn=... bytes_saved=...`
- `working_memory recall_call session=... path=... hit=true|false`

`ctx metrics` renders (last 7 days):
```
working memory:
  dedup hits:           42 (saved 187 KB across 12 sessions)
  recall calls:         8  (after dedup)
  recall rate:          19% (low = healthy; high = dedup confusing Claude)
```

A high recall rate (>50%) is a regression signal — it means Claude is constantly fetching content again after dedup, defeating the purpose. If observed, the rollback is a config flag flip.

## Behavioral invariants

These join the existing list in `CLAUDE.md`:

- **Working memory is per-session and ephemeral.** No cross-session dedup. No persistence across `/clear`.
- **Hash-gated**: a file that changed gets a fresh read, always.
- **Recency-gated**: re-reads after the recency window pass through (attention refresh).
- **Hook degradation**: any error in the working memory path returns `allow` and logs.

## Rollout

1. **Faz 1.1** (1 PR): module + tests, no hook integration. Feature flag wired but unused.
2. **Faz 1.2** (1 PR): hook integration + `ctx_recall_read` MCP tool. Default off.
3. **Faz 1.3** (1 PR): metrics events + `ctx metrics` rendering.
4. **Test window** (1-2 weeks): user manually flips `enabled: true` in their config. Observes metrics. Reports regressions.
5. **Faz 1.4** (1 PR): if metrics show clean dedup hits + low recall rate, default flips to `true` in v0.8.0.

## Rollback plan

Single line: `working_memory.enabled = false` in `~/.config/ctx/config.json`. No data migration. State files left for 24h GC.

## Test plan

| Layer | Cases |
|-------|-------|
| `working_memory.js` unit | record(), lookup(), dedupDecision() — recency, size, hash mismatch, missing entry |
| Hook integration | First Read passes; second Read of unchanged file → deny redirect; second Read of changed file (different hash) → allow; size below threshold → allow; recency expired → allow |
| MCP tool | `ctx_recall_read` returns content for cached path; returns error for uncached |
| Metrics | dedup_hit event logged + rendered |
| GC | session memory file >24h removed by `ctx prune` |
| Failure | corrupt state file → reset cleanly; disk write fail → silent allow |

Floor: 15 new tests. Total suite stays green (currently 194 passing).

## Open questions

None blocking. Two for the user to decide before plan:

- **Q1:** Default `min_dedup_size_bytes`. Proposed 1024. Smaller (e.g. 256) catches more `package.json`-sized files; larger (e.g. 4096) skips small files entirely. → **Proposed: 1024**.
- **Q2:** Default `recency_window_turns`. Proposed 30. Smaller (10) refreshes more often (less savings); larger (50) trusts attention longer (more savings, more risk of attention decay). → **Proposed: 30**.

## Out of scope (Phase 2+ teaser, not part of this spec)

- Bash output dedup keyed by `(cmd, cwd, env_hash)`
- Tool-call result dedup for `Grep`, `Glob`, `ctx_grep`, `ctx_shell`
- Task focus tracker (scope drift detection)
- Edit-size watchdog (overengineering signal)
