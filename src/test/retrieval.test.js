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

test('stemLite strips common english + turkish suffixes', () => {
  const { stemLite } = require('../retrieval.js');
  assert.equal(stemLite('webhooks'), 'webhook');
  assert.equal(stemLite('running'), 'runn');
  assert.equal(stemLite('stripe'), 'stripe');
  assert.equal(stemLite('kararların'), 'karar');
});

test('fuzzyMatch catches typos within edit distance 2', () => {
  const { fuzzyMatch } = require('../retrieval.js');
  const vocab = ['webhook', 'kubernetes', 'authentication', 'stripe'];
  assert.equal(fuzzyMatch('wehbook', vocab).term, 'webhook');
  assert.equal(fuzzyMatch('kuberntes', vocab).term, 'kubernetes');
  assert.equal(fuzzyMatch('xyz', vocab), null);
});

test('bm25Score rewards rare terms more than common terms', () => {
  const { bm25Score, buildCorpusStats, tokenizeBody } = require('../retrieval.js');
  const candidates = [
    { body: 'stripe webhook idempotency', length: 30, _terms: tokenizeBody('stripe webhook idempotency') },
    { body: 'generic the and file',       length: 30, _terms: tokenizeBody('generic the and file') },
    { body: 'another generic the file',   length: 30, _terms: tokenizeBody('another generic the file') },
    { body: 'stripe subscription webhook',length: 30, _terms: tokenizeBody('stripe subscription webhook') },
  ];
  const corpus = buildCorpusStats(candidates);
  const rare   = bm25Score(['idempotency'], candidates[0], corpus);
  const common = bm25Score(['generic'],     candidates[1], corpus);
  assert.ok(rare > common, `rare(${rare}) should beat common(${common})`);
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

const { collectAllProjectsCandidates } = require('../retrieval.js');
const { loadCache, saveCache, syncCache, tokenizeBody } = require('../retrieval.js');

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

  const mutated2 = syncCache(cache, candidates);
  assert.equal(mutated2, false, 'unchanged sync does not mutate');

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
