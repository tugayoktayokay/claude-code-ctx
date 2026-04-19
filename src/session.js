'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

function encodeCwd(cwd) {
  return '-' + cwd.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-');
}

function projectDirFor(cwd) {
  return path.join(CLAUDE_DIR, encodeCwd(cwd));
}

function parseJSONL(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => typeof c === 'string' ? c : (c.text || '')).join(' ');
  }
  return '';
}

function scanJSONL(dir, depth = 0, acc = []) {
  if (depth > 3) return acc;
  let names;
  try { names = fs.readdirSync(dir); } catch { return acc; }
  for (const name of names) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      scanJSONL(full, depth + 1, acc);
    } else if (name.endsWith('.jsonl')) {
      acc.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  return acc;
}

function findLatestSession(cwd) {
  const projDir = projectDirFor(cwd);
  const sessions = fs.existsSync(projDir)
    ? scanJSONL(projDir)
    : scanJSONL(CLAUDE_DIR);
  if (!sessions.length) return null;
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions[0];
}

function findSessionById(cwd, sessionId) {
  if (!sessionId) return null;
  const projDir = projectDirFor(cwd);
  const roots = fs.existsSync(projDir) ? [projDir] : [CLAUDE_DIR];
  for (const root of roots) {
    const sessions = scanJSONL(root);
    for (const s of sessions) {
      const base = path.basename(s.path, '.jsonl');
      if (base === sessionId || base.startsWith(sessionId)) return s;
    }
  }
  return null;
}

function listAllSessions() {
  if (!fs.existsSync(CLAUDE_DIR)) return [];
  const sessions = scanJSONL(CLAUDE_DIR);
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

module.exports = {
  CLAUDE_DIR,
  encodeCwd,
  projectDirFor,
  parseJSONL,
  extractText,
  findLatestSession,
  findSessionById,
  listAllSessions,
};
