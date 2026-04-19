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

function stemLite(word) {
  if (!word || word.length < 4) return word;
  const suffixes = ['ing', 'ed', 'ies', 'es', 's', 'ly', 'er', 'est', 'lerin', 'ların', 'ları', 'leri', 'lar', 'ler', 'nin', 'nın', 'un', 'ün'];
  for (const suf of suffixes) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

function tokenizeBody(body) {
  if (!body) return [];
  return body
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1 && t.length < 40)
    .map(stemLite);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 2) return 99;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function fuzzyMatch(term, vocabulary, maxDist = 2) {
  if (!term || term.length < 4) return null;
  let best = null;
  let bestDist = maxDist + 1;
  for (const v of vocabulary) {
    if (Math.abs(v.length - term.length) > maxDist) continue;
    const d = levenshtein(term, v);
    if (d < bestDist) {
      bestDist = d;
      best = v;
      if (d === 1) break;
    }
  }
  return bestDist <= maxDist ? { term: best, dist: bestDist } : null;
}

function buildCorpusStats(candidates) {
  const N = candidates.length || 1;
  const df = new Map();
  let totalLen = 0;
  for (const c of candidates) {
    if (!c._terms) c._terms = tokenizeBody(c.body);
    totalLen += c._terms.length;
    const unique = new Set(c._terms);
    for (const term of unique) df.set(term, (df.get(term) || 0) + 1);
  }
  const avgDL = totalLen / N || 1;
  const _vocab = [...df.keys()];
  return { N, df, avgDL, _vocab };
}

function bm25Score(queryTerms, snap, corpus, { k1 = 1.5, b = 0.75, enableFuzzy = true } = {}) {
  if (!queryTerms.length) return 0;
  if (!snap._terms) snap._terms = tokenizeBody(snap.body);
  const tf = new Map();
  for (const t of snap._terms) tf.set(t, (tf.get(t) || 0) + 1);
  const dl = snap._terms.length || 1;

  let score = 0;
  for (let q of queryTerms) {
    q = stemLite(q);
    let f = tf.get(q) || 0;
    let fuzzyPenalty = 1;
    if (!f && enableFuzzy && corpus._vocab) {
      const fm = fuzzyMatch(q, corpus._vocab);
      if (fm) {
        f = tf.get(fm.term) || 0;
        fuzzyPenalty = fm.dist === 1 ? 0.7 : 0.45;
      }
    }
    if (!f) continue;
    const n = corpus.df.get(q) || corpus.df.get(queryTerms[0]) || 0;
    const idf = Math.log(1 + (corpus.N - n + 0.5) / (n + 0.5));
    const numerator = f * (k1 + 1);
    const denominator = f + k1 * (1 - b + b * (dl / corpus.avgDL));
    score += fuzzyPenalty * idf * (numerator / denominator);
  }
  return score;
}

function scoreSnapshot(query, snap, config, corpus) {
  const weights = config?.retrieval?.weights || { category: 0.4, bm25: 0.4, recency: 0.2 };
  const halfLife = config?.retrieval?.recency_half_life_days || 90;

  const qCats = new Set(query.categories);
  const sCats = new Set(snap.categories || []);
  let inter = 0;
  for (const c of qCats) if (sCats.has(c)) inter++;
  const categoryScore = qCats.size === 0 ? 0 : inter / qCats.size;

  let bm25 = 0;
  if (corpus && query.nonStop.length) {
    bm25 = bm25Score(query.nonStop, snap, corpus);
    bm25 = bm25 / (bm25 + 5);
  } else if (query.nonStop.length) {
    const lower = (snap.body || '').toLowerCase();
    let total = 0;
    for (const term of query.nonStop) {
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const matches = lower.match(re);
      if (matches) total += matches.length;
    }
    bm25 = Math.min(total / Math.sqrt(Math.max(snap.length, 1)), 1.0);
  }

  const days = Math.max(0, (Date.now() - (snap.mtime || Date.now())) / 86_400_000);
  const recencyScore = Math.pow(2, -days / halfLife);

  const keywordWeight = weights.bm25 ?? weights.keyword ?? 0.3;
  const total = (weights.category ?? 0.4) * categoryScore
              + keywordWeight * bm25
              + (weights.recency ?? 0.2) * recencyScore;

  return {
    total,
    breakdown: { category: categoryScore, keyword: bm25, recency: recencyScore },
  };
}

function rank(query, candidates, config) {
  const minScore = config?.retrieval?.min_score ?? 0.15;
  const topN     = config?.retrieval?.top_n     ?? 3;
  const corpus   = candidates.length ? buildCorpusStats(candidates) : null;
  const scored = [];
  for (const c of candidates) {
    const s = scoreSnapshot(query, c, config, corpus);
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
  bm25Score,
  buildCorpusStats,
  tokenizeBody,
  stemLite,
  levenshtein,
  fuzzyMatch,
  rank,
};
