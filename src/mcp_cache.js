'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(os.homedir(), '.config', 'ctx', 'mcp-cache');

function ensureDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function logCacheEvent(line) {
  try {
    const logPath = path.join(os.homedir(), '.config', 'ctx', 'hooks.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function writeCache(content, opts = {}, deps = {}) {
  ensureDir();
  const rand = deps.random || Math.random;
  const gcCfg = (opts.gc) || {};
  if (gcCfg.enabled !== false) {
    const prob = typeof gcCfg.sweep_probability === 'number' ? gcCfg.sweep_probability : 0.05;
    if (rand() < prob) {
      try { sweep(gcCfg); } catch {}
    }
  }
  const hash = crypto.createHash('sha1').update(content).update(String(Date.now())).update(crypto.randomBytes(4)).digest('hex').slice(0, 12);
  const filePath = path.join(CACHE_DIR, `${hash}.txt`);
  fs.writeFileSync(filePath, content);
  const expiresAt = Date.now() + (opts.ttlMs || 24 * 3600 * 1000);
  fs.writeFileSync(filePath + '.meta', JSON.stringify({ expiresAt, size: content.length }));
  logCacheEvent(`cache-write ref=${hash} bytes=${content.length}`);
  return { ref: hash, path: filePath, size: content.length, expiresAt };
}

function readCache(ref, { offset = 0, limit = 4000 } = {}) {
  const filePath = path.join(CACHE_DIR, `${ref}.txt`);
  if (!fs.existsSync(filePath)) {
    logCacheEvent(`cache-read ref=${ref} result=miss bytes=0`);
    return { error: 'not-found' };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const total = content.length;
  const slice = content.slice(offset, offset + limit);
  logCacheEvent(`cache-read ref=${ref} result=hit bytes=${slice.length}`);
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

function sweep(gcCfg = {}) {
  ensureDir();
  const now = Date.now();
  const ttlMs = (gcCfg.ttl_hours || 24) * 3600 * 1000;
  const maxBytes = gcCfg.max_bytes || 104857600;

  let names;
  try { names = fs.readdirSync(CACHE_DIR); } catch { return { swept: 0, bytes_freed: 0 }; }

  const files = [];
  for (const n of names) {
    if (!n.endsWith('.txt')) continue;
    const p = path.join(CACHE_DIR, n);
    try {
      const st = fs.statSync(p);
      files.push({ name: n, path: p, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }

  let swept = 0, bytesFreed = 0;
  const kill = (f) => {
    try { fs.unlinkSync(f.path); } catch {}
    try { fs.unlinkSync(f.path + '.meta'); } catch {}
    swept++; bytesFreed += f.size;
  };

  const survivors = [];
  for (const f of files) {
    if (now - f.mtimeMs > ttlMs) kill(f);
    else survivors.push(f);
  }

  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = survivors.reduce((s, f) => s + f.size, 0);
  while (total > maxBytes && survivors.length) {
    const f = survivors.shift();
    kill(f);
    total -= f.size;
  }

  logCacheEvent(`cache-gc swept=${swept} bytes_freed=${bytesFreed}`);
  return { swept, bytes_freed: bytesFreed };
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
  sweep,
  summarizeLines,
};
