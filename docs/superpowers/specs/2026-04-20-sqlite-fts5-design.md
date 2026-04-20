# SQLite FTS5 ranked search

**Date:** 2026-04-20
**Target version:** 0.5.0 (breaking — Node engine bump)
**Module touched:** `src/retrieval.js` (replace), `src/fts.js` (new), `src/test/fts.test.js` (new), `src/test/retrieval.test.js` (update), `package.json`, `README.md`

## Problem

`src/retrieval.js` re-reads every project snapshot on every `rank()` call, tokenizes in-memory, and runs pure-JS BM25. Works fine up to ~2000 snapshots but:

- No phrase search (`"exact match"`).
- No boolean ops (`AND`/`OR`/`NOT`).
- No prefix search (`auth*`).
- Every query pays full scan cost, even when nothing changed on disk.
- Corpus stats rebuilt from scratch per query.

Comparison repo `thedotmack/claude-mem` uses SQLite + FTS5 (plus a Chroma vector layer we don't touch). FTS5 alone — without LLM summarization or workers — is a realistic upgrade.

## Decision summary

1. Replace pure-JS BM25 with SQLite FTS5 via Node built-in `node:sqlite`.
2. Bump `engines.node` from `>=18` to `>=22.5`. Node 18 is EOL (April 2025); Node 22 is current Active LTS as of 2026-04. Acceptable for a personal dev tool whose audience runs current Node.
3. Lazy sync on query — no changes to `snapshot.js` or hook code. Single source of truth stays the `.md` files on disk; DB is derived cache.
4. Keep zero runtime dependencies (node:sqlite is a built-in).

## Architecture

### Data flow

```
rank(query, cwd) in retrieval.js
  ├─ collectProjectCandidates(memDir)        # unchanged — scans dir, reads frontmatter
  ├─ syncFtsIndex(candidates, db)             # NEW — diff disk vs DB by (path, mtime)
  │    ├─ UPSERT changed/new snapshots
  │    └─ DELETE rows whose path no longer exists
  ├─ ftsSearch(query, db) → [{path, bm25}]    # NEW — FTS5 MATCH query
  └─ scoreSnapshot blends {bm25, category, recency} as today
```

### New module: `src/fts.js`

Thin wrapper around `node:sqlite`. Exports:

- `openDb(dbPath)` — open/create, run migrations, return `Database` handle.
- `upsertSnapshot(db, {path, project, name, mtime, categories, body})`.
- `deleteMissing(db, project, existingPaths[])` — prune rows for paths not in the current scan.
- `ftsSearch(db, {project, query, limit})` — returns `[{path, bm25}]`.
- `close(db)`.

No connection pooling, no async queue. `node:sqlite` is synchronous; we own the DB single-process.

### DB location

`~/.config/ctx/index.db` (single global file). Per-project isolation via `project` column = encoded cwd (reuse `session.encodeCwd`). Rationale:

- Matches existing `~/.config/ctx/` layout (backups, hooks log).
- Single file simpler to back up / delete / inspect (`sqlite3 ~/.config/ctx/index.db`).
- Cross-project search (when/if we need it) is free.

### Schema

```sql
-- v1 migration
CREATE TABLE IF NOT EXISTS snapshots (
  path        TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  name        TEXT NOT NULL,
  mtime       INTEGER NOT NULL,
  categories  TEXT,             -- csv, e.g. "infra,tests"
  body        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_project_mtime
  ON snapshots(project, mtime DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS snapshots_fts USING fts5(
  body, categories,
  content='snapshots',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- external-content mode: we maintain fts sync via triggers
CREATE TRIGGER IF NOT EXISTS snapshots_ai AFTER INSERT ON snapshots BEGIN
  INSERT INTO snapshots_fts(rowid, body, categories)
    VALUES (new.rowid, new.body, new.categories);
END;

CREATE TRIGGER IF NOT EXISTS snapshots_ad AFTER DELETE ON snapshots BEGIN
  INSERT INTO snapshots_fts(snapshots_fts, rowid, body, categories)
    VALUES ('delete', old.rowid, old.body, old.categories);
END;

CREATE TRIGGER IF NOT EXISTS snapshots_au AFTER UPDATE ON snapshots BEGIN
  INSERT INTO snapshots_fts(snapshots_fts, rowid, body, categories)
    VALUES ('delete', old.rowid, old.body, old.categories);
  INSERT INTO snapshots_fts(rowid, body, categories)
    VALUES (new.rowid, new.body, new.categories);
END;

CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO schema_version(v) VALUES (1);
```

Rationale for `tokenize='unicode61 remove_diacritics 2'`:

- `unicode61` handles Turkish characters (`ç`, `ş`, `ğ`, `ı`, `ö`, `ü`) correctly.
- `remove_diacritics 2` folds `ç→c`, `ş→s` for recall. `karar` matches body containing `kararın`. Matches existing behavior of `remove_diacritics`-equivalent stemming in current `stemLite`.
- No custom tokenizer — FTS5's built-in covers our needs.

### Lazy sync algorithm (`syncFtsIndex`)

```
inputs:  candidates = [{path, project, name, mtime, categories, body}, ...]
         db

1. SELECT path, mtime FROM snapshots WHERE project = ?
   → Map<path, mtime>
2. For each candidate:
     if !db.has(path) or db.get(path) < candidate.mtime:
       UPSERT (INSERT OR REPLACE INTO snapshots ...)
3. candidatePaths = Set(candidates.map(c => c.path))
   For each db path not in candidatePaths:
     DELETE FROM snapshots WHERE path = ?
4. Wrap in `BEGIN IMMEDIATE / COMMIT` transaction.
```

Triggers handle FTS sync automatically on each UPSERT/DELETE.

Cost: one SELECT + N INSERT OR REPLACE where N = number of changed snapshots. For an incrementally-updated memory dir, N is near 0 on most queries.

### Query path (`ftsSearch`)

```sql
SELECT s.path, bm25(snapshots_fts) AS score
FROM snapshots_fts
JOIN snapshots s ON s.rowid = snapshots_fts.rowid
WHERE snapshots_fts MATCH ? AND s.project = ?
ORDER BY score
LIMIT ?;
```

FTS5's `bm25()` returns a score where **smaller is better** (can be negative; 0 is a perfect match). We min-max normalize within the returned result set so the top hit maps to 1.0 and the worst to 0.0:

```js
// rows: [{path, bm25}, ...] ORDER BY bm25 ASC
const best  = rows[0]?.bm25 ?? 0;
const worst = rows[rows.length - 1]?.bm25 ?? best;
const span  = Math.max(1e-9, worst - best);
for (const r of rows) r.normalized = 1 - (r.bm25 - best) / span;
```

This is stable regardless of FTS5's sign convention and keeps the blend weights meaningful.

### Query string transformation

Input: arbitrary user string (e.g. `"how did we fix the auth timeout bug"` or `"auth* AND (timeout OR bug)"`).

Strategy:

1. Try the string as-is — if FTS5 parses it, use it (power users get phrase/boolean/prefix).
2. On `SyntaxError` (FTS5 throws for unbalanced quotes, reserved tokens, etc.), fall back to **prefix mode**:
   - Strip characters FTS5 hates: `"'()` → space.
   - Split on whitespace, drop stopwords (reuse `query.js` stopword list), length>1.
   - Join with space and append `*` to each term: `auth* timeout* bug*`.
3. Both attempts wrapped in try/catch; on any error return empty results (retrieval degrades silently, matching project invariant).

### Blending with existing scoring

`scoreSnapshot()` in `retrieval.js` stays the shape it is today:

```js
total = weights.category * categoryScore
      + weights.bm25     * bm25Score
      + weights.recency  * recencyScore
```

Only `bm25Score` changes source: was in-memory BM25, now FTS5-derived normalized score. Weights in `config.default.json` don't move.

### Deletions / drops

- `fts.js::openDb` is idempotent. If user deletes `index.db`, next query rebuilds from scratch (first query slower, then normal).
- `ctx doctor` adds a line: `fts: <rowcount> snapshots indexed, <size> on disk`.
- No `ctx index rebuild` command — delete the file and requery is the same thing. YAGNI.

## Breaking changes

- `package.json`:
  - `"engines": { "node": ">=22.5" }`
  - `"version": "0.5.0"`
- README: under "Requirements", add Node 22.5+.
- CHANGELOG (if exists, else commit body): call out engine bump + SQLite index path.
- Levenshtein fuzzy matching (`fuzzyMatch`, `levenshtein` in current `retrieval.js`) removed. Prefix search (`auth*`) covers most typos via stem expansion. This is a real recall regression on single-character typos where prefix doesn't help (e.g. `karar` vs `karrr`); judged acceptable because queries are usually copy-paste, not hand-typed one-shot terms. If it bites in practice, add back with a SQLite extension later.

## What stays unchanged

- `snapshot.js` — writes `.md` files exactly as today. DB has no knowledge of it.
- Hook handlers (`hooks.js`, `pipeline.js`) — unchanged.
- MCP tools (`mcp_tools.js::ctx_ask`, `ctx_timeline`) — unchanged; `rank()` signature identical.
- `notes.js`, `timeline.js`, `stats.js`, `diff.js` — unchanged (they read `.md` directly, not the DB).
- `config.default.json` — retrieval weights unchanged.
- Frontmatter contract in snapshots — unchanged.

## Testing

New: `src/test/fts.test.js`

- `openDb` creates schema v1 on fresh path.
- `upsertSnapshot` inserts and triggers FTS row.
- Re-upsert same path with newer mtime → single row, updated body indexed.
- `deleteMissing` removes stale rows.
- `ftsSearch` returns matches ranked by bm25; phrase search works; prefix works; boolean works.
- Syntax-error input falls back gracefully (returns results for bag-of-words interpretation).
- Turkish tokens: `karar` matches body containing `kararın`.
- Each test opens DB in a temp dir (`fs.mkdtempSync`), cleans up after.

Update: `src/test/retrieval.test.js`

- Uses same fixture snapshots as today.
- Asserts top-3 sorting order for a canonical query matches expected paths (not absolute scores — scores differ from old BM25).
- Asserts empty query → empty result.
- Asserts sync handles: add snapshot, delete snapshot, touch snapshot (mtime bump).

## Non-goals

- No Chroma / embeddings / semantic search.
- No cross-project search UI (schema supports it; no CLI flag yet).
- No worker process. `node:sqlite` in-process is enough.
- No migration from old BM25 cache (none existed).
- No exposure of FTS5 query syntax in docs beyond a one-line mention in README.

## Risks

| Risk | Mitigation |
|---|---|
| User on Node <22.5 runs `ctx ask` after upgrade | Engine field + clear error at CLI entry (`node -v` check in `bin/ctx`) pointing at Node upgrade. |
| DB file corrupted (disk full, kill -9 mid-write) | All writes in `BEGIN IMMEDIATE` txn. If open fails with `SQLITE_CORRUPT` or schema mismatch, rename to `index.db.corrupt-<ts>` and recreate empty; log both events to `~/.config/ctx/hooks.log`. DB is derived cache so no data loss. |
| Trigger syntax error on upgrade across SQLite versions | `node:sqlite` ships with SQLite ≥3.44 on Node 22.5, FTS5 + external-content triggers fully supported. Pin known-good schema in migration v1. |
| Large body text blows FTS5 index | Current snapshots are ~1–10KB. FTS5 handles MB-scale easily. Not a real risk at our corpus size. |

## Open questions

None.
