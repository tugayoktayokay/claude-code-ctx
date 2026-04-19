'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { parseJSONL } = require('../session.js');
const { analyzeEntries } = require('../analyzer.js');
const { makeDecision }   = require('../decision.js');
const { buildStrategy }  = require('../strategy.js');
const { loadDefaults }   = require('../config.js');
const {
  writeSnapshot,
  buildMarkdown,
  slugify,
  computeFingerprint,
  readRecentFingerprints,
  getLatestSnapshotForCwd,
  rewriteIndex,
} = require('../snapshot.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo-session.jsonl');

test('slugify produces safe filenames', () => {
  assert.equal(slugify('Şimdi Test Yaz!'), 'simdi_test_yaz');
  assert.equal(slugify(''), 'session');
});

test('buildMarkdown contains frontmatter and required sections', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  const limits   = { max: 200000, quality_ceiling: 200000 };
  const decision = makeDecision(analysis, limits, config);
  const strategy = buildStrategy(analysis, decision, config);

  const md = buildMarkdown(analysis, decision, strategy, {
    name: 'test snapshot',
    categories: config.categories,
    sessionId: 'abc',
    modelId: 'claude-opus-4-7',
  });

  assert.match(md, /^---\nname: test snapshot/);
  assert.match(md, /type: project/);
  assert.match(md, /Why:/);
  assert.match(md, /How to apply:/);
  assert.match(md, /Modified files/);
});

test('writeSnapshot writes file into temp memory dir and updates index', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-snap-'));
  const fakeCwd = '/tmp/ctx-test-project';
  const config = loadDefaults();
  const originalHome = process.env.HOME;

  config.snapshot = {
    memory_dir: path.join(tmpBase, 'memory'),
    auto_index_update: true,
  };

  try {
    const entries  = parseJSONL(FIXTURE);
    const analysis = analyzeEntries(entries, config);
    const limits   = { max: 200000, quality_ceiling: 200000 };
    const decision = makeDecision(analysis, limits, config);
    const strategy = buildStrategy(analysis, decision, config);

    const result = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd,
      config,
      customName: null,
      sessionId: 'test-session',
      modelId: 'claude-opus-4-7',
    });

    assert.ok(fs.existsSync(result.outPath), 'snapshot file created');
    const content = fs.readFileSync(result.outPath, 'utf8');
    assert.match(content, /type: project/);

    const indexPath = path.join(tmpBase, 'memory', 'MEMORY.md');
    assert.ok(fs.existsSync(indexPath), 'MEMORY.md created');
    assert.equal(result.indexUpdated, true);

    const second = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd,
      config,
      customName: null,
      sessionId: 'test-session',
      modelId: 'claude-opus-4-7',
      dedupCheck: false,
    });
    assert.notEqual(second.filename, result.filename, 'second snapshot gets unique name when dedup disabled');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (originalHome) process.env.HOME = originalHome;
  }
});

test('computeFingerprint is stable for the same analysis', () => {
  const config   = loadDefaults();
  const entries  = parseJSONL(FIXTURE);
  const analysis = analyzeEntries(entries, config);
  const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, config);

  const a = computeFingerprint(analysis, decision);
  const b = computeFingerprint(analysis, decision);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{16}$/);
});

test('writeSnapshot emits trigger and fingerprint in frontmatter', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-snap-'));
  const fakeCwd = '/tmp/ctx-test-project';
  const config  = loadDefaults();
  config.snapshot = {
    memory_dir: path.join(tmpBase, 'memory'),
    auto_index_update: true,
  };

  try {
    const entries  = parseJSONL(FIXTURE);
    const analysis = analyzeEntries(entries, config);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, config);
    const strategy = buildStrategy(analysis, decision, config);

    const result = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, sessionId: 'sid', modelId: 'claude-opus-4-7', trigger: 'commit',
    });

    const content = fs.readFileSync(result.outPath, 'utf8');
    assert.match(content, /trigger: commit/);
    assert.match(content, /fingerprint: [a-f0-9]{16}/);
    assert.ok(result.fingerprint, 'fingerprint returned');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('writeSnapshot dedup hit skips second identical snapshot', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-snap-'));
  const fakeCwd = '/tmp/ctx-test-project';
  const config  = loadDefaults();
  config.snapshot = {
    memory_dir: path.join(tmpBase, 'memory'),
    auto_index_update: true,
    dedup_window_n: 3,
  };

  try {
    const entries  = parseJSONL(FIXTURE);
    const analysis = analyzeEntries(entries, config);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, config);
    const strategy = buildStrategy(analysis, decision, config);

    const first = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, sessionId: 'sid', modelId: 'claude-opus-4-7', trigger: 'stop',
    });
    assert.equal(first.dedupHit, false);

    const second = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, sessionId: 'sid', modelId: 'claude-opus-4-7', trigger: 'stop',
    });
    assert.equal(second.dedupHit, true, 'second identical write hits dedup');
    assert.equal(second.outPath, null, 'no file written on dedup hit');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('readRecentFingerprints returns descending by mtime with parsed fp', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-fp-'));
  const memoryDir = path.join(tmpBase, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  fs.writeFileSync(path.join(memoryDir, 'project_a.md'), '---\nname: a\nfingerprint: aaaaaaaaaaaaaaaa\n---\nbody');
  fs.writeFileSync(path.join(memoryDir, 'project_b.md'), '---\nname: b\nfingerprint: bbbbbbbbbbbbbbbb\n---\nbody');
  fs.writeFileSync(path.join(memoryDir, 'ignored.md'),   '---\nname: x\nfingerprint: xxxxxxxxxxxxxxxx\n---');
  const aPath = path.join(memoryDir, 'project_a.md');
  const bPath = path.join(memoryDir, 'project_b.md');
  const now = Date.now();
  fs.utimesSync(aPath, new Date(now - 10000), new Date(now - 10000));
  fs.utimesSync(bPath, new Date(now), new Date(now));

  try {
    const recent = readRecentFingerprints(memoryDir, 5);
    assert.equal(recent.length, 2, 'only project_*.md files');
    assert.equal(recent[0].fingerprint, 'bbbbbbbbbbbbbbbb', 'newer first');
    assert.equal(recent[1].fingerprint, 'aaaaaaaaaaaaaaaa');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('getLatestSnapshotForCwd finds most recent', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-latest-'));
  const fakeCwd = '/tmp/ctx-latest-project';
  const config  = loadDefaults();
  config.snapshot = { memory_dir: path.join(tmpBase, 'memory'), auto_index_update: false };
  fs.mkdirSync(path.join(tmpBase, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpBase, 'memory', 'project_only.md'),
    '---\nname: only\nfingerprint: 1111222233334444\n---\nbody'
  );

  try {
    const latest = getLatestSnapshotForCwd(fakeCwd, config);
    assert.ok(latest, 'found');
    assert.equal(latest.fingerprint, '1111222233334444');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('writeSnapshot emits parent and categories in frontmatter', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-parent-'));
  const fakeCwd = '/tmp/ctx-parent';
  const config  = loadDefaults();
  config.snapshot = {
    memory_dir: path.join(tmpBase, 'memory'),
    auto_index_update: true,
    dedup_window_n: 0,
  };

  try {
    const entries  = parseJSONL(FIXTURE);
    const analysis = analyzeEntries(entries, config);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, config);
    const strategy = buildStrategy(analysis, decision, config);

    const first = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, sessionId: 'sid', modelId: 'claude-opus-4-7', trigger: 'manual',
    });
    const firstContent = fs.readFileSync(first.outPath, 'utf8');
    assert.match(firstContent, /categories: \[/);
    assert.doesNotMatch(firstContent, /^parent:/m, 'no parent for first');

    const second = writeSnapshot(analysis, decision, strategy, {
      cwd: fakeCwd, config, customName: 'different', sessionId: 'sid2', modelId: 'claude-opus-4-7', trigger: 'manual',
    });
    const secondContent = fs.readFileSync(second.outPath, 'utf8');
    assert.match(secondContent, new RegExp(`parent: ${path.basename(first.outPath)}`));
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('rewriteIndex removes only project_* lines in the removed set', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-idx-'));
  const idx = path.join(tmpBase, 'MEMORY.md');
  fs.writeFileSync(idx, [
    '# My memory',
    '',
    '- [project_old](project_old.md) — old',
    '- [project_keep](project_keep.md) — keep',
    '- [user note](notes.md) — hand-written',
    '',
  ].join('\n'));

  try {
    const res = rewriteIndex(idx, ['project_old.md']);
    assert.equal(res.removed, 1);
    const after = fs.readFileSync(idx, 'utf8');
    assert.doesNotMatch(after, /project_old/);
    assert.match(after, /project_keep/);
    assert.match(after, /user note/, 'hand-written lines preserved');
    assert.match(after, /# My memory/, 'headers preserved');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
