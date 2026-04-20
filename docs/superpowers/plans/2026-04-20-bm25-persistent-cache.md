# Persistent BM25 Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, per-project gzipped JSON cache of tokenized snapshot bodies so `rank()` only retokenizes files whose mtime changed since the last query.

**Architecture:** Additive. Existing BM25 logic untouched. New cache I/O layer in `src/retrieval.js`. Cache at `~/.config/ctx/bm25/<encoded_cwd>.json.gz`, gzip+atomic write (mirroring `backup.js` pattern). On load failure, treat as miss and rebuild from disk.

**Tech Stack:** Node ≥18, `zlib` (built-in), `fs`, no new deps.

**Spec:** `docs/superpowers/specs/2026-04-20-bm25-persistent-cache-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/retrieval.js` | Modify | Add `loadCache`, `saveCache`, `syncCache`, `buildCorpusFromCache`. Adjust `rank()` to consult cache. |
| `src/test/retrieval.test.js` | Modify | Append 3 tests (roundtrip, incremental sync, warm/cold parity). Existing tests preserved. |
| `src/doctor.js` | Modify | Add `checkBm25Cache` reporting present/absent + size. |
| `package.json` | Modify | Bump `version` to `0.5.0` (engines already `>=18`). |
| `README.md` | Modify | One line mentioning the BM25 cache path. |

---

## Task 1: Cache I/O — `loadCache`, `saveCache`, `syncCache` (TDD)

**Files:**
- Modify: `src/retrieval.js`
- Modify: `src/test/retrieval.test.js` (append 2 tests)

- [ ] **Step 1: Append failing tests to `src/test/retrieval.test.js`**

Append at the end of the file:

```javascript
const { loadCache, saveCache, syncCache, tokenizeBody } = require('../retrieval.js');

test('loadCache + saveCache roundtrip via gzip file', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cache-'));
  const cachePath = path.join(base, 'bm25', 'x.json.gz');
  try {
    const input = new Map([
      ['/a.md', { mtime: 1000, terms: ['stripe', 'webhook'], length: 25 }],
      ['/b.md', { mtime: 2000, terms: ['jwt'], length: 10 }],
    ]);
    saveCache(cachePath, input);
    assert.ok(fs.existsSync(cachePath), 'cache file written');
    const out = loadCache(cachePath);
    assert.equal(out.size, 2);
    assert.deepEqual(out.get('/a.md'), { mtime: 1000, terms: ['stripe', 'webhook'], length: 25 });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('loadCache returns empty Map on missing file, corrupt gzip, bad JSON, or version mismatch', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cache-'));
  try {
    assert.equal(loadCache(path.join(base, 'missing.json.gz')).size, 0, 'missing → empty');

    const corrupt = path.join(base, 'corrupt.json.gz');
    fs.writeFileSync(corrupt, Buffer.from([0x00, 0x01, 0x02]));
    assert.equal(loadCache(corrupt).size, 0, 'bad gzip → empty');

    const badJson = path.join(base, 'bad.json.gz');
    const zlib = require('zlib');
    fs.writeFileSync(badJson, zlib.gzipSync('not json'));
    assert.equal(loadCache(badJson).size, 0, 'bad json → empty');

    const wrongVersion = path.join(base, 'v2.json.gz');
    fs.writeFileSync(wrongVersion, zlib.gzipSync(JSON.stringify({ v: 2, snapshots: {} })));
    assert.equal(loadCache(wrongVersion).size, 0, 'wrong version → empty');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('syncCache tokenizes only new/changed snapshots and drops missing ones', () => {
  const cache = new Map();
  const candidates = [
    { path: '/a.md', mtime: 1000, body: 'stripe webhook idempotency' },
    { path: '/b.md', mtime: 1000, body: 'jwt auth' },
  ];
  const mutated1 = syncCache(cache, candidates);
  assert.ok(mutated1, 'first sync mutates');
  assert.equal(cache.size, 2);
  assert.ok(cache.get('/a.md').terms.includes('stripe'));

  // Re-sync with same mtimes → no mutation
  const mutated2 = syncCache(cache, candidates);
  assert.equal(mutated2, false, 'unchanged sync does not mutate');

  // Touch /a.md, drop /b.md, add /c.md
  const candidates2 = [
    { path: '/a.md', mtime: 2000, body: 'new content here' },
    { path: '/c.md', mtime: 3000, body: 'brand new snapshot' },
  ];
  const mutated3 = syncCache(cache, candidates2);
  assert.ok(mutated3, 'changed sync mutates');
  assert.equal(cache.size, 2);
  assert.ok(!cache.has('/b.md'), '/b.md dropped');
  assert.equal(cache.get('/a.md').mtime, 2000);
  assert.ok(cache.get('/a.md').terms.includes('content'));
  assert.ok(cache.has('/c.md'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/test/retrieval.test.js`
Expected: new tests FAIL (`loadCache`/`saveCache`/`syncCache` not exported). Existing tests still PASS.

- [ ] **Step 3: Implement the three functions in `src/retrieval.js`**

Add these imports near the top (after existing `require('fs')` and `require('path')`):

```javascript
const zlib = require('zlib');
const os   = require('os');
```

Add these functions before the existing `module.exports`:

```javascript
const CACHE_VERSION = 1;

function cachePathForProject(encodedCwd) {
  return path.join(os.homedir(), '.config', 'ctx', 'bm25', `${encodedCwd}.json.gz`);
}

function loadCache(cachePath) {
  try {
    const buf = fs.readFileSync(cachePath);
    const json = zlib.gunzipSync(buf).toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || parsed.v !== CACHE_VERSION || !parsed.snapshots) return new Map();
    return new Map(Object.entries(parsed.snapshots));
  } catch {
    return new Map();
  }
}

function saveCache(cachePath, cache) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const obj = { v: CACHE_VERSION, snapshots: Object.fromEntries(cache) };
    const gz = zlib.gzipSync(JSON.stringify(obj));
    const tmp = `${cachePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, gz);
    fs.renameSync(tmp, cachePath);
  } catch {
    // cache writes are best-effort; swallow failures so retrieval never breaks
  }
}

function syncCache(cache, candidates) {
  let mutated = false;
  const alive = new Set();
  for (const c of candidates) {
    alive.add(c.path);
    const mtimeInt = Math.floor(c.mtime);
    const prev = cache.get(c.path);
    if (!prev || prev.mtime < mtimeInt) {
      const terms = tokenizeBody(c.body);
      cache.set(c.path, { mtime: mtimeInt, terms, length: terms.length });
      mutated = true;
    }
  }
  for (const k of [...cache.keys()]) {
    if (!alive.has(k)) {
      cache.delete(k);
      mutated = true;
    }
  }
  return mutated;
}
```

Update `module.exports` to add the three new functions and `cachePathForProject`:

```javascript
module.exports = {
  readSnapshotHead,
  collectProjectCandidates,
  collectAllProjectsCandidates,
  scoreSnapshot,
  bm25Score,
  buildCorpusStats,
  tokenizeBody,
  stemLite,
  levenshtein,
  fuzzyMatch,
  rank,
  loadCache,
  saveCache,
  syncCache,
  cachePathForProject,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/test/retrieval.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval.js src/test/retrieval.test.js
git commit -m "feat(retrieval): add persistent BM25 cache I/O (load/save/sync)"
```

---

## Task 2: Wire `rank()` to use the cache

**Files:**
- Modify: `src/retrieval.js` (adjust `rank`, `collectProjectCandidates`)
- Modify: `src/test/retrieval.test.js` (append 1 test)

The cache is keyed per project. `collectProjectCandidates(memoryDir, ...)` already knows the project dir. We pass the memoryDir's parent's basename (= encoded cwd) through to `rank`.

- [ ] **Step 1: Write the failing test**

Append to `src/test/retrieval.test.js`:

```javascript
test('rank uses cache: warm and cold return identical ordering', () => {
  const { base, memoryDir } = tmpMemory([
    { name: 'project_s.md',  body: 'stripe webhook body',          ageDays: 1, categories: ['stripe'] },
    { name: 'project_a.md',  body: 'jwt auth login flow',          ageDays: 2, categories: ['auth'] },
    { name: 'project_s2.md', body: 'stripe subscription retry',    ageDays: 1, categories: ['stripe'] },
  ]);
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-home-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const config = loadDefaults();
    config.retrieval = { ...config.retrieval, top_n: 3, min_score: 0.01 };
    const candidates = collectProjectCandidates(memoryDir, config);
    const query = makeQuery('stripe webhook', config);

    const cold = rank(query, candidates, config);
    const warm = rank(query, candidates, config);

    assert.deepEqual(
      warm.map(r => r.snapshot.name),
      cold.map(r => r.snapshot.name),
      'warm and cold ordering must match'
    );

    // Cache file exists after the call
    const projectKey = path.basename(path.dirname(memoryDir));
    const cachePath = path.join(tmpHome, '.config', 'ctx', 'bm25', `${projectKey}.json.gz`);
    assert.ok(fs.existsSync(cachePath), 'cache file written');
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

**Note on `tmpMemory`:** the existing `tmpMemory` helper creates `memoryDir` at `<base>/memory` directly — there is no parent project dir. This test needs the memoryDir to be at `<base>/<encoded_cwd>/memory` so `path.basename(path.dirname(memoryDir))` yields a predictable name. Update `tmpMemory` so the layout is `<base>/-tmp-proj/memory/...`. Patch:

Find the existing helper:

```javascript
function tmpMemory(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ret-'));
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  ...
}
```

Replace with:

```javascript
function tmpMemory(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ret-'));
  const projectDir = path.join(base, '-tmp-proj');
  const memoryDir = path.join(projectDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  ...
}
```

Leave the rest of `tmpMemory` as-is. Existing tests that use it keep working because they pass `memoryDir` directly to `collectProjectCandidates`, which doesn't care about the parent structure.

- [ ] **Step 2: Run test — expect fail**

Run: `node --test src/test/retrieval.test.js`
Expected: new test FAILS (cache file not written because `rank` doesn't call saveCache yet).

- [ ] **Step 3: Modify `collectProjectCandidates` to stamp `project` onto each candidate**

In `src/retrieval.js`, locate the `collectProjectCandidates` function. Right after the line `const top = files.slice(0, maxCandidates);`, add:

```javascript
  const encoded = path.basename(path.dirname(memoryDir)) || null;
```

Then, inside the loop that builds candidates, add `encoded` to each candidate object. Change:

```javascript
    out.push({
      name: f.name,
      path: f.path,
      mtime: f.mtime,
      size: f.size,
      categories,
      body: head.body,
      length: head.body.length || 1,
      meta: head.meta,
    });
```

to:

```javascript
    out.push({
      name: f.name,
      path: f.path,
      project: encoded,
      mtime: f.mtime,
      size: f.size,
      categories,
      body: head.body,
      length: head.body.length || 1,
      meta: head.meta,
    });
```

- [ ] **Step 4: Modify `rank` to consult the cache**

Find the existing `rank` function:

```javascript
function rank(query, candidates, config) {
  const minScore = config?.retrieval?.min_score ?? 0.15;
  const topN     = config?.retrieval?.top_n     ?? 3;
  const corpus   = candidates.length ? buildCorpusStats(candidates) : null;
  const scored = [];
  ...
}
```

Replace with:

```javascript
function rank(query, candidates, config) {
  const minScore = config?.retrieval?.min_score ?? 0.15;
  const topN     = config?.retrieval?.top_n     ?? 3;

  // Group candidates by project, load+sync+save each project's cache
  const byProject = new Map();
  const unkeyed   = [];
  for (const c of candidates) {
    if (c.project) {
      if (!byProject.has(c.project)) byProject.set(c.project, []);
      byProject.get(c.project).push(c);
    } else {
      unkeyed.push(c);
    }
  }

  for (const [project, list] of byProject) {
    const cp = cachePathForProject(project);
    const cache = loadCache(cp);
    const mutated = syncCache(cache, list);
    if (mutated) saveCache(cp, cache);
    for (const c of list) {
      const entry = cache.get(c.path);
      if (entry) {
        c._terms = entry.terms;
        c.length = entry.length || c.length;
      }
    }
  }
  for (const c of unkeyed) {
    if (!c._terms) c._terms = tokenizeBody(c.body);
  }

  const corpus = candidates.length ? buildCorpusStats(candidates) : null;
  const scored = [];
  for (const c of candidates) {
    const s = scoreSnapshot(query, c, config, corpus);
    if (s.total < minScore) continue;
    scored.push({ snapshot: c, score: s.total, breakdown: s.breakdown });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}
```

Note: `buildCorpusStats` already populates `c._terms` if missing. With the cache in place, `_terms` is pre-populated for project candidates, so `buildCorpusStats` sees them directly — no double tokenization.

- [ ] **Step 5: Run all tests**

Run: `node --test src/test/*.test.js`
Expected: all PASS (including the new warm/cold parity test and the existing `rank returns top_n sorted` test).

- [ ] **Step 6: Commit**

```bash
git add src/retrieval.js src/test/retrieval.test.js
git commit -m "feat(retrieval): rank() uses persistent cache via syncCache"
```

---

## Task 3: Doctor check + version bump + README

**Files:**
- Modify: `src/doctor.js`
- Modify: `README.md`

(`package.json` is already at `0.5.0` from the earlier revert commit.)

- [ ] **Step 1: Add `checkBm25Cache` to `src/doctor.js`**

Near the top, add the require:

```javascript
const { cachePathForProject } = require('./retrieval.js');
```

Add the check function (place near other `check*` functions):

```javascript
function checkBm25Cache() {
  const dir = path.join(os.homedir(), '.config', 'ctx', 'bm25');
  if (!fs.existsSync(dir)) {
    return { ...CHECKS.info, label: 'BM25 cache', detail: 'not built yet' };
  }
  try {
    const names = fs.readdirSync(dir).filter(n => n.endsWith('.json.gz'));
    let total = 0;
    for (const n of names) total += fs.statSync(path.join(dir, n)).size;
    return { ...CHECKS.ok, label: 'BM25 cache', detail: `${names.length} project(s), ${Math.round(total / 1024)} KB` };
  } catch (err) {
    return { ...CHECKS.warn, label: 'BM25 cache', detail: `unreadable: ${err.message}` };
  }
}
```

Wire into `runChecks`. Find `results.push(checkLogRotation());` and add right before or after it:

```javascript
  results.push(checkBm25Cache());
```

- [ ] **Step 2: Smoke test manually**

Run: `./bin/ctx doctor`
Expected: new line `BM25 cache: not built yet` (or a count if any project has been queried before).

- [ ] **Step 3: Run full test suite**

Run: `node --test src/test/*.test.js`
Expected: all PASS.

- [ ] **Step 4: Update README**

Edit `README.md`. Near the existing mention of `~/.config/ctx/` (or in the "How it works" / "Install" section), add a line:

```markdown
- **BM25 cache** at `~/.config/ctx/bm25/<encoded-cwd>.json.gz` — gzipped tokenized snapshot bodies. Speeds up `ctx ask` after the first query. Safe to delete; rebuilds on next query.
```

- [ ] **Step 5: Commit**

```bash
git add src/doctor.js README.md
git commit -m "feat(doctor,docs): report BM25 cache stats; document cache path"
```

- [ ] **Step 6: Tag**

```bash
git tag v0.5.0
```

(Do NOT push the tag unless the user asks.)

---

## Verification checklist

- [ ] `node --test src/test/*.test.js` all green
- [ ] `./bin/ctx doctor` shows BM25 cache line
- [ ] Delete cache, run `ctx ask` — rebuilds silently
- [ ] Touch a snapshot file, run `ctx ask` twice — second is measurably faster (eyeball)
- [ ] `package.json` version `0.5.0`, engines `>=18`
- [ ] No new runtime deps in `package.json`
