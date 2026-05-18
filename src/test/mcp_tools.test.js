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

test('cache-write hints render as real MCP tool-call syntax (regression: shell-form was uncallable)', async () => {
  // Old hint `(ctx_cache_get ref="X" offset=0 to read chunks)` looked like a
  // shell command. Claude cannot execute MCP tools that way — must be JSON
  // args. Cache hit rate stayed ~1% until we switched to call-syntax hints.
  const callRe = /ctx_cache_get\(\{ref:\s*"[a-f0-9]{12}",\s*offset:\s*0,\s*limit:\s*\d+\}\)/;
  const cfg = loadDefaults();

  const shellRes = await getTool('ctx_shell').handler({
    command: `node -e "for(let i=0;i<500;i++){console.log('x '+i)}"`,
    limit_bytes: 200,
  }, { config: cfg });
  assert.match(shellRes, callRe, 'ctx_shell hint missing JSON call syntax');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hint-read-'));
  const p = path.join(tmp, 'big.txt');
  fs.writeFileSync(p, Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n'));
  try {
    const readRes = await getTool('ctx_read').handler({ path: p, limit_bytes: 200 }, { config: cfg });
    assert.match(readRes, callRe, 'ctx_read hint missing JSON call syntax');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  const tmpG = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hint-grep-'));
  fs.writeFileSync(path.join(tmpG, 'a.txt'),
    Array.from({ length: 500 }, (_, i) => `needle ${i}`).join('\n'));
  try {
    const grepRes = await getTool('ctx_grep').handler({ pattern: 'needle', path: tmpG, limit_bytes: 200 }, { config: cfg });
    assert.match(grepRes, callRe, 'ctx_grep hint missing JSON call syntax');
  } finally { fs.rmSync(tmpG, { recursive: true, force: true }); }
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

test('ctx_cache_get caps oversized requested chunks', async () => {
  const cache = require('../mcp_cache.js');
  const w = cache.writeCache('x'.repeat(20000));
  const cfg = loadDefaults();
  cfg.mcp.cache_get_max_limit = 1234;
  const r = await getTool('ctx_cache_get').handler({ ref: w.ref, offset: 0, limit: 9000 }, { config: cfg });
  assert.match(r, /returned=1234B/);
  assert.match(r, /capped at 1234B/);
  try { fs.unlinkSync(w.path); fs.unlinkSync(w.path + '.meta'); } catch {}
});

test('ctx_grep honors limit_bytes before summarizing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-grep-'));
  const p = path.join(tmp, 'a.txt');
  fs.writeFileSync(p, Array.from({ length: 40 }, (_, i) => `needle line ${i}`).join('\n'));
  try {
    const r = await getTool('ctx_grep').handler({ pattern: 'needle', path: p, limit_bytes: 80 }, { config: loadDefaults() });
    assert.match(r, /summarized/);
    assert.match(r, /ref: [a-f0-9]{12}/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('ctx_grep alternation pattern works (regression: rg-missing fallback used -E)', async () => {
  // FitCrate trace bug: machines without rg fell back to plain grep -rn,
  // which treats `|` literally — so `TODO|FIXME|XXX` returned zero matches.
  // Fixed by adding -E to the grep fallback.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-grep-alt-'));
  const p = path.join(tmp, 'sample.ts');
  fs.writeFileSync(p, '// TODO: a\nconst x=1;\n// FIXME: b\n// XXX: c\n');
  try {
    const r = await getTool('ctx_grep').handler({ pattern: 'TODO|FIXME|XXX', path: tmp }, { config: loadDefaults() });
    assert.match(r, /TODO/);
    assert.match(r, /FIXME/);
    assert.match(r, /XXX/);
    assert.doesNotMatch(r, /no matches/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
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

test('ctx_recall_read summarizes large cached content instead of returning it all', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-mcp-big-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');
  delete require.cache[require.resolve('../working_memory.js')];
  delete require.cache[require.resolve('../mcp_tools.js')];
  const wm = require('../working_memory.js');

  try {
    const content = Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n');
    wm.recordRead('sid-big', '/big.md', content);

    const { allTools: allTools4 } = require('../mcp_tools.js');
    const tool = allTools4().find(t => t.name === 'ctx_recall_read');
    const res = await tool.handler({ path: '/big.md', session_id: 'sid-big', limit_bytes: 100 }, { config: loadDefaults() });
    assert.match(res, /summarized/);
    assert.match(res, /ref: [a-f0-9]{12}/);
    assert.match(res, /more lines omitted/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('ctx_recall_read logs working_memory recall_call event', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-mcp-log-'));
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(path.join(fakeHome, '.config', 'ctx'), { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');
  delete require.cache[require.resolve('../working_memory.js')];
  delete require.cache[require.resolve('../mcp_tools.js')];
  const wm = require('../working_memory.js');

  try {
    wm.recordRead('sid-log', '/x.md', 'big content here that is large enough');

    const { allTools } = require('../mcp_tools.js');
    const tool = allTools().find(t => t.name === 'ctx_recall_read');
    await tool.handler({ path: '/x.md', session_id: 'sid-log' }, { config: {} });

    const logFile = path.join(fakeHome, '.config', 'ctx', 'hooks.log');
    assert.ok(fs.existsSync(logFile));
    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /working_memory action=recall_call session=sid-log .*hit=true/);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete require.cache[require.resolve('../mcp_tools.js')];
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
