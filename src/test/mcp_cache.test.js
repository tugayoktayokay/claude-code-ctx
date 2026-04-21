'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const cache  = require('../mcp_cache.js');

function withTmpHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-mcpc-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try { return fn(tmpHome); }
  finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

test('writeCache + readCache round-trip', () => {
  const big = 'line\n'.repeat(10000);
  const w = cache.writeCache(big);
  assert.match(w.ref, /^[a-f0-9]{12}$/);
  const r1 = cache.readCache(w.ref, { offset: 0, limit: 100 });
  assert.equal(r1.total, big.length);
  assert.equal(r1.returned, 100);
  const r2 = cache.readCache(w.ref, { offset: big.length - 5, limit: 100 });
  assert.equal(r2.returned, 5);
  try { fs.unlinkSync(w.path); } catch {}
  try { fs.unlinkSync(w.path + '.meta'); } catch {}
});

test('readCache not-found returns error', () => {
  const r = cache.readCache('nonexistent123');
  assert.equal(r.error, 'not-found');
});

test('summarizeLines compresses long output with head/tail', () => {
  const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const s = cache.summarizeLines(content, { head: 5, tail: 3 });
  assert.match(s, /line 0/);
  assert.match(s, /line 499/);
  assert.match(s, /more lines omitted/);
  assert.doesNotMatch(s, /line 250/);
});

test('summarizeLines passes short content unchanged', () => {
  const s = cache.summarizeLines('only a line');
  assert.equal(s, 'only a line');
});

test('writeCache appends cache-write event to hooks.log', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const r = cache.writeCache('hello world');
    const log = fs.readFileSync(path.join(home, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(log, new RegExp(`cache-write ref=${r.ref} bytes=11`));
  });
});

test('readCache(valid) logs cache-read result=hit', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const r = cache.writeCache('xyz');
    cache.readCache(r.ref);
    const log = fs.readFileSync(path.join(home, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(log, new RegExp(`cache-read ref=${r.ref} result=hit bytes=3`));
  });
});

test('readCache(unknown) logs cache-read result=miss', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    cache.readCache('nonexistent-ref');
    const log = fs.readFileSync(path.join(home, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(log, /cache-read ref=nonexistent-ref result=miss bytes=0/);
  });
});

test('sweep evicts TTL-expired entries only', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const a = cache.writeCache('a');
    const b = cache.writeCache('b');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(a.path, longAgo, longAgo);
    const r = cache.sweep({ ttl_hours: 24, max_bytes: 1e9 });
    assert.equal(r.swept, 1);
    assert.equal(fs.existsSync(a.path), false);
    assert.equal(fs.existsSync(b.path), true);
  });
});

test('sweep enforces max_bytes by evicting oldest', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const entries = [];
    for (let i = 0; i < 4; i++) {
      entries.push(cache.writeCache('x'.repeat(100)));
      const t = new Date(Date.now() - (4 - i) * 60 * 1000);
      fs.utimesSync(entries[i].path, t, t);
    }
    const r = cache.sweep({ ttl_hours: 48, max_bytes: 250 });
    assert.equal(r.swept, 2);
    assert.equal(fs.existsSync(entries[0].path), false);
    assert.equal(fs.existsSync(entries[1].path), false);
    assert.equal(fs.existsSync(entries[2].path), true);
    assert.equal(fs.existsSync(entries[3].path), true);
  });
});

test('writeCache triggers sweep when random() < sweep_probability', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const victim = cache.writeCache('victim');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(victim.path, longAgo, longAgo);
    cache.writeCache('fresh', { gc: { enabled: true, sweep_probability: 1, ttl_hours: 24, max_bytes: 1e9 } }, { random: () => 0 });
    assert.equal(fs.existsSync(victim.path), false);
  });
});

test('writeCache does not trigger sweep when random() >= sweep_probability', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const victim = cache.writeCache('victim');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(victim.path, longAgo, longAgo);
    cache.writeCache('fresh', { gc: { enabled: true, sweep_probability: 0.01 } }, { random: () => 0.99 });
    assert.equal(fs.existsSync(victim.path), true);
  });
});

test('sweep logs cache-gc event', () => {
  withTmpHome((home) => {
    delete require.cache[require.resolve('../mcp_cache.js')];
    const cache = require('../mcp_cache.js');
    const victim = cache.writeCache('victim');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(victim.path, longAgo, longAgo);
    cache.sweep({ ttl_hours: 24 });
    const log = fs.readFileSync(path.join(home, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(log, /cache-gc swept=1 bytes_freed=\d+/);
  });
});
