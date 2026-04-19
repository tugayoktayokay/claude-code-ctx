'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { parseDuration, planPrune, applyPrune, planFromOpts } = require('../prune.js');

function setupFixture(ages) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-prune-'));
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const now = Date.now();
  const lines = ['# My memory', ''];
  for (const [name, ageMs] of ages) {
    const full = path.join(memoryDir, name);
    fs.writeFileSync(full, `---\nname: ${name}\n---\nbody`);
    const t = new Date(now - ageMs);
    fs.utimesSync(full, t, t);
    if (name.startsWith('project_')) {
      lines.push(`- [${name.replace(/\.md$/, '')}](${name}) — test`);
    }
  }
  lines.push('- [user note](notes.md) — hand-written keep this');
  lines.push('');
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), lines.join('\n'));
  return { base, memoryDir };
}

test('parseDuration parses "30d", "12h", "45m", "2w"', () => {
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.equal(parseDuration('45m'), 45 * 60_000);
  assert.equal(parseDuration('2w'),  2 * 604_800_000);
  assert.equal(parseDuration('10'),  10 * 86_400_000, 'bare number = days');
  assert.equal(parseDuration('bad'), null);
});

test('planPrune respects --older-than', () => {
  const { base, memoryDir } = setupFixture([
    ['project_old.md',    40 * 86_400_000],
    ['project_recent.md', 1  * 86_400_000],
  ]);
  try {
    const plan = planPrune(memoryDir, { olderThanMs: 30 * 86_400_000 });
    assert.equal(plan.toRemove.length, 1);
    assert.equal(plan.toRemove[0].name, 'project_old.md');
    assert.equal(plan.toKeep.length, 1);
    assert.equal(plan.toKeep[0].name, 'project_recent.md');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('planPrune respects --keep-last', () => {
  const { base, memoryDir } = setupFixture([
    ['project_a.md', 5 * 60_000],
    ['project_b.md', 4 * 60_000],
    ['project_c.md', 3 * 60_000],
    ['project_d.md', 2 * 60_000],
    ['project_e.md', 1 * 60_000],
  ]);
  try {
    const plan = planPrune(memoryDir, { keepLast: 2 });
    assert.equal(plan.toKeep.length, 2);
    assert.equal(plan.toKeep[0].name, 'project_e.md', 'newest kept');
    assert.equal(plan.toKeep[1].name, 'project_d.md');
    assert.equal(plan.toRemove.length, 3);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('applyPrune removes files AND rewrites MEMORY.md; hand-written lines preserved', () => {
  const { base, memoryDir } = setupFixture([
    ['project_old.md',   40 * 86_400_000],
    ['project_fresh.md', 1  * 86_400_000],
  ]);
  try {
    const plan = planPrune(memoryDir, { olderThanMs: 30 * 86_400_000 });
    const result = applyPrune(plan);
    assert.equal(result.removedFiles, 1);
    assert.equal(result.indexRemoved, 1);
    assert.equal(fs.existsSync(path.join(memoryDir, 'project_old.md')), false);
    assert.equal(fs.existsSync(path.join(memoryDir, 'project_fresh.md')), true);

    const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
    assert.doesNotMatch(idx, /project_old/);
    assert.match(idx, /project_fresh/);
    assert.match(idx, /user note/, 'hand-written line preserved');
    assert.match(idx, /# My memory/, 'headers preserved');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('planFromOpts wires string flags', () => {
  const { base, memoryDir } = setupFixture([
    ['project_a.md', 5 * 86_400_000],
    ['project_b.md', 50 * 86_400_000],
  ]);
  try {
    const plan = planFromOpts(memoryDir, { olderThan: '30d' });
    assert.equal(plan.toRemove.length, 1);
    assert.equal(plan.toRemove[0].name, 'project_b.md');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('planPrune on missing dir returns exists=false', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-prune-'));
  try {
    const plan = planPrune(path.join(base, 'nope'), { keepLast: 1 });
    assert.equal(plan.exists, false);
    assert.equal(plan.toRemove.length, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
