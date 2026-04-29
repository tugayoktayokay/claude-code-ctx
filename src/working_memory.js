'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

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

module.exports = { loadSession, baseDir, sessionFile, blobDir, emptyState };
