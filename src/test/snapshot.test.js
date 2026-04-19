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
const { writeSnapshot, buildMarkdown, slugify } = require('../snapshot.js');

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
  assert.match(md, /Değiştirilen dosyalar/);
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
    });
    assert.notEqual(second.filename, result.filename, 'second snapshot gets unique name');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    if (originalHome) process.env.HOME = originalHome;
  }
});
