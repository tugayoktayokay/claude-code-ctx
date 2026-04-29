'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { CLAUDE_DIR, projectDirFor } = require('./session.js');
const { rewriteIndex } = require('./snapshot.js');

function parseDuration(str) {
  if (typeof str === 'number') return str;
  if (!str) return null;
  const m = String(str).trim().match(/^(\d+)\s*([smhdw]?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'd').toLowerCase();
  const ms = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[unit];
  return n * ms;
}

function listProjectMemoryDirs() {
  if (!fs.existsSync(CLAUDE_DIR)) return [];
  let names;
  try { names = fs.readdirSync(CLAUDE_DIR); } catch { return []; }
  const dirs = [];
  for (const name of names) {
    const memDir = path.join(CLAUDE_DIR, name, 'memory');
    try {
      if (fs.statSync(memDir).isDirectory()) dirs.push(memDir);
    } catch {}
  }
  return dirs;
}

function planPrune(memoryDir, opts = {}) {
  const plan = {
    memoryDir,
    toRemove: [],
    toKeep: [],
    indexPath: path.join(memoryDir, 'MEMORY.md'),
    exists: fs.existsSync(memoryDir),
  };
  if (!plan.exists) return plan;

  let names;
  try { names = fs.readdirSync(memoryDir); } catch { return plan; }

  const files = [];
  for (const name of names) {
    if (!name.startsWith('project_') || !name.endsWith('.md')) continue;
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    files.push({ name, path: full, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const now = Date.now();
  const olderThanMs = opts.olderThanMs ?? null;
  const keepLast    = opts.keepLast ?? null;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const age = now - f.mtime;
    const tooOld    = olderThanMs != null && age > olderThanMs;
    const overQuota = keepLast != null && i >= keepLast;
    const remove    = tooOld || overQuota;
    const entry     = { ...f, age, reasons: [] };
    if (tooOld)    entry.reasons.push('older-than');
    if (overQuota) entry.reasons.push('over-keep-last');
    (remove ? plan.toRemove : plan.toKeep).push(entry);
  }
  return plan;
}

function applyPrune(plan) {
  if (!plan.exists || !plan.toRemove.length) {
    return { removedFiles: 0, indexRemoved: 0 };
  }
  const removedNames = [];
  let removedFiles = 0;
  for (const item of plan.toRemove) {
    try { fs.unlinkSync(item.path); removedFiles++; removedNames.push(item.name); } catch {}
  }
  let indexRemoved = 0;
  if (removedNames.length) {
    const res = rewriteIndex(plan.indexPath, removedNames);
    indexRemoved = res.removed;
  }
  return { removedFiles, indexRemoved, removedNames };
}

function planFromOpts(memoryDir, opts) {
  const olderThanMs = opts.olderThan ? parseDuration(opts.olderThan) : null;
  const keepLast    = opts.keepLast != null ? Number(opts.keepLast) : null;
  return planPrune(memoryDir, { olderThanMs, keepLast });
}

function pruneWorkingMemory(opts = {}) {
  const wm = require('./working_memory.js');
  return wm.gcOldSessions(opts);
}

module.exports = {
  parseDuration,
  listProjectMemoryDirs,
  planPrune,
  applyPrune,
  planFromOpts,
  pruneWorkingMemory,
};
