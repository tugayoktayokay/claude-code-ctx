'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { generateReport } = require('../report.js');
const { loadDefaults } = require('../config.js');

test('generateReport produces a valid self-contained HTML document', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-rep-'));
  const memoryDir = path.join(tmp, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, 'project_x.md'),
    '---\nname: x\ntrigger: manual\ncategories: [api]\nfingerprint: aaaaaaaaaaaaaaaa\n---\nbody'
  );
  fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# Title\n## A\nbody');

  const config = loadDefaults();
  config.snapshot = { ...config.snapshot, memory_dir: memoryDir };

  try {
    const html = generateReport({ cwd: tmp, config, days: 30 });
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /<title>ctx report/);
    assert.match(html, /Snapshot timeline/);
    assert.match(html, /project_x\.md/);
    assert.doesNotMatch(html, /<script/i, 'no scripts — fully static');
    assert.doesNotMatch(html, /https?:\/\/(?!localhost)/, 'no external URLs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
