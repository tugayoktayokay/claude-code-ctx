'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRepoMap, symbolsFor } = require('../repomap.js');

test('symbolsFor extracts common JS symbols', () => {
  const syms = symbolsFor(`
    function alpha() {}
    class Beta {}
    const gamma = () => {};
    module.exports = { alpha, Beta, gamma };
  `, '.js');
  assert.ok(syms.includes('alpha'));
  assert.ok(syms.includes('Beta'));
  assert.ok(syms.includes('gamma'));
});

test('buildRepoMap walks small repo and returns relative paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-repomap-'));
  try {
    fs.writeFileSync(path.join(tmp, 'a.js'), 'function run() {}');
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'node_modules', 'skip.js'), 'function skip() {}');
    const map = buildRepoMap({ cwd: tmp, limit: 10 });
    assert.equal(map.files, 1);
    assert.equal(map.items[0].path, 'a.js');
    assert.ok(map.items[0].symbols.includes('run'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
