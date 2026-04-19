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
