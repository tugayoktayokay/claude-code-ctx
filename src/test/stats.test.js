'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { aggregate } = require('../stats.js');

function mk(dir, name, { ageDays, categories = [], trigger = 'manual' }) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, [
    '---',
    `name: ${name}`,
    `trigger: ${trigger}`,
    `categories: [${categories.join(', ')}]`,
    '---',
    'body',
  ].join('\n'));
  const t = new Date(Date.now() - ageDays * 86_400_000);
  fs.utimesSync(full, t, t);
}

test('aggregate counts snapshots, triggers, categories in a window', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-st-'));
  mk(tmp, 'project_a.md', { ageDays: 2,  categories: ['api', 'auth'], trigger: 'commit' });
  mk(tmp, 'project_b.md', { ageDays: 4,  categories: ['api'],          trigger: 'stop:urgent' });
  mk(tmp, 'project_c.md', { ageDays: 20, categories: ['stripe'],       trigger: 'manual' });
  try {
    const s7  = aggregate(tmp, { rangeDays: 7 });
    assert.equal(s7.snapshots, 2);
    assert.deepEqual(Object.keys(s7.triggers).sort(), ['commit', 'stop:urgent']);
    assert.equal(s7.topCategories[0].name, 'api');

    const s30 = aggregate(tmp, { rangeDays: 30 });
    assert.equal(s30.snapshots, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
