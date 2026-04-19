'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { parseSnapshotFacts, diffSnapshots } = require('../diff.js');

function writeSnap(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `---\nname: ${name}\n---\n${body}`);
  return p;
}

test('parseSnapshotFacts extracts files, decisions, failed attempts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-df-'));
  const p = writeSnap(tmp, 'project_a.md', [
    '**Modified files (3):**',
    '- a.ts (/x/a.ts)',
    '- b.ts (/x/b.ts)',
    '- c.ts (/x/c.ts)',
    '',
    '**Decisions made:**',
    '- use stripe webhook idempotency',
    '- migrate to prisma',
    '',
    '**Failed attempts / open questions:**',
    '- tried raw body after json middleware',
    '',
  ].join('\n'));

  try {
    const facts = parseSnapshotFacts(p);
    assert.deepEqual(facts.files.sort(), ['a.ts', 'b.ts', 'c.ts']);
    assert.equal(facts.decisions.length, 2);
    assert.equal(facts.failedAttempts.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('diffSnapshots returns added/removed/retained sets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-df2-'));
  const a = writeSnap(tmp, 'project_a.md', [
    '**Modified files (2):**',
    '- old.ts (/x/old.ts)',
    '- shared.ts (/x/shared.ts)',
    '',
    '**Decisions made:**',
    '- decision one',
    '',
  ].join('\n'));
  const b = writeSnap(tmp, 'project_b.md', [
    '**Modified files (2):**',
    '- shared.ts (/x/shared.ts)',
    '- new.ts (/x/new.ts)',
    '',
    '**Decisions made:**',
    '- decision one',
    '- decision two',
    '',
  ].join('\n'));

  try {
    const d = diffSnapshots(a, b);
    assert.deepEqual(d.files.added, ['new.ts']);
    assert.deepEqual(d.files.removed, ['old.ts']);
    assert.deepEqual(d.files.kept, ['shared.ts']);
    assert.equal(d.decisions.added.length, 1);
    assert.equal(d.decisions.removed.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
