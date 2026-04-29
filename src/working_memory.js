'use strict';

const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');

function baseDir() {
  return process.env.CTX_WORKING_MEMORY_DIR
    || path.join(os.homedir(), '.config', 'ctx', 'working_memory');
}

function sessionFile(sid) {
  return path.join(baseDir(), `${sid}.json`);
}

function blobDir(sid) {
  return path.join(baseDir(), 'blobs', sid);
}

function emptyState(sid) {
  return { session_id: sid, next_turn: 1, reads: {} };
}

function loadSession(sid) {
  const file = sessionFile(sid);
  if (!fs.existsSync(file)) return emptyState(sid);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.reads) return emptyState(sid);
    return parsed;
  } catch {
    return emptyState(sid);
  }
}

function saveSession(state) {
  if (!state || !state.session_id) return;
  const dir = baseDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = sessionFile(state.session_id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function hashContent(content) {
  const buf = typeof content === 'string' ? content : String(content);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function blobPath(sid, hash) {
  const safe = hash.replace(/:/g, '_');
  return path.join(blobDir(sid), safe + '.txt');
}

function writeBlob(sid, hash, content) {
  const dir = blobDir(sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = blobPath(sid, hash);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readBlob(sid, hash) {
  const file = blobPath(sid, hash);
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

const MAX_ENTRIES_PER_PATH = 5;

function recordRead(sid, filePath, content, opts = {}) {
  const state = loadSession(sid);
  const hash = hashContent(content);
  const entry = {
    turn: state.next_turn,
    hash,
    size: typeof content === 'string' ? content.length : 0,
    mtime: opts.mtime || null,
    ts: new Date().toISOString(),
  };
  if (!state.reads[filePath]) state.reads[filePath] = [];
  state.reads[filePath].push(entry);
  if (state.reads[filePath].length > MAX_ENTRIES_PER_PATH) {
    state.reads[filePath] = state.reads[filePath].slice(-MAX_ENTRIES_PER_PATH);
  }
  state.next_turn++;
  saveSession(state);
  writeBlob(sid, hash, content);
  return entry;
}

function lookupLatestRead(sid, filePath) {
  const state = loadSession(sid);
  const arr = state.reads[filePath];
  if (!arr || !arr.length) return null;
  return arr[arr.length - 1];
}

function dedupDecision(sid, filePath, content, opts = {}) {
  const prior = lookupLatestRead(sid, filePath);
  if (!prior) return null;

  const minSize = opts.min_dedup_size_bytes ?? 1024;
  const recencyWindowMs = (opts.recency_window_minutes ?? 10) * 60_000;

  const size = typeof content === 'string' ? content.length : 0;
  if (size < minSize) return null;

  const priorMs = Date.parse(prior.ts);
  if (!Number.isFinite(priorMs)) return null; // bad timestamp, treat as no prior
  const elapsedMs = (opts.now ?? Date.now()) - priorMs;
  if (elapsedMs > recencyWindowMs) return null;

  const hash = hashContent(content);
  if (hash !== prior.hash) return null;

  return {
    action: 'dedup',
    priorTurn: prior.turn,
    hash: prior.hash,
    size: prior.size,
    recordedAt: prior.ts,
  };
}

function cmdNorm(cmd) {
  return String(cmd || '').replace(/^\s+|\s+$/g, '').replace(/[ \t]+/g, ' ');
}

function matchBashAllowlist(cmd, cfg) {
  if (!cmd || !cfg) return null;
  const fsRead = cfg.fs_read_patterns || [];
  const stateProbe = cfg.state_probe_patterns || [];
  for (const pat of fsRead) {
    try { if (new RegExp(pat).test(cmd)) return { bucket: 'fs_read', window_sec: cfg.fs_read_window_sec ?? 60 }; }
    catch { continue; }
  }
  for (const pat of stateProbe) {
    try { if (new RegExp(pat).test(cmd)) return { bucket: 'state_probe', window_sec: cfg.state_probe_window_sec ?? 30 }; }
    catch { continue; }
  }
  return null;
}

function gcOldSessions(opts = {}) {
  const dir = baseDir();
  if (!fs.existsSync(dir)) return { removed: 0, bytes_freed: 0 };
  const ttlMs = (opts.ttl_hours || 24) * 3600 * 1000;
  const now = Date.now();
  let removed = 0;
  let bytesFreed = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { removed: 0, bytes_freed: 0 }; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(dir, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs <= ttlMs) continue;
    const sid = n.slice(0, -5);
    const blobs = blobDir(sid);
    let blobSize = 0;
    try {
      if (fs.existsSync(blobs)) {
        for (const bf of fs.readdirSync(blobs)) {
          try { blobSize += fs.statSync(path.join(blobs, bf)).size; } catch {}
        }
        fs.rmSync(blobs, { recursive: true, force: true });
      }
    } catch {}
    try { fs.unlinkSync(file); removed++; bytesFreed += st.size + blobSize; } catch {}
  }
  return { removed, bytes_freed: bytesFreed };
}

module.exports = {
  loadSession, saveSession, baseDir, sessionFile, blobDir, emptyState,
  hashContent, writeBlob, readBlob, blobPath,
  recordRead, lookupLatestRead, MAX_ENTRIES_PER_PATH,
  dedupDecision,
  gcOldSessions,
  cmdNorm, matchBashAllowlist,
};
