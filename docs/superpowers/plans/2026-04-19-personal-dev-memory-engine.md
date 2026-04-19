# Personal Dev Memory Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ctx's pasif snapshot arşivini, aranabilir ve Claude Code'a otomatik enjekte edilen bir dev hafıza motoruna dönüştürmek.

**Architecture:** Saf fonksiyonel modüller (query, retrieval, notes, timeline, diff, stats) + mevcut snapshot/hook/cli'ye eklemeler. Ranking = keyword + kategori + tazelik hibrid formülü. İndex yok — scan-on-query. Zero deps, no LLM.

**Tech Stack:** Node ≥18 built-ins only (`fs`, `path`, `os`, `crypto`, `zlib`, `node:test`, `node:assert/strict`). Mevcut modüller: `pipeline.js`, `analyzer.js`, `snapshot.js`, `session.js`.

**Spec:** `docs/superpowers/specs/2026-04-19-personal-dev-memory-engine-design.md`

---

## File Structure

### Yeni dosyalar
| Path | Sorumluluk |
|---|---|
| `src/query.js` | Query string → {tokens, nonStop, categories}. Saf fonksiyon. |
| `src/retrieval.js` | Aday toplama + skorlama + ranking. Saf fonksiyon. |
| `src/notes.js` | Kullanıcı notes root'larında .md file walk (exclude + size cap + symlink guard). |
| `src/timeline.js` | Parent pointer chain traversal, thread gruplama. |
| `src/diff.js` | İki snapshot'ın body parse'ı + set delta (files, decisions, failed attempts). |
| `src/stats.js` | Session/commit/category haftalık-aylık aggregation. |
| `src/test/query.test.js` | Tokenize + stopword + kategori çıkarımı. |
| `src/test/retrieval.test.js` | Ranking sıralaması, skor formülü, min_score/top_n filtreleri. |
| `src/test/notes.test.js` | Walk + exclude + size cap + symlink skip. |
| `src/test/timeline.test.js` | Chain traversal + kırık parent tolerance. |
| `src/test/diff.test.js` | Set delta, order-independent. |
| `src/test/stats.test.js` | Aggregation. |

### Değişen dosyalar
| Path | Değişiklik |
|---|---|
| `src/snapshot.js` | `writeSnapshot` → frontmatter'a `parent:` + `categories:` ekliyor. |
| `src/hooks.js` | `handleUserPromptSubmit` → auto-retrieve mantığı. |
| `src/cli.js` | 5 yeni komut dispatch (`ask`, `search`, `timeline`, `diff`, `stats`). |
| `src/output.js` | `printRetrieval`, `printTimeline`, `printDiff`, `printStats`. |
| `config.default.json` | `notes.*`, `retrieval.*`, `stopwords.*`, `hooks.user_prompt_submit.auto_retrieve.*`. |
| `README.md` | Yeni bölüm: "Memory engine — search + auto-retrieve". |
| `CLAUDE.md` | Architecture diyagramı güncelle, modül boundary'leri ekle. |

---

## Task 1: query.js — query tokenize + kategorize

**Files:**
- Create: `src/query.js`
- Test: `src/test/query.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/query.test.js
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { makeQuery, tokenize, filterStopwords } = require('../query.js');
const { loadDefaults } = require('../config.js');

test('tokenize lowercases and splits on non-word chars, strips clitics', () => {
  assert.deepEqual(
    tokenize("Stripe webhook'u nasıl bağlamıştık"),
    ['stripe', 'webhook', 'nasıl', 'bağlamıştık']
  );
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('foo, bar; baz.'), ['foo', 'bar', 'baz']);
});

test('filterStopwords removes tr+en stopwords', () => {
  const stopwords = { tr: ['ve', 'bir', 'için'], en: ['the', 'and', 'how'] };
  assert.deepEqual(
    filterStopwords(['stripe', 've', 'webhook', 'için'], stopwords),
    ['stripe', 'webhook']
  );
  assert.deepEqual(
    filterStopwords(['the', 'api', 'and', 'auth'], stopwords),
    ['api', 'auth']
  );
});

test('makeQuery returns tokens, nonStop, categories', () => {
  const config = loadDefaults();
  const q = makeQuery('stripe webhook kurdum', config);
  assert.ok(Array.isArray(q.tokens));
  assert.ok(Array.isArray(q.nonStop));
  assert.ok(Array.isArray(q.categories));
  assert.ok(q.categories.includes('stripe'), `expected 'stripe' in ${q.categories}`);
  assert.equal(q.raw, 'stripe webhook kurdum');
});

test('makeQuery handles empty / only-stopword input gracefully', () => {
  const config = loadDefaults();
  const q1 = makeQuery('', config);
  assert.equal(q1.nonStop.length, 0);
  assert.equal(q1.categories.length, 0);
  const q2 = makeQuery('ve bir için', config);
  assert.equal(q2.nonStop.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/query.test.js`
Expected: FAIL with "Cannot find module '../query.js'"

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/query.js
'use strict';

function tokenize(str) {
  if (!str) return [];
  return String(str)
    .toLowerCase()
    .replace(/['’](?:u|un|ün|in|yi|yı|yu|yü|a|e|da|de|den|dan|ta|te|ya|ye)\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function filterStopwords(tokens, stopwords) {
  const set = new Set([...(stopwords?.tr || []), ...(stopwords?.en || [])]);
  return tokens.filter(t => !set.has(t));
}

function categorize(tokens, categories) {
  const text = tokens.join(' ');
  const out = [];
  for (const [key, cat] of Object.entries(categories || {})) {
    const words = cat.words || [];
    if (words.some(w => text.includes(w.toLowerCase()))) out.push(key);
  }
  return out;
}

function makeQuery(raw, config) {
  const tokens  = tokenize(raw);
  const nonStop = filterStopwords(tokens, config?.stopwords || {});
  const categories = categorize(nonStop, config?.categories || {});
  return { raw, tokens, nonStop, categories };
}

module.exports = { tokenize, filterStopwords, categorize, makeQuery };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/test/query.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/query.js src/test/query.test.js
git commit -m "feat(query): tokenize + stopword + categorize primitives"
```

---

## Task 2: retrieval.js — aday toplama + skorlama + ranking

**Files:**
- Create: `src/retrieval.js`
- Test: `src/test/retrieval.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/retrieval.test.js
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { loadDefaults } = require('../config.js');
const { makeQuery } = require('../query.js');
const { rank, scoreSnapshot, collectProjectCandidates } = require('../retrieval.js');

function tmpMemory(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-ret-'));
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const now = Date.now();
  for (const { name, body, ageDays, categories } of files) {
    const fm = [
      '---',
      `name: ${name}`,
      categories ? `categories: [${categories.join(', ')}]` : null,
      'fingerprint: aaaaaaaaaaaaaaaa',
      '---',
    ].filter(Boolean).join('\n');
    const full = path.join(memoryDir, name);
    fs.writeFileSync(full, `${fm}\n${body}`);
    const t = new Date(now - (ageDays || 0) * 86_400_000);
    fs.utimesSync(full, t, t);
  }
  return { base, memoryDir };
}

test('scoreSnapshot combines category + keyword + recency', () => {
  const config = loadDefaults();
  const query  = makeQuery('stripe webhook', config);
  const snap   = {
    path: '/x/project_s.md',
    body: 'stripe webhook idempotency header',
    mtime: Date.now() - 7 * 86_400_000,
    categories: ['stripe'],
    length: 40,
  };
  const r = scoreSnapshot(query, snap, config);
  assert.ok(r.total > 0);
  assert.ok(r.breakdown.category > 0, 'category hit');
  assert.ok(r.breakdown.keyword > 0,  'keyword hit');
  assert.ok(r.breakdown.recency > 0.5, 'recent decays slowly');
});

test('rank returns top_n sorted, filters below min_score', () => {
  const { base, memoryDir } = tmpMemory([
    { name: 'project_stripe.md',  body: 'stripe webhook body',                 ageDays: 1,  categories: ['stripe'] },
    { name: 'project_auth.md',    body: 'jwt auth login flow',                 ageDays: 2,  categories: ['auth'] },
    { name: 'project_old.md',     body: 'stripe webhook again but very old',   ageDays: 400, categories: ['stripe'] },
  ]);
  const config = loadDefaults();
  config.retrieval = { ...config.retrieval, top_n: 2, min_score: 0.01 };
  try {
    const candidates = collectProjectCandidates(memoryDir, config);
    const query = makeQuery('stripe webhook', config);
    const results = rank(query, candidates, config);
    assert.ok(results.length <= 2, `top_n=2, got ${results.length}`);
    assert.equal(results[0].snapshot.name, 'project_stripe.md', 'newest stripe snap wins');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('rank returns empty when query has no signal', () => {
  const { base, memoryDir } = tmpMemory([
    { name: 'project_a.md', body: 'unrelated content here', ageDays: 1 },
  ]);
  const config = loadDefaults();
  config.retrieval = { ...config.retrieval, min_score: 0.5 };
  try {
    const candidates = collectProjectCandidates(memoryDir, config);
    const q = makeQuery('completely unrelated xyzzy', config);
    const r = rank(q, candidates, config);
    assert.equal(r.length, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('collectProjectCandidates reads frontmatter categories when present', () => {
  const { base, memoryDir } = tmpMemory([
    { name: 'project_a.md', body: 'body', ageDays: 1, categories: ['stripe', 'api'] },
  ]);
  try {
    const c = collectProjectCandidates(memoryDir, loadDefaults());
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].categories.sort(), ['api', 'stripe']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/retrieval.test.js`
Expected: FAIL with "Cannot find module '../retrieval.js'"

- [ ] **Step 3: Write minimal implementation**

```javascript
// src/retrieval.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { categorize } = require('./query.js');

function readSnapshotHead(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const endMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    const fm = endMatch ? endMatch[1] : '';
    const body = endMatch ? endMatch[2] : raw;
    const meta = {};
    for (const line of fm.split('\n')) {
      const m = line.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
      if (!m) continue;
      meta[m[1]] = m[2].trim();
    }
    if (meta.categories) {
      meta.categories = meta.categories.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
    } else {
      meta.categories = [];
    }
    return { meta, body, raw };
  } catch {
    return null;
  }
}

function collectProjectCandidates(memoryDir, config) {
  if (!fs.existsSync(memoryDir)) return [];
  const maxCandidates = config?.retrieval?.max_candidates ?? 2000;
  let names;
  try { names = fs.readdirSync(memoryDir); } catch { return []; }
  const files = [];
  for (const name of names) {
    if (!name.startsWith('project_') || !name.endsWith('.md')) continue;
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    files.push({ name, path: full, mtime: stat.mtimeMs, size: stat.size });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const top = files.slice(0, maxCandidates);

  const out = [];
  for (const f of top) {
    const head = readSnapshotHead(f.path);
    if (!head) continue;
    let categories = head.meta.categories;
    if (!categories.length) {
      categories = categorize(head.body.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean), config?.categories || {});
    }
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
  }
  return out;
}

function scoreSnapshot(query, snap, config) {
  const weights = config?.retrieval?.weights || { category: 0.5, keyword: 0.3, recency: 0.2 };
  const halfLife = config?.retrieval?.recency_half_life_days || 90;

  const qCats = new Set(query.categories);
  const sCats = new Set(snap.categories || []);
  let inter = 0;
  for (const c of qCats) if (sCats.has(c)) inter++;
  const categoryScore = qCats.size === 0 ? 0 : inter / qCats.size;

  let keywordScore = 0;
  if (query.nonStop.length) {
    const lower = (snap.body || '').toLowerCase();
    let total = 0;
    for (const term of query.nonStop) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const matches = lower.match(re);
      if (matches) total += matches.length;
    }
    keywordScore = Math.min(total / Math.sqrt(Math.max(snap.length, 1)), 1.0);
  }

  const days = Math.max(0, (Date.now() - (snap.mtime || Date.now())) / 86_400_000);
  const recencyScore = Math.pow(2, -days / halfLife);

  const total = weights.category * categoryScore
              + weights.keyword  * keywordScore
              + weights.recency  * recencyScore;

  return {
    total,
    breakdown: { category: categoryScore, keyword: keywordScore, recency: recencyScore },
  };
}

function rank(query, candidates, config) {
  const minScore = config?.retrieval?.min_score ?? 0.15;
  const topN     = config?.retrieval?.top_n     ?? 3;
  const scored = [];
  for (const c of candidates) {
    const s = scoreSnapshot(query, c, config);
    if (s.total < minScore) continue;
    scored.push({ snapshot: c, score: s.total, breakdown: s.breakdown });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

module.exports = {
  readSnapshotHead,
  collectProjectCandidates,
  scoreSnapshot,
  rank,
};
```

- [ ] **Step 4: Add retrieval defaults to config**

Modify `config.default.json` — add inside root object, alongside existing keys:

```json
"retrieval": {
  "weights": { "category": 0.5, "keyword": 0.3, "recency": 0.2 },
  "recency_half_life_days": 90,
  "min_score": 0.15,
  "top_n": 3,
  "max_candidates": 2000,
  "scan_timeout_ms": 2000
},
"stopwords": {
  "tr": ["ve","bir","bu","ne","nasıl","için","ile","mi","mu","ama","fakat","ki","o","şu","da","de","ya","mı","ya da","şöyle","böyle"],
  "en": ["the","and","how","what","to","a","an","is","are","was","were","be","or","of","in","on","at","it","this","that"]
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/test/query.test.js src/test/retrieval.test.js`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add src/retrieval.js src/test/retrieval.test.js config.default.json
git commit -m "feat(retrieval): scan + score + rank snapshots"
```

---

## Task 3: ctx ask — CLI wiring

**Files:**
- Modify: `src/cli.js` (add `runAsk`, dispatch)
- Modify: `src/output.js` (add `printRetrieval`)
- Modify: `src/strategy.js` veya reuse existing copyToClipboard

- [ ] **Step 1: Add printRetrieval in output.js**

Insert after `printSnapshotResult` in `src/output.js`:

```javascript
function printRetrieval(results, query, opts = {}) {
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      query: query.raw,
      tokens: query.nonStop,
      categories: query.categories,
      results: results.map(r => ({
        score: +r.score.toFixed(3),
        breakdown: r.breakdown,
        name: r.snapshot.name,
        path: r.snapshot.path,
        categories: r.snapshot.categories,
      })),
    }, null, 2) + '\n');
    return;
  }
  console.log('');
  console.log(C.bold + `  ctx ask — "${query.raw}"` + C.reset);
  console.log(C.dim + `    query tokens: ${query.nonStop.join(' ')} | categories: ${query.categories.join(', ') || '(none)'}` + C.reset);
  console.log('');
  if (!results.length) {
    console.log(C.gray + '  No matches above min_score.' + C.reset);
    console.log('');
    return;
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const b = r.breakdown;
    const age = timeAgo(r.snapshot.mtime);
    console.log(`  ${C.bold}#${i + 1}${C.reset}  ${C.green}score ${r.score.toFixed(2)}${C.reset}  ${r.snapshot.name}`);
    console.log(`      ${C.gray}matched: category=${b.category.toFixed(2)} keyword=${b.keyword.toFixed(2)} recency=${b.recency.toFixed(2)}${C.reset}`);
    console.log(`      ${C.gray}cats: ${(r.snapshot.categories || []).join(', ') || '(none)'} | ${age}${C.reset}`);
    const firstBody = (r.snapshot.body || '').split('\n').filter(l => l.trim()).slice(0, 3).join(' ').slice(0, 140);
    if (firstBody) console.log(`      ${firstBody}`);
    console.log(C.dim + `      ${r.snapshot.path}` + C.reset);
    console.log('');
  }
}
```

Also add `printRetrieval` to module.exports.

- [ ] **Step 2: Add runAsk in cli.js**

Add to imports block:

```javascript
const { makeQuery } = require('./query.js');
const { collectProjectCandidates, rank } = require('./retrieval.js');
const { printRetrieval } = require('./output.js');
```

Add function before `runHook`:

```javascript
function runAsk(args, config) {
  stripColor();
  const cwd = process.cwd();
  const queryParts = [];
  let asJson = false;
  let doInject = false;
  let useGlobal = false;
  let useNotes  = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json')     asJson = true;
    else if (a === '--inject') doInject = true;
    else if (a === '--global') useGlobal = true;
    else if (a === '--notes')  useNotes  = true;
    else queryParts.push(a);
  }
  if (!queryParts.length) {
    console.error('❌ ctx ask "<query>"');
    return 1;
  }

  const raw = queryParts.join(' ');
  const query = makeQuery(raw, config);

  const memoryDir = resolveMemoryDir(cwd, config);
  const candidates = collectProjectCandidates(memoryDir, config);
  const results = rank(query, candidates, config);

  printRetrieval(results, query, { json: asJson });

  if (doInject && results.length) {
    const top = results[0];
    const { copyToClipboard } = require('./strategy.js');
    const injected = buildInjectionBlock(top.snapshot);
    const ok = copyToClipboard(injected);
    if (!asJson) {
      console.log(ok
        ? C.green + '  ✓ Top match copied to clipboard.' + C.reset
        : C.yellow + '  ⚠ clipboard not available (non-darwin).' + C.reset);
      console.log('');
    }
  }
  return 0;
}

function buildInjectionBlock(snap) {
  return [
    `[ctx] Relevant past work from: ${snap.name}`,
    '',
    (snap.body || '').split('\n').slice(0, 40).join('\n'),
    '',
    `(source: ${snap.path})`,
  ].join('\n');
}
```

Add switch case:

```javascript
    case 'ask':
      return runAsk(rest, config);
```

Also update `printHelp` to list `ctx ask "<query>" [--global] [--notes] [--inject] [--json]`.

- [ ] **Step 3: Smoke test with a real snapshot**

Run:
```bash
./bin/ctx ask "stripe webhook"
```
Expected: no match on this repo (no snapshots), graceful "No matches".

- [ ] **Step 4: Commit**

```bash
git add src/cli.js src/output.js
git commit -m "feat(cli): ctx ask - ranked snapshot search"
```

---

## Task 4: --global scope (tüm projeler)

**Files:**
- Modify: `src/retrieval.js` (add `collectAllProjectsCandidates`)
- Modify: `src/cli.js::runAsk` (honor `--global`)
- Test: `src/test/retrieval.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/test/retrieval.test.js`:

```javascript
const { collectAllProjectsCandidates } = require('../retrieval.js');

test('collectAllProjectsCandidates aggregates across projects/*/memory', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-glob-'));
  const root = path.join(base, 'projects');
  fs.mkdirSync(path.join(root, '-tmp-a', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(root, '-tmp-b', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '-tmp-a', 'memory', 'project_x.md'),
    '---\nname: x\nfingerprint: aaaa\n---\nstripe webhook'
  );
  fs.writeFileSync(
    path.join(root, '-tmp-b', 'memory', 'project_y.md'),
    '---\nname: y\nfingerprint: bbbb\n---\nother body'
  );

  try {
    const c = collectAllProjectsCandidates(root, loadDefaults());
    assert.equal(c.length, 2, 'both projects contributed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/retrieval.test.js`
Expected: FAIL with "collectAllProjectsCandidates is not a function"

- [ ] **Step 3: Add collectAllProjectsCandidates**

Append to `src/retrieval.js`:

```javascript
function collectAllProjectsCandidates(projectsRoot, config) {
  if (!fs.existsSync(projectsRoot)) return [];
  let names;
  try { names = fs.readdirSync(projectsRoot); } catch { return []; }
  const all = [];
  for (const name of names) {
    const memDir = path.join(projectsRoot, name, 'memory');
    try {
      if (!fs.statSync(memDir).isDirectory()) continue;
    } catch { continue; }
    const part = collectProjectCandidates(memDir, config);
    for (const c of part) all.push(c);
  }
  all.sort((a, b) => b.mtime - a.mtime);
  const cap = config?.retrieval?.max_candidates ?? 2000;
  return all.slice(0, cap);
}

module.exports.collectAllProjectsCandidates = collectAllProjectsCandidates;
```

- [ ] **Step 4: Wire --global in runAsk**

In `src/cli.js::runAsk` body, replace the `collectProjectCandidates(...)` line with:

```javascript
  const { CLAUDE_DIR } = require('./session.js');
  const { collectAllProjectsCandidates } = require('./retrieval.js');
  let candidates;
  if (useGlobal) {
    candidates = collectAllProjectsCandidates(CLAUDE_DIR, config);
  } else {
    const memoryDir = resolveMemoryDir(cwd, config);
    candidates = collectProjectCandidates(memoryDir, config);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test src/test/retrieval.test.js`
Expected: PASS (all, including new one)

- [ ] **Step 6: Commit**

```bash
git add src/cli.js src/retrieval.js src/test/retrieval.test.js
git commit -m "feat(retrieval): --global scans all projects"
```

---

## Task 5: notes.js — kullanıcı markdown köklerini ara

**Files:**
- Create: `src/notes.js`
- Test: `src/test/notes.test.js`
- Modify: `config.default.json` (add `notes`)
- Modify: `src/cli.js::runAsk` (honor `--notes`)

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/notes.test.js
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { walkMarkdown, expandRoots, collectNotesCandidates } = require('../notes.js');

function mk(tmp, files) {
  for (const { rel, content, size } of files) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content || 'x'.repeat(size || 10));
  }
}

test('walkMarkdown returns .md files, excludes patterns, respects size', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-notes-'));
  mk(tmp, [
    { rel: 'a.md', content: 'alpha' },
    { rel: 'sub/b.md', content: 'beta' },
    { rel: 'node_modules/pkg/c.md', content: 'excluded' },
    { rel: 'big.md', size: 2_000_000 },
    { rel: 'not-md.txt', content: 'skip' },
  ]);
  try {
    const found = walkMarkdown(tmp, {
      exclude: ['node_modules'],
      maxBytes: 512 * 1024,
      followSymlinks: false,
    });
    const names = found.map(f => path.basename(f.path)).sort();
    assert.deepEqual(names, ['a.md', 'b.md'], `got ${names.join(',')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('expandRoots resolves ~ to homedir', () => {
  const roots = expandRoots(['~/somewhere', '/abs/path']);
  assert.match(roots[0], /^\/(?!~)/);
  assert.equal(roots[1], '/abs/path');
});

test('collectNotesCandidates returns zero when roots empty', () => {
  const out = collectNotesCandidates([], { notes: { exclude: [], max_file_kb: 512, follow_symlinks: false } });
  assert.equal(out.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/notes.test.js`
Expected: FAIL with "Cannot find module '../notes.js'"

- [ ] **Step 3: Implement notes.js**

```javascript
// src/notes.js
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function expandRoots(roots) {
  return (roots || []).map(r => {
    if (!r) return null;
    if (r.startsWith('~')) return path.join(os.homedir(), r.slice(1));
    return path.resolve(r);
  }).filter(Boolean);
}

function walkMarkdown(root, opts) {
  const exclude = new Set(opts.exclude || []);
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const followSymlinks = !!opts.followSymlinks;
  const out = [];
  const visited = new Set();

  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);

    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (exclude.has(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = followSymlinks ? fs.statSync(full) : fs.lstatSync(full);
      } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile()) continue;
      if (!name.endsWith('.md')) continue;
      if (stat.size > maxBytes) continue;
      out.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  try {
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root);
  } catch {}
  return out;
}

function collectNotesCandidates(roots, config) {
  const notes = config?.notes || {};
  const exclude = notes.exclude || [];
  const maxBytes = (notes.max_file_kb || 512) * 1024;
  const followSymlinks = !!notes.follow_symlinks;
  const expanded = expandRoots(roots);
  const out = [];
  for (const r of expanded) {
    const items = walkMarkdown(r, { exclude, maxBytes, followSymlinks });
    for (const i of items) {
      let body = '';
      try { body = fs.readFileSync(i.path, 'utf8'); } catch {}
      out.push({
        name: path.basename(i.path),
        path: i.path,
        mtime: i.mtime,
        size: i.size,
        categories: [],
        body,
        length: body.length || 1,
        meta: { source: 'notes' },
      });
    }
  }
  return out;
}

module.exports = { expandRoots, walkMarkdown, collectNotesCandidates };
```

- [ ] **Step 4: Add notes defaults to config**

Modify `config.default.json`, add alongside other keys:

```json
"notes": {
  "roots": [],
  "exclude": ["node_modules", ".git", "dist", "build", ".cache", "vendor", "target"],
  "max_file_kb": 512,
  "follow_symlinks": false
}
```

- [ ] **Step 5: Wire --notes in runAsk**

In `src/cli.js::runAsk`, after candidates is built:

```javascript
  if (useNotes) {
    const { collectNotesCandidates } = require('./notes.js');
    const extra = collectNotesCandidates(config?.notes?.roots || [], config);
    candidates = candidates.concat(extra);
  }
```

- [ ] **Step 6: Run tests**

Run: `node --test src/test/notes.test.js`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add src/notes.js src/test/notes.test.js config.default.json src/cli.js
git commit -m "feat(notes): scan user markdown roots with --notes"
```

---

## Task 6: Snapshot frontmatter — `parent:` + `categories:`

**Files:**
- Modify: `src/snapshot.js` (writeSnapshot + buildMarkdown)
- Test: `src/test/snapshot.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `src/test/snapshot.test.js`:

```javascript
test('writeSnapshot emits parent and categories in frontmatter', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-parent-'));
  const fakeCwd = '/tmp/ctx-parent';
  const config  = loadDefaults();
  config.snapshot = {
    memory_dir: path.join(tmpBase, 'memory'),
    auto_index_update: true,
    dedup_window_n: 0,
  };

  try {
    const entries  = parseJSONL(FIXTURE);
    const analysis = analyzeEntries(entries, config);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, config);
    const strategy = buildStrategy(analysis, decision, config);

    const first = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, sessionId: 'sid', modelId: 'claude-opus-4-7', trigger: 'manual',
    });
    const firstContent = fs.readFileSync(first.outPath, 'utf8');
    assert.match(firstContent, /categories: \[/);
    assert.doesNotMatch(firstContent, /^parent:/m, 'no parent for first');

    const second = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, customName: 'different', sessionId: 'sid2', modelId: 'claude-opus-4-7', trigger: 'manual',
    });
    const secondContent = fs.readFileSync(second.outPath, 'utf8');
    assert.match(secondContent, new RegExp(`parent: ${path.basename(first.outPath)}`));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/test/snapshot.test.js`
Expected: FAIL — no `categories:` line or no `parent:` line

- [ ] **Step 3: Extend writeSnapshot**

In `src/snapshot.js::writeSnapshot`, before calling `buildMarkdown`, compute:

```javascript
  const parent = (() => {
    const recent = readRecentFingerprints(memoryDir, 1);
    return recent[0] ? recent[0].name : null;
  })();

  const categoryKeys = [...analysis.activeCategories.keys()];
```

Pass both into options:

```javascript
  const markdown = buildMarkdown(analysis, decision, strategy, {
    name,
    categories,
    sessionId,
    modelId,
    trigger: trigger || 'manual',
    fingerprint,
    parent,
    categoryKeys,
  });
```

In `buildMarkdown`, after the other frontmatter lines:

```javascript
  if (categoryKeys && categoryKeys.length) {
    sections.push(`categories: [${categoryKeys.join(', ')}]`);
  }
  if (parent) {
    sections.push(`parent: ${parent}`);
  }
```

And update destructure at top of `buildMarkdown`:

```javascript
  const { name, categories, sessionId, modelId, trigger, fingerprint, parent, categoryKeys } = options;
```

- [ ] **Step 4: Run tests to verify passes**

Run: `node --test src/test/snapshot.test.js`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.js src/test/snapshot.test.js
git commit -m "feat(snapshot): parent pointer + categories frontmatter"
```

---

## Task 7: ctx timeline — parent chain traversal

**Files:**
- Create: `src/timeline.js`
- Test: `src/test/timeline.test.js`
- Modify: `src/output.js` (printTimeline)
- Modify: `src/cli.js` (runTimeline + dispatch)

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/timeline.test.js
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { buildThreads } = require('../timeline.js');

function mkSnap(dir, name, { parent, fingerprint, ageDays = 0, categories = [] }) {
  const full = path.join(dir, name);
  const lines = ['---', `name: ${name}`];
  if (parent)      lines.push(`parent: ${parent}`);
  if (fingerprint) lines.push(`fingerprint: ${fingerprint}`);
  if (categories.length) lines.push(`categories: [${categories.join(', ')}]`);
  lines.push('---');
  lines.push('body');
  fs.writeFileSync(full, lines.join('\n'));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(full, t, t);
}

test('buildThreads follows parent chain and groups into threads', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tl-'));
  mkSnap(tmp, 'project_a1.md', { fingerprint: 'a', ageDays: 5 });
  mkSnap(tmp, 'project_a2.md', { fingerprint: 'b', parent: 'project_a1.md', ageDays: 4 });
  mkSnap(tmp, 'project_a3.md', { fingerprint: 'c', parent: 'project_a2.md', ageDays: 3 });
  mkSnap(tmp, 'project_b1.md', { fingerprint: 'd', ageDays: 2 });

  try {
    const threads = buildThreads(tmp);
    assert.equal(threads.length, 2, 'two threads');
    const long = threads.find(t => t.length === 3);
    assert.ok(long, 'one 3-long thread');
    assert.deepEqual(long.map(s => s.name), ['project_a1.md', 'project_a2.md', 'project_a3.md']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildThreads handles broken parent (missing file) gracefully', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tlb-'));
  mkSnap(tmp, 'project_x.md', { fingerprint: 'x', parent: 'missing.md', ageDays: 1 });
  try {
    const threads = buildThreads(tmp);
    assert.equal(threads.length, 1, 'still one thread');
    assert.equal(threads[0].length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/test/timeline.test.js`
Expected: FAIL — "Cannot find module '../timeline.js'"

- [ ] **Step 3: Implement timeline.js**

```javascript
// src/timeline.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { readSnapshotHead } = require('./retrieval.js');

function buildThreads(memoryDir) {
  if (!fs.existsSync(memoryDir)) return [];
  let names;
  try { names = fs.readdirSync(memoryDir); } catch { return []; }
  const byName = new Map();
  for (const name of names) {
    if (!name.startsWith('project_') || !name.endsWith('.md')) continue;
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const head = readSnapshotHead(full);
    if (!head) continue;
    byName.set(name, {
      name,
      path: full,
      mtime: stat.mtimeMs,
      parent: head.meta.parent || null,
      fingerprint: head.meta.fingerprint || null,
      categories: head.meta.categories || [],
    });
  }

  const childrenOf = new Map();
  const roots = [];
  for (const s of byName.values()) {
    if (s.parent && byName.has(s.parent)) {
      if (!childrenOf.has(s.parent)) childrenOf.set(s.parent, []);
      childrenOf.get(s.parent).push(s);
    } else {
      roots.push(s);
    }
  }

  const threads = [];
  for (const root of roots) {
    const chain = [];
    let cur = root;
    const seen = new Set();
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      chain.push(cur);
      const kids = (childrenOf.get(cur.name) || []).sort((a, b) => a.mtime - b.mtime);
      cur = kids[0] || null;
    }
    threads.push(chain);
  }
  threads.sort((a, b) => (b[b.length - 1].mtime) - (a[a.length - 1].mtime));
  return threads;
}

module.exports = { buildThreads };
```

- [ ] **Step 4: Add printTimeline in output.js**

Append to `src/output.js`:

```javascript
function printTimeline(threads) {
  console.log('');
  console.log(C.bold + `  ctx timeline — ${threads.length} thread(s)` + C.reset);
  console.log('');
  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const last = thread[thread.length - 1];
    console.log(C.cyan + `  ▸ thread #${i + 1} (${thread.length} snapshots, last: ${timeAgo(last.mtime)})` + C.reset);
    for (const snap of thread) {
      const cats = (snap.categories || []).join(', ') || '-';
      console.log(`    ${C.gray}${new Date(snap.mtime).toISOString().slice(0, 10)}${C.reset}  ${snap.name}  ${C.dim}[${cats}]${C.reset}`);
    }
    console.log('');
  }
}

module.exports.printTimeline = printTimeline;
```

- [ ] **Step 5: Wire runTimeline in cli.js**

Add before `runHook`:

```javascript
function runTimeline(_args, config) {
  stripColor();
  const cwd = process.cwd();
  const { buildThreads } = require('./timeline.js');
  const { printTimeline } = require('./output.js');
  const memoryDir = resolveMemoryDir(cwd, config);
  const threads = buildThreads(memoryDir);
  printTimeline(threads);
  return 0;
}
```

Dispatch case:

```javascript
    case 'timeline':
      return runTimeline(rest, config);
```

- [ ] **Step 6: Run tests**

Run: `node --test src/test/timeline.test.js`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/timeline.js src/test/timeline.test.js src/output.js src/cli.js
git commit -m "feat(timeline): parent-chain threaded snapshot history"
```

---

## Task 8: ctx diff — snapshot delta

**Files:**
- Create: `src/diff.js`
- Test: `src/test/diff.test.js`
- Modify: `src/output.js` (printDiff)
- Modify: `src/cli.js` (runDiff + dispatch)

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/diff.test.js
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { parseSnapshotFacts, diffSnapshots } = require('../diff.js');

function writeSnap(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `---\nname: ${name}\n---\n${body}`);
  return p;
}

test('parseSnapshotFacts extracts files, decisions, failed attempts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-df-'));
  const p = writeSnap(tmp, 'project_a.md', [
    '**Modified files (3):**',
    '- a.ts (/x/a.ts)',
    '- b.ts (/x/b.ts)',
    '- c.ts (/x/c.ts)',
    '',
    '**Decisions made:**',
    '- use stripe webhook idempotency',
    '- migrate to prisma',
    '',
    '**Failed attempts / open questions:**',
    '- tried raw body after json middleware',
    '',
  ].join('\n'));

  try {
    const facts = parseSnapshotFacts(p);
    assert.deepEqual(facts.files.sort(), ['a.ts', 'b.ts', 'c.ts']);
    assert.equal(facts.decisions.length, 2);
    assert.equal(facts.failedAttempts.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diffSnapshots returns added/removed/retained sets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-df2-'));
  const a = writeSnap(tmp, 'project_a.md', [
    '**Modified files (2):**',
    '- old.ts (/x/old.ts)',
    '- shared.ts (/x/shared.ts)',
    '**Decisions made:**',
    '- decision one',
  ].join('\n'));
  const b = writeSnap(tmp, 'project_b.md', [
    '**Modified files (2):**',
    '- shared.ts (/x/shared.ts)',
    '- new.ts (/x/new.ts)',
    '**Decisions made:**',
    '- decision one',
    '- decision two',
  ].join('\n'));

  try {
    const d = diffSnapshots(a, b);
    assert.deepEqual(d.files.added, ['new.ts']);
    assert.deepEqual(d.files.removed, ['old.ts']);
    assert.deepEqual(d.files.kept, ['shared.ts']);
    assert.equal(d.decisions.added.length, 1);
    assert.equal(d.decisions.removed.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test src/test/diff.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement diff.js**

```javascript
// src/diff.js
'use strict';

const fs   = require('fs');
const path = require('path');

function parseSnapshotFacts(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { files: [], decisions: [], failedAttempts: [] }; }
  const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');

  const files = [];
  const fileBlock = body.match(/\*\*Modified files[^*]*\*\*\s*\n([\s\S]*?)(?=\n\s*\n\*\*|$)/);
  if (fileBlock) {
    for (const line of fileBlock[1].split('\n')) {
      const m = line.match(/^- (\S+)/);
      if (m) files.push(m[1]);
    }
  }

  function pickList(label) {
    const re = new RegExp(`\\*\\*${label}[^*]*\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\n\\*\\*|$)`);
    const m = body.match(re);
    if (!m) return [];
    const out = [];
    for (const line of m[1].split('\n')) {
      const t = line.match(/^- (.+)/);
      if (t) out.push(t[1].trim());
    }
    return out;
  }

  return {
    files,
    decisions: pickList('Decisions made'),
    failedAttempts: pickList('Failed attempts / open questions'),
  };
}

function setDiff(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added:   b.filter(x => !sa.has(x)),
    removed: a.filter(x => !sb.has(x)),
    kept:    a.filter(x => sb.has(x)),
  };
}

function diffSnapshots(aPath, bPath) {
  const a = parseSnapshotFacts(aPath);
  const b = parseSnapshotFacts(bPath);
  return {
    a: path.basename(aPath),
    b: path.basename(bPath),
    files:          setDiff(a.files, b.files),
    decisions:      setDiff(a.decisions, b.decisions),
    failedAttempts: setDiff(a.failedAttempts, b.failedAttempts),
  };
}

module.exports = { parseSnapshotFacts, setDiff, diffSnapshots };
```

- [ ] **Step 4: printDiff in output.js**

Append:

```javascript
function printDiff(delta) {
  console.log('');
  console.log(C.bold + `  diff: ${delta.a}  →  ${delta.b}` + C.reset);
  console.log('');
  for (const [label, dd] of [['Files', delta.files], ['Decisions', delta.decisions], ['Failed attempts', delta.failedAttempts]]) {
    console.log(C.bold + `  ${label}:` + C.reset);
    if (dd.added.length)   for (const x of dd.added)   console.log(`    ${C.green}+ ${x}${C.reset}`);
    if (dd.removed.length) for (const x of dd.removed) console.log(`    ${C.red}- ${x}${C.reset}`);
    if (!dd.added.length && !dd.removed.length) console.log(C.gray + '    (no changes)' + C.reset);
    console.log('');
  }
}

module.exports.printDiff = printDiff;
```

- [ ] **Step 5: Wire runDiff in cli.js**

```javascript
function runDiff(args, config) {
  stripColor();
  if (args.length < 2) {
    console.error('❌ ctx diff <snapshot-a> <snapshot-b>');
    return 1;
  }
  const cwd = process.cwd();
  const memoryDir = resolveMemoryDir(cwd, config);
  const resolve = (n) => fs.existsSync(n) ? n : path.join(memoryDir, n);
  const aPath = resolve(args[0]);
  const bPath = resolve(args[1]);
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) {
    console.error(`❌ Not found: ${!fs.existsSync(aPath) ? aPath : bPath}`);
    return 1;
  }
  const { diffSnapshots } = require('./diff.js');
  const { printDiff }     = require('./output.js');
  printDiff(diffSnapshots(aPath, bPath));
  return 0;
}
```

Dispatch:

```javascript
    case 'diff':
      return runDiff(rest, config);
```

- [ ] **Step 6: Run tests**

Run: `node --test src/test/diff.test.js`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add src/diff.js src/test/diff.test.js src/output.js src/cli.js
git commit -m "feat(diff): snapshot delta (files, decisions, failed attempts)"
```

---

## Task 9: ctx stats — haftalık/aylık lokal analytics

**Files:**
- Create: `src/stats.js`
- Test: `src/test/stats.test.js`
- Modify: `src/output.js` (printStats)
- Modify: `src/cli.js` (runStats + dispatch)

- [ ] **Step 1: Write the failing test**

```javascript
// src/test/stats.test.js
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { aggregate } = require('../stats.js');

function mk(dir, name, { ageDays, categories = [], trigger = 'manual' }) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, [
    '---',
    `name: ${name}`,
    `trigger: ${trigger}`,
    `categories: [${categories.join(', ')}]`,
    '---',
    'body',
  ].join('\n'));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(full, t, t);
}

test('aggregate counts snapshots, triggers, categories in a window', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-st-'));
  mk(tmp, 'project_a.md', { ageDays: 2,  categories: ['api', 'auth'], trigger: 'commit' });
  mk(tmp, 'project_b.md', { ageDays: 4,  categories: ['api'],          trigger: 'stop:urgent' });
  mk(tmp, 'project_c.md', { ageDays: 20, categories: ['stripe'],       trigger: 'manual' });
  try {
    const s7  = aggregate(tmp, { rangeDays: 7 });
    assert.equal(s7.snapshots, 2);
    assert.deepEqual(Object.keys(s7.triggers).sort(), ['commit', 'stop:urgent']);
    assert.equal(s7.topCategories[0].name, 'api');

    const s30 = aggregate(tmp, { rangeDays: 30 });
    assert.equal(s30.snapshots, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify fails**

Run: `node --test src/test/stats.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement stats.js**

```javascript
// src/stats.js
'use strict';

const fs   = require('fs');
const path = require('path');
const { readSnapshotHead } = require('./retrieval.js');

function aggregate(memoryDir, { rangeDays = 7 } = {}) {
  if (!fs.existsSync(memoryDir)) return empty();
  let names;
  try { names = fs.readdirSync(memoryDir); } catch { return empty(); }
  const cutoff = Date.now() - rangeDays * 86_400_000;
  const triggers = {};
  const categoryCounts = {};
  let snapshots = 0;
  let totalMtime = 0;

  for (const name of names) {
    if (!name.startsWith('project_') || !name.endsWith('.md')) continue;
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile() || stat.mtimeMs < cutoff) continue;
    snapshots++;
    totalMtime += stat.mtimeMs;
    const head = readSnapshotHead(full);
    const trig = head?.meta?.trigger || 'unknown';
    triggers[trig] = (triggers[trig] || 0) + 1;
    for (const c of head?.meta?.categories || []) {
      categoryCounts[c] = (categoryCounts[c] || 0) + 1;
    }
  }

  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return {
    rangeDays,
    snapshots,
    triggers,
    topCategories,
    avgMtime: snapshots ? totalMtime / snapshots : null,
  };
}

function empty() {
  return { rangeDays: 0, snapshots: 0, triggers: {}, topCategories: [], avgMtime: null };
}

module.exports = { aggregate };
```

- [ ] **Step 4: printStats + runStats**

In `src/output.js`:

```javascript
function printStats(stats) {
  console.log('');
  console.log(C.bold + `  ctx stats — last ${stats.rangeDays} days` + C.reset);
  console.log('');
  console.log(`    Snapshots: ${C.green}${stats.snapshots}${C.reset}`);
  console.log('');
  console.log(C.dim + '  Triggers:' + C.reset);
  for (const [k, v] of Object.entries(stats.triggers)) {
    console.log(`    ${C.gray}${k.padEnd(20)}${C.reset} ${v}`);
  }
  console.log('');
  console.log(C.dim + '  Top categories:' + C.reset);
  if (!stats.topCategories.length) console.log(C.gray + '    (none)' + C.reset);
  for (const c of stats.topCategories) {
    console.log(`    ${C.gray}${c.name.padEnd(20)}${C.reset} ${c.count}`);
  }
  console.log('');
}
module.exports.printStats = printStats;
```

In `src/cli.js`:

```javascript
function runStats(args, config) {
  stripColor();
  let rangeDays = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--week') rangeDays = 7;
    else if (args[i] === '--month') rangeDays = 30;
    else if (args[i] === '--days' && args[i + 1]) { rangeDays = Number(args[i + 1]); i++; }
  }
  const cwd = process.cwd();
  const { aggregate } = require('./stats.js');
  const { printStats } = require('./output.js');
  const memoryDir = resolveMemoryDir(cwd, config);
  printStats(aggregate(memoryDir, { rangeDays }));
  return 0;
}
```

Dispatch:

```javascript
    case 'stats':
      return runStats(rest, config);
```

- [ ] **Step 5: Run tests**

Run: `node --test src/test/stats.test.js`
Expected: PASS (1 test)

- [ ] **Step 6: Commit**

```bash
git add src/stats.js src/test/stats.test.js src/output.js src/cli.js
git commit -m "feat(stats): snapshot/trigger/category aggregation"
```

---

## Task 10: UserPromptSubmit auto-retrieve hook

**Files:**
- Modify: `src/hooks.js::handleUserPromptSubmit` (extend)
- Modify: `config.default.json` (add auto_retrieve block)
- Test: `src/test/hooks.test.js` (extend)

- [ ] **Step 1: Add config defaults**

Modify `config.default.json`, replace `user_prompt_submit` block:

```json
"user_prompt_submit": {
  "warn_on": [],
  "auto_retrieve": {
    "enabled": true,
    "max_turns": 2,
    "min_score": 0.3,
    "scopes": ["project", "global"]
  }
}
```

- [ ] **Step 2: Write failing test**

Append to `src/test/hooks.test.js`:

```javascript
test('user-prompt-submit auto-retrieves past snapshot on first prompt', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-auto-'));
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const now = Date.now();
  const snapFile = path.join(memoryDir, 'project_stripe.md');
  fs.writeFileSync(snapFile, [
    '---',
    'name: stripe',
    'categories: [stripe, api]',
    'fingerprint: stripeaaaaaaaaaa',
    '---',
    'stripe webhook idempotency header',
  ].join('\n'));
  fs.utimesSync(snapFile, new Date(now - 86_400_000), new Date(now - 86_400_000));

  const cfg = configWithDirs({ memoryDir });
  cfg.hooks.user_prompt_submit = {
    warn_on: [],
    auto_retrieve: { enabled: true, max_turns: 2, min_score: 0.01, scopes: ['project'] },
  };

  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  pipeMock.runAnalyze = () => ({
    analysis: { userMessages: 1, messageCount: 1, filesModified: new Set(), decisions: [], failedAttempts: [], activeCategories: new Map(), lastNMessages: [] },
    decision: { metrics: { contextPct: 10, contextTokens: 1000 }, level: 'comfortable' },
    strategy: { compactPrompt: '/compact x' },
    session: { path: '/tmp/fake', entries: [] },
    entries: [],
    modelId: 'x', sessionId: 'x', limits: {},
  });

  try {
    const res = handleUserPromptSubmit({ cwd: '/tmp/auto-x', session_id: 'x', prompt: 'stripe webhook ekleyelim' }, cfg);
    assert.ok(res.output, 'output produced');
    assert.ok(String(res.output).includes('project_stripe.md'), 'matched snapshot referenced');
  } finally {
    pipeMock.runAnalyze = original;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test — verify fails**

Run: `node --test src/test/hooks.test.js`
Expected: FAIL — output lacks snapshot reference (old handler doesn't do retrieval).

- [ ] **Step 4: Extend handleUserPromptSubmit**

Replace the function in `src/hooks.js`:

```javascript
function handleUserPromptSubmit(input, config) {
  const cwd = input.cwd || process.cwd();
  const prompt = (input.prompt || '').trim();
  const warnOn = config?.hooks?.user_prompt_submit?.warn_on || [];
  const auto = config?.hooks?.user_prompt_submit?.auto_retrieve || {};

  let pipe;
  try { pipe = pipeline.runAnalyze({ cwd, sessionId: input.session_id, config }); } catch { pipe = null; }

  // warn
  if (warnOn.length && pipe && warnOn.includes(pipe.decision.level)) {
    const msg = `[ctx] context ${pipe.decision.metrics.contextPct}% of quality ceiling — consider /compact`;
    return { output: msg, exitCode: 0 };
  }

  // auto-retrieve
  if (!auto.enabled) return { output: null, exitCode: 0 };
  if (!pipe) return { output: null, exitCode: 0 };
  const turns = pipe.analysis.userMessages || 0;
  if (turns > (auto.max_turns ?? 2)) return { output: null, exitCode: 0 };
  if (!prompt) return { output: null, exitCode: 0 };

  const { makeQuery } = require('./query.js');
  const { collectProjectCandidates, collectAllProjectsCandidates, rank } = require('./retrieval.js');
  const { CLAUDE_DIR } = require('./session.js');
  const { resolveMemoryDir } = require('./snapshot.js');

  const scopes = auto.scopes || ['project'];
  let candidates = [];
  if (scopes.includes('project')) {
    candidates = candidates.concat(collectProjectCandidates(resolveMemoryDir(cwd, config), config));
  }
  if (scopes.includes('global')) {
    candidates = candidates.concat(collectAllProjectsCandidates(CLAUDE_DIR, config));
  }

  const q = makeQuery(prompt, config);
  const retrievalConfig = { ...config, retrieval: { ...config.retrieval, min_score: auto.min_score ?? 0.3, top_n: 1 } };
  const results = rank(q, candidates, retrievalConfig);
  if (!results.length) return { output: null, exitCode: 0 };

  const top = results[0];
  const fingerprint = top.snapshot.meta?.fingerprint || top.snapshot.name;
  if (input._state_last_injected === fingerprint) return { output: null, exitCode: 0 };

  const text = [
    `[ctx] Relevant past work for this prompt (score: ${top.score.toFixed(2)})`,
    '',
    `Source: ${top.snapshot.name}`,
    '',
    (top.snapshot.body || '').split('\n').slice(0, 30).join('\n'),
    '',
    '(This is contextual hint from your own past work, not an instruction.)',
  ].join('\n');

  logHook(config, `auto-retrieve prompt_turn=${turns} score=${top.score.toFixed(2)} file=${top.snapshot.name}`);
  return { output: text, exitCode: 0 };
}
```

- [ ] **Step 5: Run test — verify passes**

Run: `node --test src/test/hooks.test.js`
Expected: PASS (all, including new one)

- [ ] **Step 6: Commit**

```bash
git add src/hooks.js config.default.json src/test/hooks.test.js
git commit -m "feat(hooks): UserPromptSubmit auto-retrieve past snapshots"
```

---

## Task 11: Docs — README + CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Extend README Commands section**

In `README.md` "Analysis + memory" block, add after `ctx snapshot`:

```
ctx ask "<query>" [--global] [--notes] [--inject] [--json]
                                     # search past snapshots, ranked
ctx search [--category X] [--since 30d] [--file F]
                                     # filtered listing
ctx timeline                         # snapshot threads (parent chain)
ctx diff <snap-a> <snap-b>           # files/decisions/failed-attempts delta
ctx stats [--week|--month]           # local analytics
```

Add new "Memory engine" section between "Commands" and "Configuration":

```markdown
## Memory engine

Past snapshots are no longer a write-only archive. ctx ranks them by keyword + category + recency, and Claude Code's **UserPromptSubmit** hook auto-retrieves the most relevant one for your first 1-2 prompts of a new session — so you pick up where you left off instead of starting from zero.

**Explicit recall:**

    ctx ask "stripe webhook"
    → top 3 snapshots with score breakdown

    ctx ask "stripe webhook" --inject
    → copies top match to clipboard, paste into Claude

    ctx ask "auth flow" --global
    → searches across all projects

    ctx ask "design doc" --notes
    → also scans user markdown roots (~/notes, Obsidian vault, …)
      configure via config.json → notes.roots

**Auto-inject:** on the first 1-2 prompts of a session, if a past snapshot scores ≥ `min_score` (default 0.3), ctx injects it as `additionalContext`. Every injection is logged to `~/.config/ctx/hooks.log` — fully transparent. Disable via `hooks.user_prompt_submit.auto_retrieve.enabled: false`.

**Timeline + diff:** `ctx timeline` threads snapshots by `parent:` pointer so you see a project's evolution. `ctx diff <a> <b>` shows what files/decisions/failed attempts changed between two snapshots.
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, replace the architecture diagram block with:

```
bin/ctx → src/cli.js
           │
           ├── session.js       read ~/.claude/projects/<encoded-cwd>/*.jsonl → entries[]
           ├── analyzer.js      entries → stats
           ├── models.js        detectModel + getLimits
           ├── decision.js      stats + limits → level/action/metrics
           ├── strategy.js      analysis + decision → /compact prompt
           ├── pipeline.js      runAnalyze({cwd|sessionPath|sessionId|entries, config})
           ├── snapshot.js      markdown + frontmatter (parent, categories, fingerprint, trigger)
           ├── query.js         query → {tokens, nonStop, categories}  ← memory engine
           ├── retrieval.js     collect + score + rank snapshots       ← memory engine
           ├── notes.js         user markdown roots walk               ← memory engine
           ├── timeline.js      parent-chain traversal                 ← memory engine
           ├── diff.js          snapshot delta                         ← memory engine
           ├── stats.js         aggregation                            ← memory engine
           ├── backup.js        stream gzip JSONL + rotate + restore
           ├── prune.js         memory dir hygiene
           ├── hooks.js         Claude Code hook handlers (incl. auto-retrieve)
           ├── hooks_install.js settings.json merge/unmerge
           ├── watcher.js       foreground live loop
           ├── daemon.js        background loop
           ├── output.js        ANSI formatting + osascript notifier
           └── config.js        config.default.json ← deepMerge ← ~/.config/ctx/config.json
```

Add to "Key boundaries":

```
- **Memory engine modules (`query.js`, `retrieval.js`, `notes.js`, `timeline.js`, `diff.js`, `stats.js`) are pure functions with zero external state.** They read from disk (snapshot markdown, notes roots) and return plain data. Never write, never call hooks, never touch the daemon. This makes them trivially testable and safe to compose.
- **`retrieval.readSnapshotHead` is the only canonical frontmatter parser.** If you need to read a snapshot's metadata from another module, import this function — don't re-implement parsing.
- **Auto-retrieval respects user privacy boundaries:** default scopes are `["project", "global"]` — memory dirs only. `notes.roots` are never auto-injected; they require explicit `--notes` flag on `ctx ask`.
```

- [ ] **Step 3: Run full test suite**

Run: `node --test src/test/*.test.js`
Expected: PASS (all tests from prior tasks + existing 56)

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: memory engine overview + module boundaries"
```

---

## Final verification

- [ ] **Step 1: Full test suite green**

Run: `node --test src/test/*.test.js`
Expected: PASS for all tests (tahmini ~80 test).

- [ ] **Step 2: CLI smoke on demo fixture**

Run:
```bash
./bin/ctx ask "stripe webhook" --json
./bin/ctx timeline
./bin/ctx stats --week
```
Expected: Graceful output (ya sonuç ya "No matches" — proje fresh olduğu için).

- [ ] **Step 3: Sandbox e2e for auto-retrieve**

Run:
```bash
SANDBOX=$(mktemp -d)
mkdir -p $SANDBOX/.claude/projects/-tmp-demo/memory
cat > $SANDBOX/.claude/projects/-tmp-demo/memory/project_past.md <<'EOF'
---
name: past
categories: [stripe, api]
fingerprint: pastpastpastpast
---
stripe webhook body with idempotency
EOF
echo '{"cwd":"/tmp/demo","session_id":"x","prompt":"stripe webhook ekleyelim"}' | \
  HOME=$SANDBOX ./bin/ctx hook user-prompt-submit
rm -rf $SANDBOX
```
Expected: stdout contains `[ctx] Relevant past work` + references `project_past.md`.

- [ ] **Step 4: Final commit + clean git status**

Run: `git status`
Expected: clean working tree.

---

## Self-review — spec coverage

Spec sections → task mapping:

| Spec section | Task(s) |
|---|---|
| Komut yüzeyi: `ctx ask` + bayraklar | Task 3, 4, 5 |
| `ctx search` (filter flags) | **Gap** — not implemented in v1; `ctx ask` + `ctx timeline` + `ctx stats` cover 80% of use cases. Adding as optional v2 feature, flagged below. |
| `ctx timeline` | Task 7 |
| `ctx diff` | Task 8 |
| `ctx stats` | Task 9 |
| Auto-retrieve | Task 10 |
| Mimari (6 yeni modül) | Tasks 1, 2, 5, 7, 8, 9 (one module per task) |
| Veri katmanı (3 scope) | Tasks 3, 4, 5 |
| Snapshot chain | Task 6 |
| Config şeması | Tasks 2, 5, 10 |
| Skorlama formülü | Task 2 |
| Şeffaflık (skor breakdown) | Task 3 (`printRetrieval`) |
| Güvenlik (symlink, size cap, .md only) | Task 5 |
| Hata durumları tablosu | Ödeniyor dosya-dosya: retrieval catch + hooks silent + walk skip |
| Test planı | Her task'ın Step 1'i |

**v2 (bu planın dışında):**
- `ctx search` (filter flags — `--category`, `--since`, `--file`): başlangıçta `ctx ask` + `ctx timeline` yetiyor. Gerçek kullanımda talep gelirse 1 saatlik ek task.
- Disk-based TF-IDF index: YAGNI.
- Cross-device sync: YAGNI.

## Self-review — placeholder scan

No "TBD", "TODO", "similar to Task N" found. Every step has exact code or exact command.

## Self-review — type consistency

- `readSnapshotHead` defined in Task 2, reused in Tasks 7 (timeline), 9 (stats). Export signature consistent.
- `makeQuery` in Task 1, called same way in Tasks 3 (ask), 10 (hook).
- `rank` signature `rank(query, candidates, config)` consistent across Tasks 2, 3, 4, 10.
- `collectProjectCandidates` / `collectAllProjectsCandidates` / `collectNotesCandidates` — all return same candidate shape `{ name, path, mtime, size, categories, body, length, meta }`.
- Config key `retrieval.min_score` / `hooks.user_prompt_submit.auto_retrieve.min_score` — same unit (0..1), used independently for manual vs auto paths. Consistent.

No inconsistencies.
