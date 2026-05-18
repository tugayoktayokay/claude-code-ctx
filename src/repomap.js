'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'coverage', 'vendor']);
const EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|css|scss|html|md)$/;

function walk(root, out = [], depth = 0) {
  if (depth > 6 || out.length > 500) return out;
  let names;
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(root, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out, depth + 1);
    else if (st.isFile() && st.size <= 256 * 1024 && EXT_RE.test(name)) out.push(full);
  }
  return out;
}

function symbolsFor(content, ext) {
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\bclass\s+([A-Za-z_$][\w$]*)\b/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
    /\bexports\.([A-Za-z_$][\w$]*)\s*=/g,
    /\bmodule\.exports\s*=\s*\{([^}]+)\}/g,
    /^#{1,3}\s+(.+)$/gm,
  ];
  const names = [];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) {
      if (re.source.includes('module\\.exports')) {
        for (const part of String(m[1] || '').split(',')) {
          const n = part.trim().split(/\s*:/)[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(n)) names.push(n);
        }
      } else if (m[1]) {
        names.push(String(m[1]).trim().slice(0, 60));
      }
    }
  }
  if (['.css', '.scss'].includes(ext)) {
    for (const m of content.matchAll(/\.([A-Za-z_-][\w-]*)\s*\{/g)) names.push('.' + m[1]);
  }
  return [...new Set(names)].slice(0, 12);
}

function buildRepoMap({ cwd = process.cwd(), limit = 120 } = {}) {
  const files = walk(cwd).slice(0, limit);
  const items = [];
  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(cwd, file);
    const symbols = symbolsFor(raw, path.extname(file));
    items.push({ path: rel, bytes: raw.length, symbols });
  }
  return { cwd, files: items.length, items };
}

function formatRepoMap(map) {
  const lines = [];
  lines.push('');
  lines.push(`  ctx repomap — ${map.files} file(s)`);
  lines.push('');
  for (const item of map.items) {
    const syms = item.symbols.length ? ': ' + item.symbols.join(', ') : '';
    lines.push(`  ${item.path}${syms}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildRepoMap, formatRepoMap, symbolsFor };
