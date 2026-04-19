'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { walkMarkdown, expandRoots, collectNotesCandidates } = require('../notes.js');

function mk(tmp, files) {
  for (const { rel, content, size } of files) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content || 'x'.repeat(size || 10));
  }
}

test('walkMarkdown returns .md files, excludes patterns, respects size', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-notes-'));
  mk(tmp, [
    { rel: 'a.md', content: 'alpha' },
    { rel: 'sub/b.md', content: 'beta' },
    { rel: 'node_modules/pkg/c.md', content: 'excluded' },
    { rel: 'big.md', size: 2_000_000 },
    { rel: 'not-md.txt', content: 'skip' },
  ]);
  try {
    const found = walkMarkdown(tmp, {
      exclude: ['node_modules'],
      maxBytes: 512 * 1024,
      followSymlinks: false,
    });
    const names = found.map(f => path.basename(f.path)).sort();
    assert.deepEqual(names, ['a.md', 'b.md'], `got ${names.join(',')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('expandRoots resolves ~ to homedir', () => {
  const roots = expandRoots(['~/somewhere', '/abs/path']);
  assert.match(roots[0], /^\/(?!~)/);
  assert.equal(roots[1], '/abs/path');
});

test('collectNotesCandidates returns zero when roots empty', () => {
  const out = collectNotesCandidates([], { notes: { exclude: [], max_file_kb: 512, follow_symlinks: false } });
  assert.equal(out.length, 0);
});
