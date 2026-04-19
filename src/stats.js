'use strict';

const fs   = require('fs');
const path = require('path');
const { readSnapshotHead } = require('./retrieval.js');

function aggregate(memoryDir, { rangeDays = 7 } = {}) {
  if (!fs.existsSync(memoryDir)) return empty(rangeDays);
  let names;
  try { names = fs.readdirSync(memoryDir); } catch { return empty(rangeDays); }
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

function empty(rangeDays) {
  return { rangeDays, snapshots: 0, triggers: {}, topCategories: [], avgMtime: null };
}

module.exports = { aggregate };
