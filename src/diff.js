'use strict';

const fs   = require('fs');
const path = require('path');

function parseSnapshotFacts(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { files: [], decisions: [], failedAttempts: [] }; }
  const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');

  function pickList(label) {
    const re = new RegExp(`\\*\\*${label}[^*]*\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\n|$)`);
    const m = body.match(re);
    if (!m) return [];
    const out = [];
    for (const line of m[1].split('\n')) {
      const t = line.match(/^- (.+)/);
      if (t) out.push(t[1].trim());
    }
    return out;
  }

  const fileLines = pickList('Modified files');
  const files = fileLines.map(l => {
    const m = l.match(/^(\S+)/);
    return m ? m[1] : l;
  });

  return {
    files,
    decisions:      pickList('Decisions made'),
    failedAttempts: pickList('Failed attempts / open questions'),
  };
}

function setDiff(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added:   b.filter(x => !sa.has(x)),
    removed: a.filter(x => !sb.has(x)),
    kept:    a.filter(x => sb.has(x)),
  };
}

function diffSnapshots(aPath, bPath) {
  const a = parseSnapshotFacts(aPath);
  const b = parseSnapshotFacts(bPath);
  return {
    a: path.basename(aPath),
    b: path.basename(bPath),
    files:          setDiff(a.files, b.files),
    decisions:      setDiff(a.decisions, b.decisions),
    failedAttempts: setDiff(a.failedAttempts, b.failedAttempts),
  };
}

module.exports = { parseSnapshotFacts, setDiff, diffSnapshots };
