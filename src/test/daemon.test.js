'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const { gitHead } = require('../daemon.js');

test('gitHead returns null for non-git dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-nogit-'));
  try {
    assert.equal(gitHead(tmp), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gitHead returns HEAD sha for initialized repo', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-git-'));
  try {
    const run = (...args) => execFileSync('git', args, {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' },
    });
    run('init', '-q');
    run('commit', '-q', '--allow-empty', '-m', 'seed');
    const head = gitHead(tmp);
    assert.ok(head && /^[0-9a-f]{40}$/.test(head), `expected sha, got ${head}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
