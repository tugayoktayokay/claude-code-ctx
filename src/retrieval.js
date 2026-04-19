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
      const tokens = head.body.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      categories = categorize(tokens, config?.categories || {});
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

module.exports = {
  readSnapshotHead,
  collectProjectCandidates,
  collectAllProjectsCandidates,
  scoreSnapshot,
  rank,
};
