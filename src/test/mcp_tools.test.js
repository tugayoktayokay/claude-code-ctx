'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// File-level HOME isolation. mcp_cache.writeCache appends a `cache-write`
// event to `~/.config/ctx/hooks.log` and creates files in `~/.config/ctx/mcp-cache/`.
// Without this every test run would pollute the real log + cache dir.
const FILE_TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-mcptools-test-home-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = FILE_TMP_HOME;
process.on('exit', () => {
  process.env.HOME = ORIG_HOME;
  try { fs.rmSync(FILE_TMP_HOME, { recursive: true, force: true }); } catch {}
});

const { allTools } = require('../mcp_tools.js');
const { loadDefaults } = require('../config.js');

function getTool(name) {
  return allTools().find(t => t.name === name);
}

test('ctx_shell returns inline when output small', async () => {
  const tool = getTool('ctx_shell');
  const r = await tool.handler({ command: 'echo hello' }, { config: loadDefaults() });
  assert.match(r, /ctx_shell exit 0/);
  assert.match(r, /hello/);
});

test('ctx_shell summarizes + caches when output large', async () => {
  const tool = getTool('ctx_shell');
  const cmd = `node -e "for(let i=0;i<2000;i++){console.log('line '+i)}"`;
  const r = await tool.handler({ command: cmd, limit_bytes: 500 }, { config: loadDefaults() });
  assert.match(r, /summarized/);
  assert.match(r, /ref: [a-f0-9]{12}/);
  assert.match(r, /line 0/);
  assert.match(r, /more lines omitted/);
});

test('ctx_read small file returns inline', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-read-'));
  const p = path.join(tmp, 'a.txt');
  fs.writeFileSync(p, 'short content');
  try {
    const r = await getTool('ctx_read').handler({ path: p }, { config: loadDefaults() });
    assert.match(r, /short content/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ctx_read oversized file gets summarized', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-read2-'));
  const p = path.join(tmp, 'big.txt');
  fs.writeFileSync(p, Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n'));
  try {
    const r = await getTool('ctx_read').handler({ path: p, limit_bytes: 500 }, { config: loadDefaults() });
    assert.match(r, /summarized/);
    assert.match(r, /ref: [a-f0-9]{12}/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ctx_read missing file returns error string', async () => {
  const r = await getTool('ctx_read').handler({ path: '/nonexistent-xyz-987' }, { config: loadDefaults() });
  assert.match(r, /error: not found/);
});

test('ctx_cache_get retrieves previously stored content', async () => {
  const cache = require('../mcp_cache.js');
  const w = cache.writeCache('persistent content for mcp test');
  const r = await getTool('ctx_cache_get').handler({ ref: w.ref, offset: 0, limit: 100 }, { config: loadDefaults() });
  assert.match(r, /persistent content/);
  try { fs.unlinkSync(w.path); fs.unlinkSync(w.path + '.meta'); } catch {}
});

test('all tools have required schema fields', () => {
  for (const t of allTools()) {
    assert.ok(t.name, 'name');
    assert.ok(t.description && t.description.length > 10, `${t.name} description too short`);
    assert.ok(t.inputSchema, `${t.name} inputSchema`);
    assert.equal(typeof t.handler, 'function', `${t.name} handler`);
  }
});

test('ctx_recall_read returns cached content for previously recorded path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-mcp-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');
  // Bust require cache to ensure mcp_tools picks up env-aware path
  delete require.cache[require.resolve('../working_memory.js')];
  delete require.cache[require.resolve('../mcp_tools.js')];
  const wm = require('../working_memory.js');

  try {
    const sid = 'sid-mcp-1';
    const filePath = '/abs/CLAUDE.md';
    const content = 'CLAUDE rules go here';
    wm.recordRead(sid, filePath, content);

    const { allTools: allTools2 } = require('../mcp_tools.js');
    const tool = allTools2().find(t => t.name === 'ctx_recall_read');
    assert.ok(tool, 'ctx_recall_read tool registered');

    const res = await tool.handler({ path: filePath, session_id: sid }, { config: {} });
    assert.match(res, /CLAUDE rules go here/);
    assert.match(res, /turn=1/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('ctx_recall_read returns error for unknown path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-mcp-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');
  delete require.cache[require.resolve('../working_memory.js')];
  delete require.cache[require.resolve('../mcp_tools.js')];
  try {
    const { allTools: allTools3 } = require('../mcp_tools.js');
    const tool = allTools3().find(t => t.name === 'ctx_recall_read');
    const res = await tool.handler({ path: '/nope.md', session_id: 'sid-x' }, { config: {} });
    assert.match(res, /no working memory record/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
