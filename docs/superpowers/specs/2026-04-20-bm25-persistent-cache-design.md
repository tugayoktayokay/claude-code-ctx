# Persistent BM25 index cache

**Date:** 2026-04-20
**Target version:** 0.5.0
**Module touched:** `src/retrieval.js` (additive), `src/test/retrieval.test.js` (additive), `src/doctor.js` (one new check), `README.md`, `package.json`

## Context

Originally planned as SQLite FTS5 but Node's bundled SQLite is compiled without FTS5 and `node:sqlite` is behind `--experimental-sqlite` as of Node 22.9. See branch history for details. This spec pivots to a zero-dep pure-JS solution.

## Problem

Every `rank()` call in `src/retrieval.js` re-reads all snapshot bodies from disk, re-tokenizes them, and rebuilds the BM25 corpus from scratch. For N=100–2000 snapshots this is wasted work since the set changes by at most one entry between queries.

## Decision

Cache the tokenized representation of each snapshot to disk. On each `rank()` call, diff disk vs cache by `(path, mtime)` and only retokenize the changed rows.

No changes to the BM25 scoring algorithm, tokenizer, fuzzy matching, query syntax, or categorization. Everything keeps working identically — just faster on warm caches.

## Architecture

### Files

| File | Action | Responsibility |
|---|---|---|
| `src/retrieval.js` | Modify (additive) | New: `loadCache`, `saveCache`, `syncCache`, `buildCorpusFromCache`. Existing: `rank()` now consults cache instead of tokenizing on every call. Everything else unchanged. |
| `src/test/retrieval.test.js` | Modify (additive) | Add 3 tests: cache roundtrip, sync diffs by mtime, rank warm/cold parity. All existing tests continue to pass. |
| `src/doctor.js` | Modify | Add `checkBm25Cache` that reports per-project cache presence + size. |
| `package.json` | Modify | `version` → `0.5.0`. `engines` stays `>=18`. |
| `README.md` | Modify | One line mentioning cache location; remove any stale "BM25 search" note needing updating. |

### Data flow

```
rank(query, candidates, config)
  ├─ loadCache(cwd) → Map<path, {mtime, terms, length}>  # or empty on miss/corrupt
  ├─ syncCache(cache, candidates)
  │    ├─ foreach candidate: if mtime > cache.mtime || !cache.has → tokenize body, store
  │    └─ drop cache entries whose path ∉ candidates
  ├─ saveCache(cwd, cache)        # only if mutated
  ├─ buildCorpusFromCache(cache)  # derive df / avgDL / N from cache values (no disk reads)
  └─ (existing) scoreSnapshot + bm25Score using cache-sourced _terms
```

### Cache file

- Path: `~/.config/ctx/bm25/<encoded_cwd>.json.gz`
  - Reuse `session.encodeCwd` (already used by `backup.js` for the same purpose).
  - Per-project file = bounded size, isolated invalidation.
- Format: gzipped JSON.
  - Atomic write: write to `<path>.tmp`, fsync, rename. Matches `backup.js::copyFileSync → gzip → atomic rename` pattern but adapted for serialized JSON (no source file).
- Schema:
  ```json
  {
    "v": 1,
    "snapshots": {
      "/abs/path/project_a.md": { "mtime": 1713600000, "terms": ["stripe","webhook","..."], "length": 42 }
    }
  }
  ```
- On parse failure (truncated gzip, bad JSON, version mismatch): silently return empty Map. The cache is a derived artifact — rebuilding from disk is always safe.

### Integration with existing code

- Candidate objects already carry `body` (from `readSnapshotHead`). `syncCache` calls `tokenizeBody(candidate.body)` only when the entry is new/stale.
- After sync, `rank()` attaches `_terms` and `length` onto each candidate from the cache, then calls the existing `buildCorpusStats` and `bm25Score` unchanged.
- `collectProjectCandidates` and `collectAllProjectsCandidates` stay identical — they still read `.md` files to get frontmatter and body. The cache is a *post-processing* layer, not a replacement for disk reads.

### What we still read from disk every query

We still:
- Scan the memory directory for `project_*.md` files.
- Read each file's frontmatter and body.
- Parse the frontmatter with `readSnapshotHead`.

The optimization avoids only **tokenization + corpus stat rebuild** (the expensive JS loop). The disk-read cost is bounded by file count × ~10 KB and is already fast.

A future optimization could skip reading bodies for unchanged files, but that requires caching bodies too and opens questions about cache staleness. YAGNI for now.

## Query scoping

Cache is per-project (keyed by `encodeCwd(memoryDir's parent)`). For the `collectAllProjectsCandidates` path (cross-project memory scan), we load caches for each encountered project separately and merge. Graceful degradation: if any single project's cache is missing/corrupt, we rebuild that one in memory without touching the others.

## Testing

New tests in `src/test/retrieval.test.js`:

1. `loadCache + saveCache roundtrip` — write a cache, read it back, assert deep equality.
2. `syncCache tokenizes only changed snapshots` — stub `tokenizeBody` via module-level counter; first sync tokenizes N; second sync with one file touched tokenizes 1; deleted file drops from cache.
3. `rank warm vs cold produce identical results` — rank with no cache, rank with populated cache, assert `results.map(r => r.snapshot.path)` matches.

Existing tests for `stemLite`, `fuzzyMatch`, `bm25Score`, `scoreSnapshot`, `rank`, `collectProjectCandidates` remain — they test the unchanged internals.

## Non-goals

- No phrase / boolean / prefix search syntax (would require a separate query parser; current BM25 already works on bag-of-words).
- No change to fuzzy matching behavior.
- No cross-query in-memory cache (each `rank()` reloads from disk — keeps CLI subcommands stateless).
- No cache invalidation command. User deletes the file; next query rebuilds.

## Risks

| Risk | Mitigation |
|---|---|
| Gzip/JSON parse failure on upgrade | Silent return of empty Map; next save writes v1 schema. No user-visible break. |
| Cache grows unbounded on long-lived project | Pruned naturally: `syncCache` drops entries for paths no longer on disk. Size tracks `collectProjectCandidates` cap (`max_candidates` = 2000). |
| Atomic write race (two `ctx ask` at once) | Last-write-wins on rename. Worst case: one query uses a slightly stale cache and retokenizes more than necessary. Correctness unaffected. |
| `tokenizeBody` behavior change later (e.g. new stopword list) | Bump cache `v` field; loader treats version mismatch as miss. Implemented via `if (parsed.v !== 1) return new Map()`. |

## Open questions

None.
