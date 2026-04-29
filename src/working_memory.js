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

module.exports = {
  loadSession, saveSession, baseDir, sessionFile, blobDir, emptyState,
  hashContent, writeBlob, readBlob, blobPath,
  recordRead, lookupLatestRead, MAX_ENTRIES_PER_PATH,
};
