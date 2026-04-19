'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { encodeCwd } = require('./session.js');

const DEFAULT_BASE = path.join(os.homedir(), '.config', 'ctx', 'backups');

function resolveBaseDir(config) {
  const raw = config?.backup?.dir || DEFAULT_BASE;
  if (raw.startsWith('~')) return raw.replace(/^~/, os.homedir());
  return raw;
}

function backupDir(cwd, config) {
  return path.join(resolveBaseDir(config), encodeCwd(cwd));
}

function backupFileName(sessionId, ts = new Date()) {
  const iso = ts.toISOString().replace(/[:.]/g, '-');
  return `${sessionId}-${iso}.jsonl.gz`;
}

function writeBackup(sessionPath, cwd, sessionId, config) {
  const dir = backupDir(cwd, config);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, backupFileName(sessionId));
  const staging = path.join(dir, `.staging-${process.pid}-${Date.now()}.jsonl`);

  try {
    fs.copyFileSync(sessionPath, staging);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const finalTarget = target + '.part';
    pipeline(
      fs.createReadStream(staging),
      zlib.createGzip(),
      fs.createWriteStream(finalTarget),
      (err) => {
        try { fs.unlinkSync(staging); } catch {}
        if (err) {
          try { fs.unlinkSync(finalTarget); } catch {}
          return reject(err);
        }
        try {
          fs.renameSync(finalTarget, target);
          const stat = fs.statSync(target);
          const rotated = rotate(cwd, config);
          resolve({ path: target, size: stat.size, rotated });
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

function listBackups(cwd, config) {
  const dir = backupDir(cwd, config);
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl.gz')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const m = name.match(/^(.+?)-(\d{4}-\d{2}-\d{2}T[0-9\-]+Z?)\.jsonl\.gz$/);
    items.push({
      name,
      path: full,
      size: stat.size,
      mtime: stat.mtimeMs,
      sessionId: m ? m[1] : name.replace(/\.jsonl\.gz$/, ''),
      ts: m ? m[2] : null,
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items;
}

function rotate(cwd, config) {
  const keep = config?.backup?.keep_last ?? 10;
  if (!Number.isFinite(keep) || keep < 0) return { removed: 0 };
  const items = listBackups(cwd, config);
  const excess = items.slice(keep);
  let removed = 0;
  for (const item of excess) {
    try { fs.unlinkSync(item.path); removed++; } catch {}
  }
  return { removed, removedFiles: excess.map(e => e.name) };
}

function resolveBackup(cwd, config, idOrPrefix) {
  const items = listBackups(cwd, config);
  if (!items.length) return { error: 'no-backups' };
  const matches = items.filter(i =>
    i.name === idOrPrefix ||
    i.sessionId === idOrPrefix ||
    i.sessionId.startsWith(idOrPrefix) ||
    i.name.startsWith(idOrPrefix)
  );
  if (!matches.length) return { error: 'not-found' };
  if (matches.length > 1) return { error: 'ambiguous', matches };
  return { match: matches[0] };
}

function restoreStream(srcPath, outStream) {
  return new Promise((resolve, reject) => {
    pipeline(
      fs.createReadStream(srcPath),
      zlib.createGunzip(),
      outStream,
      (err) => (err ? reject(err) : resolve())
    );
  });
}

module.exports = {
  DEFAULT_BASE,
  resolveBaseDir,
  backupDir,
  backupFileName,
  writeBackup,
  listBackups,
  rotate,
  resolveBackup,
  restoreStream,
};
