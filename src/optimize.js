'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { listAllSessions, parseJSONL } = require('./session.js');

function safeRead(p, max = 1024 * 1024) {
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return null;
    if (stat.size > max) return fs.readFileSync(p, 'utf8').slice(0, max);
    return fs.readFileSync(p, 'utf8');
  } catch { return null; }
}

function splitSections(md) {
  if (!md) return [];
  const lines = md.split('\n');
  const out = [];
  let cur = { heading: '(intro)', start: 0, body: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.+)$/);
    if (m) {
      if (cur.body.length) {
        out.push({ heading: cur.heading, bytes: cur.body.join('\n').length });
      }
      cur = { heading: m[2].trim(), body: [line] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.length) out.push({ heading: cur.heading, bytes: cur.body.join('\n').length });
  return out;
}

function scanClaudeMd(cwd) {
  const paths = [
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(cwd, 'CLAUDE.md'),
  ];
  const out = [];
  for (const p of paths) {
    const raw = safeRead(p);
    if (raw == null) continue;
    const sections = splitSections(raw)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);
    out.push({ path: p, bytes: raw.length, topSections: sections });
  }
  return out;
}

function scanSkills() {
  const roots = [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.claude', 'plugins'),
  ];
  const out = [];
  function walk(root, depth = 0) {
    if (depth > 6) return;
    let names;
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      const full = path.join(root, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) { walk(full, depth + 1); continue; }
      if (name === 'SKILL.md' && stat.isFile()) {
        const raw = safeRead(full, 64 * 1024) || '';
        const nameLine = raw.match(/^name:\s*(.+)$/m);
        const descLine = raw.match(/^description:\s*(.+)$/m);
        out.push({
          path: full,
          name: nameLine ? nameLine[1].trim() : path.basename(path.dirname(full)),
          description: descLine ? descLine[1].trim().slice(0, 120) : '',
          bytes: stat.size,
        });
      }
    }
  }
  for (const r of roots) walk(r);
  return out.sort((a, b) => b.bytes - a.bytes);
}

function aggregateToolUsage(sessions, { sinceMs = 0 } = {}) {
  const counts = {};
  let scanned = 0;
  for (const s of sessions) {
    if (sinceMs && s.mtime < sinceMs) continue;
    let entries;
    try { entries = parseJSONL(s.path); } catch { continue; }
    scanned++;
    for (const e of entries) {
      const content = e?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name) {
          counts[block.name] = (counts[block.name] || 0) + 1;
        }
      }
    }
  }
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  return { ranked, scanned };
}

function aggregateSkillUsage(sessions, { sinceMs = 0 } = {}) {
  const counts = {};
  let scanned = 0;
  for (const s of sessions) {
    if (sinceMs && s.mtime < sinceMs) continue;
    let entries;
    try { entries = parseJSONL(s.path); } catch { continue; }
    scanned++;
    for (const e of entries) {
      const content = e?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Skill') {
          const skill = block.input?.skill || '(unknown)';
          counts[skill] = (counts[skill] || 0) + 1;
        }
      }
    }
  }
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  return { ranked, scanned };
}

function topHeavyOutputs(analysis, limit = 10) {
  const items = Array.isArray(analysis?.largeOutputs) ? analysis.largeOutputs : [];
  return items.slice().sort((a, b) => b.size - a.size).slice(0, limit);
}

function listSessionsInRange(days) {
  const all = listAllSessions();
  if (!days) return all;
  const since = Date.now() - days * 86_400_000;
  return all.filter(s => s.mtime >= since);
}

module.exports = {
  safeRead,
  splitSections,
  scanClaudeMd,
  scanSkills,
  aggregateToolUsage,
  aggregateSkillUsage,
  topHeavyOutputs,
  listSessionsInRange,
};
