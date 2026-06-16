'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { parseDuration, planPrune, applyPrune, planFromOpts, isNoisySnapshotFile } = require('../prune.js');

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

test('planPrune marks injected-intent snapshots as noisy and applyPrune rewrites index', () => {
  const { base, memoryDir } = setupFixture([
    ['project_test_base_directory_for_this_skill.md', 60_000],
    ['project_real_feature.md', 30_000],
  ]);
  const noisyPath = path.join(memoryDir, 'project_test_base_directory_for_this_skill.md');
  fs.writeFileSync(noisyPath, [
    '---',
    'name: ctx snapshot - test base directory for this skill',
    'description: snapshot - last: "Base directory for this skill: /tmp/skill"',
    '---',
    '',
    '**Last task:** "Base directory for this skill: /tmp/skill"',
  ].join('\n'));

  try {
    assert.equal(isNoisySnapshotFile({ name: path.basename(noisyPath), path: noisyPath }), true);
    const plan = planPrune(memoryDir, { pruneNoisy: true });
    assert.equal(plan.toRemove.length, 1);
    assert.equal(plan.toRemove[0].name, 'project_test_base_directory_for_this_skill.md');
    assert.deepEqual(plan.toRemove[0].reasons, ['noisy-snapshot']);

    const result = applyPrune(plan);
    assert.equal(result.removedFiles, 1);
    assert.equal(result.indexRemoved, 1);

    const idx = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf8');
    assert.doesNotMatch(idx, /project_test_base_directory_for_this_skill/);
    assert.match(idx, /project_real_feature/);
    assert.match(idx, /user note/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('isNoisySnapshotFile spares a meta-snapshot that quotes noise but has real signal', () => {
  // A snapshot ABOUT the noise-filtering work: description quotes the trigger
  // string, but the body documents real modified files + decisions. Must NOT prune.
  const { base, memoryDir } = setupFixture([
    ['project_meta_filter_work.md', 20_000],
  ]);
  const p = path.join(memoryDir, 'project_meta_filter_work.md');
  fs.writeFileSync(p, [
    '---',
    'name: ctx snapshot - filter injected intent',
    'description: work on filtering "Base directory for this skill" from intent',
    '---',
    '',
    '**Last task:** "filter Base directory for this skill from snapshot intent"',
    '',
    '**Modified files (3):**',
    '- src/analyzer.js (/repo/src/analyzer.js)',
    '- src/prune.js (/repo/src/prune.js)',
    '- src/test/prune.test.js (/repo/src/test/prune.test.js)',
    '',
    '**Decisions made:**',
    '- skip injected user text when deriving snapshot intent',
  ].join('\n'));

  try {
    assert.equal(isNoisySnapshotFile({ name: path.basename(p), path: p }), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('isNoisySnapshotFile still prunes pure junk by filename slug', () => {
  const { base, memoryDir } = setupFixture([
    ['project_test_base_directory_for_this_skill.md', 20_000],
  ]);
  const p = path.join(memoryDir, 'project_test_base_directory_for_this_skill.md');
  // pure junk: even with a stray path mention, the filename identity is noise
  fs.writeFileSync(p, '**Last task:** "Base directory for this skill: /tmp/x"\n');
  try {
    assert.equal(isNoisySnapshotFile({ name: path.basename(p), path: p }), true);
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

test('pruneWorkingMemory removes session files older than ttl', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-prune-wm-'));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');
  delete require.cache[require.resolve('../working_memory.js')];
  const wm = require('../working_memory.js');
  try {
    wm.recordRead('sid-old', '/x.md', 'content');
    const sessFile = wm.sessionFile('sid-old');
    const old = (Date.now() - 48 * 3600 * 1000) / 1000;
    fs.utimesSync(sessFile, old, old);

    const { pruneWorkingMemory } = require('../prune.js');
    const result = pruneWorkingMemory({ ttl_hours: 24 });
    assert.equal(result.removed, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
