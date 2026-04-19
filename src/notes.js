'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

function expandRoots(roots) {
  return (roots || []).map(r => {
    if (!r) return null;
    if (r.startsWith('~')) return path.join(os.homedir(), r.slice(1));
    return path.resolve(r);
  }).filter(Boolean);
}

function walkMarkdown(root, opts) {
  const exclude = new Set(opts.exclude || []);
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const followSymlinks = !!opts.followSymlinks;
  const out = [];
  const visited = new Set();

  function walk(dir) {
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);

    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (exclude.has(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = followSymlinks ? fs.statSync(full) : fs.lstatSync(full);
      } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile()) continue;
      if (!name.endsWith('.md')) continue;
      if (stat.size > maxBytes) continue;
      out.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  try {
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) walk(root);
  } catch {}
  return out;
}

function collectNotesCandidates(roots, config) {
  const notes = config?.notes || {};
  const exclude = notes.exclude || [];
  const maxBytes = (notes.max_file_kb || 512) * 1024;
  const followSymlinks = !!notes.follow_symlinks;
  const expanded = expandRoots(roots);
  const out = [];
  for (const r of expanded) {
    const items = walkMarkdown(r, { exclude, maxBytes, followSymlinks });
    for (const i of items) {
      let body = '';
      try { body = fs.readFileSync(i.path, 'utf8'); } catch {}
      out.push({
        name: path.basename(i.path),
        path: i.path,
        mtime: i.mtime,
        size: i.size,
        categories: [],
        body,
        length: body.length || 1,
        meta: { source: 'notes' },
      });
    }
  }
  return out;
}

module.exports = { expandRoots, walkMarkdown, collectNotesCandidates };
