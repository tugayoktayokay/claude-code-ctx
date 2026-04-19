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
