'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { buildThreads } = require('../timeline.js');

function mkSnap(dir, name, { parent, fingerprint, ageDays = 0, categories = [] }) {
  const full = path.join(dir, name);
  const lines = ['---', `name: ${name}`];
  if (parent)      lines.push(`parent: ${parent}`);
  if (fingerprint) lines.push(`fingerprint: ${fingerprint}`);
  if (categories.length) lines.push(`categories: [${categories.join(', ')}]`);
  lines.push('---');
  lines.push('body');
  fs.writeFileSync(full, lines.join('\n'));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(full, t, t);
}

test('buildThreads follows parent chain and groups into threads', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tl-'));
  mkSnap(tmp, 'project_a1.md', { fingerprint: 'a', ageDays: 5 });
  mkSnap(tmp, 'project_a2.md', { fingerprint: 'b', parent: 'project_a1.md', ageDays: 4 });
  mkSnap(tmp, 'project_a3.md', { fingerprint: 'c', parent: 'project_a2.md', ageDays: 3 });
  mkSnap(tmp, 'project_b1.md', { fingerprint: 'd', ageDays: 2 });

  try {
    const threads = buildThreads(tmp);
    assert.equal(threads.length, 2, 'two threads');
    const long = threads.find(t => t.length === 3);
    assert.ok(long, 'one 3-long thread');
    assert.deepEqual(long.map(s => s.name), ['project_a1.md', 'project_a2.md', 'project_a3.md']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildThreads handles broken parent (missing file) gracefully', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tlb-'));
  mkSnap(tmp, 'project_x.md', { fingerprint: 'x', parent: 'missing.md', ageDays: 1 });
  try {
    const threads = buildThreads(tmp);
    assert.equal(threads.length, 1, 'still one thread');
    assert.equal(threads[0].length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
