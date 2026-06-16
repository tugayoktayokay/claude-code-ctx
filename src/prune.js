'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { CLAUDE_DIR, projectDirFor } = require('./session.js');
const { rewriteIndex } = require('./snapshot.js');

const NOISY_SNAPSHOT_PATTERNS = [
  /\bbase_directory_for_this_skill\b/i,
  /\bbase directory for this skill\b/i,
  /<system-reminder>/i,
  /\bcaveman\b.*\bhook\b/i,
  /CAVEMAN MODE ACTIVE/i,
];

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

function frontmatterField(markdown, field) {
  const re = new RegExp(`^${field}:\\s*(.*)$`, 'mi');
  const m = String(markdown || '').match(re);
  return m ? m[1].trim() : '';
}

function lastTaskLine(markdown) {
  const m = String(markdown || '').match(/^\*\*Last task:\*\*\s*"?(.+?)"?\s*$/mi);
  return m ? m[1].trim() : '';
}

// A snapshot's body carries real work signal if it lists modified files or
// real source-file paths. Used to spare a meta-snapshot whose intent merely
// quotes a noise trigger (e.g. a snapshot about the noise-filtering work itself).
function hasRealSignal(markdown) {
  const m = String(markdown || '').match(/\*\*Modified files \((\d+)\)/i);
  if (m && Number(m[1]) > 0) return true;
  if (/^[-*]\s+\S+\.(?:js|jsx|ts|tsx|json|md|py|go|rs|css|html|sql|ya?ml)\b/mi.test(markdown)) return true;
  return false;
}

function isNoisySnapshotFile(file) {
  // Identity-level noise: the filename slug itself is injected text → always junk.
  if (NOISY_SNAPSHOT_PATTERNS.some(re => re.test(file.name))) return true;
  let markdown = '';
  try { markdown = fs.readFileSync(file.path, 'utf8'); } catch { return false; }

  const intentFields = [
    frontmatterField(markdown, 'name'),
    frontmatterField(markdown, 'description'),
    lastTaskLine(markdown),
  ].join('\n');

  if (!NOISY_SNAPSHOT_PATTERNS.some(re => re.test(intentFields))) return false;
  // Intent quotes noise — but spare it if the body documents real work.
  return !hasRealSignal(markdown);
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
  const pruneNoisy  = opts.pruneNoisy === true;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const age = now - f.mtime;
    const tooOld    = olderThanMs != null && age > olderThanMs;
    const overQuota = keepLast != null && i >= keepLast;
    const noisy     = pruneNoisy && isNoisySnapshotFile(f);
    const remove    = tooOld || overQuota || noisy;
    const entry     = { ...f, age, reasons: [] };
    if (tooOld)    entry.reasons.push('older-than');
    if (overQuota) entry.reasons.push('over-keep-last');
    if (noisy)     entry.reasons.push('noisy-snapshot');
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
  const pruneNoisy  = opts.pruneNoisy === true;
  return planPrune(memoryDir, { olderThanMs, keepLast, pruneNoisy });
}

function pruneWorkingMemory(opts = {}) {
  const wm = require('./working_memory.js');
  return wm.gcOldSessions(opts);
}

// Retention cap: keep the newest `snapshot.max_keep` snapshots (plus drop any
// noisy ones), removing the overflow. Called from the Stop hook after a
// snapshot is written. No-op unless max_keep is a positive number — so the
// default (unset) never surprise-deletes real snapshots.
function retentionPrune(memoryDir, config = {}) {
  const maxKeep = Number(config?.snapshot?.max_keep);
  if (!(maxKeep > 0)) return { skipped: true, removed: 0 };
  const plan = planPrune(memoryDir, {
    keepLast: maxKeep,
    pruneNoisy: config?.prune?.noisy_snapshots !== false,
  });
  if (!plan.toRemove.length) return { skipped: false, removed: 0, kept: plan.toKeep.length };
  const res = applyPrune(plan);
  return { skipped: false, removed: res.removedFiles, indexRemoved: res.indexRemoved, kept: plan.toKeep.length };
}

module.exports = {
  parseDuration,
  listProjectMemoryDirs,
  planPrune,
  applyPrune,
  planFromOpts,
  pruneWorkingMemory,
  isNoisySnapshotFile,
  retentionPrune,
};
