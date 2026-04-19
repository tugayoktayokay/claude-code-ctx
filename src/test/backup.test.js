'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const zlib   = require('zlib');

const {
  writeBackup,
  listBackups,
  resolveBackup,
  restoreStream,
  rotate,
  backupDir,
} = require('../backup.js');

function makeConfig(dir) {
  return { backup: { enabled: true, dir, keep_last: 3 } };
}

test('writeBackup produces a gzip round-trip identical to source', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bkp-'));
  const cwd  = '/tmp/ctx-bkp-project';
  const src  = path.join(base, 'session.jsonl');
  const body = Array.from({ length: 50 }, (_, i) =>
    JSON.stringify({ type: 'user', message: { content: `line ${i}` } })
  ).join('\n') + '\n';
  fs.writeFileSync(src, body);

  const config = makeConfig(path.join(base, 'backups'));
  const result = await writeBackup(src, cwd, 'abc-123', config);

  assert.ok(fs.existsSync(result.path), 'backup file exists');
  const restored = zlib.gunzipSync(fs.readFileSync(result.path)).toString('utf8');
  assert.equal(restored, body, 'gunzip matches source exactly');

  fs.rmSync(base, { recursive: true, force: true });
});

test('rotate keeps the N most recent backups only', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-rot-'));
  const cwd  = '/tmp/ctx-rot-project';
  const src  = path.join(base, 'session.jsonl');
  fs.writeFileSync(src, 'line1\nline2\n');
  const config = makeConfig(path.join(base, 'backups'));
  config.backup.keep_last = 2;

  for (let i = 0; i < 5; i++) {
    await writeBackup(src, cwd, `session-${i}`, config);
    await new Promise(r => setTimeout(r, 5));
  }

  const items = listBackups(cwd, config);
  assert.equal(items.length, 2, `only keep_last (2) remain, got ${items.length}`);
  assert.ok(items[0].sessionId.startsWith('session-'));

  fs.rmSync(base, { recursive: true, force: true });
});

test('resolveBackup matches by prefix, ambiguous errors', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-res-'));
  const cwd  = '/tmp/ctx-res-project';
  const src  = path.join(base, 'session.jsonl');
  fs.writeFileSync(src, 'x\n');
  const config = makeConfig(path.join(base, 'backups'));

  await writeBackup(src, cwd, 'abc-111', config);
  await new Promise(r => setTimeout(r, 5));
  await writeBackup(src, cwd, 'xyz-222', config);

  const exact = resolveBackup(cwd, config, 'xyz-222');
  assert.ok(exact.match, 'exact prefix resolves');
  assert.equal(exact.match.sessionId, 'xyz-222');

  const missing = resolveBackup(cwd, config, 'never');
  assert.equal(missing.error, 'not-found');

  await writeBackup(src, cwd, 'abc-333', config);
  const amb = resolveBackup(cwd, config, 'abc');
  assert.equal(amb.error, 'ambiguous');
  assert.ok(amb.matches.length >= 2);

  fs.rmSync(base, { recursive: true, force: true });
});

test('restoreStream pipes gunzipped content to a writable', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-rst-'));
  const cwd  = '/tmp/ctx-rst-project';
  const src  = path.join(base, 'session.jsonl');
  const body = 'hello\nworld\n';
  fs.writeFileSync(src, body);
  const config = makeConfig(path.join(base, 'backups'));

  const wrote = await writeBackup(src, cwd, 'aaa-bbb', config);
  const outPath = path.join(base, 'restored.jsonl');
  await restoreStream(wrote.path, fs.createWriteStream(outPath));
  assert.equal(fs.readFileSync(outPath, 'utf8'), body);

  fs.rmSync(base, { recursive: true, force: true });
});

test('backupDir uses encoded cwd under the base', () => {
  const config = makeConfig('/tmp/ctx-bdir');
  const dir = backupDir('/Users/foo/project', config);
  assert.match(dir, /^\/tmp\/ctx-bdir\/-Users-foo-project$/);
});

test('writeBackup leaves no staging or .part files on success', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-stg-'));
  const cwd  = '/tmp/ctx-stg-project';
  const src  = path.join(base, 'session.jsonl');
  fs.writeFileSync(src, 'abc\ndef\n');
  const config = makeConfig(path.join(base, 'backups'));
  const wrote = await writeBackup(src, cwd, 'clean-123', config);

  const bdir = path.dirname(wrote.path);
  const siblings = fs.readdirSync(bdir);
  const stray = siblings.filter(n => n.startsWith('.staging') || n.endsWith('.part'));
  assert.equal(stray.length, 0, `no staging remnants, got ${stray.join(',')}`);

  fs.rmSync(base, { recursive: true, force: true });
});

test('writeBackup is stable even if source file grows after copy starts', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-grow-'));
  const cwd  = '/tmp/ctx-grow-project';
  const src  = path.join(base, 'session.jsonl');
  const initial = 'line1\nline2\n';
  fs.writeFileSync(src, initial);
  const config = makeConfig(path.join(base, 'backups'));

  const p = writeBackup(src, cwd, 'growing', config);
  fs.appendFileSync(src, 'line3-appended-after\n');
  const wrote = await p;

  const zlib = require('zlib');
  const restored = zlib.gunzipSync(fs.readFileSync(wrote.path)).toString('utf8');
  assert.equal(restored, initial, 'backup contains the copyFileSync snapshot, not later appends');

  fs.rmSync(base, { recursive: true, force: true });
});
