'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.homedir(), '.config', 'ctx', 'mcp-cache');

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function writeCache(content, { ttlMs = 24 * 3600 * 1000 } = {}) {
  ensureDir();
  const hash = crypto.createHash('sha1').update(content).update(String(Date.now())).digest('hex').slice(0, 12);
  const filePath = path.join(CACHE_DIR, `${hash}.txt`);
  fs.writeFileSync(filePath, content);
  const expiresAt = Date.now() + ttlMs;
  fs.writeFileSync(filePath + '.meta', JSON.stringify({ expiresAt, size: content.length }));
  return { ref: hash, path: filePath, size: content.length, expiresAt };
}

function readCache(ref, { offset = 0, limit = 4000 } = {}) {
  const filePath = path.join(CACHE_DIR, `${ref}.txt`);
  if (!fs.existsSync(filePath)) return { error: 'not-found' };
  const content = fs.readFileSync(filePath, 'utf8');
  const total = content.length;
  const slice = content.slice(offset, offset + limit);
  return { content: slice, total, offset, returned: slice.length };
}

function sweepExpired() {
  ensureDir();
  let names;
  try { names = fs.readdirSync(CACHE_DIR); } catch { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith('.meta')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, n), 'utf8'));
      if (meta.expiresAt && meta.expiresAt < now) {
        const base = n.slice(0, -5);
        try { fs.unlinkSync(path.join(CACHE_DIR, base)); } catch {}
        try { fs.unlinkSync(path.join(CACHE_DIR, n)); } catch {}
        removed++;
      }
    } catch {}
  }
  return removed;
}

function summarizeLines(content, { head = 20, tail = 10, maxLineLen = 300 } = {}) {
  const lines = content.split('\n');
  if (lines.length <= head + tail + 5) {
    return content.split('\n').map(l => l.slice(0, maxLineLen)).join('\n');
  }
  const headPart = lines.slice(0, head).map(l => l.slice(0, maxLineLen));
  const tailPart = lines.slice(-tail).map(l => l.slice(0, maxLineLen));
  const omitted = lines.length - head - tail;
  return [
    ...headPart,
    `…[${omitted} more lines omitted]…`,
    ...tailPart,
  ].join('\n');
}

module.exports = {
  CACHE_DIR,
  writeCache,
  readCache,
  sweepExpired,
  summarizeLines,
};
