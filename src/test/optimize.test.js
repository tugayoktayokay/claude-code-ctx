'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {
  splitSections,
  scanClaudeMd,
  scanSkills,
  aggregateToolUsage,
  aggregateSkillUsage,
  topHeavyOutputs,
} = require('../optimize.js');

test('splitSections groups by heading', () => {
  const md = [
    '# Main title',
    'intro line',
    '',
    '## Section A',
    'a body',
    'more a',
    '',
    '## Section B',
    'b body',
  ].join('\n');
  const secs = splitSections(md);
  assert.equal(secs.length, 3);
  assert.equal(secs[0].heading, 'Main title');
  assert.equal(secs[1].heading, 'Section A');
  assert.equal(secs[2].heading, 'Section B');
  assert.ok(secs[1].bytes > 0);
});

test('splitSections handles empty input', () => {
  assert.deepEqual(splitSections(''), []);
  assert.deepEqual(splitSections(null), []);
});

test('scanClaudeMd reports bytes and top sections from cwd CLAUDE.md', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-bloat-'));
  fs.writeFileSync(
    path.join(tmp, 'CLAUDE.md'),
    [
      '# Project',
      '## Small',
      'a',
      '## Large',
      'b'.repeat(500),
      '## Medium',
      'c'.repeat(100),
    ].join('\n')
  );
  try {
    const rep = scanClaudeMd(tmp);
    const project = rep.find(r => r.path.endsWith('CLAUDE.md') && r.path.startsWith(tmp));
    assert.ok(project, 'project CLAUDE.md detected');
    assert.ok(project.bytes > 500);
    assert.equal(project.topSections[0].heading, 'Large');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('aggregateToolUsage sums tool_use blocks across session entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-usage-'));
  const sessionPath = path.join(tmp, 's1.jsonl');
  const entries = [
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Read',  input: {} },
      { type: 'tool_use', name: 'Read',  input: {} },
      { type: 'tool_use', name: 'Bash',  input: { command: 'ls' } },
    ] } },
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Edit', input: {} },
    ] } },
  ];
  fs.writeFileSync(sessionPath, entries.map(e => JSON.stringify(e)).join('\n'));

  try {
    const sessions = [{ path: sessionPath, mtime: Date.now() }];
    const { ranked, scanned } = aggregateToolUsage(sessions);
    assert.equal(scanned, 1);
    assert.equal(ranked[0].name, 'Read');
    assert.equal(ranked[0].count, 2);
    assert.ok(ranked.find(r => r.name === 'Bash'));
    assert.ok(ranked.find(r => r.name === 'Edit'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('aggregateSkillUsage counts Skill tool invocations by skill key', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-skills-'));
  const sessionPath = path.join(tmp, 's.jsonl');
  const entries = [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } },
      { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } },
      { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:writing-plans' } },
      { type: 'tool_use', name: 'Read',  input: {} },
    ] } },
  ];
  fs.writeFileSync(sessionPath, entries.map(e => JSON.stringify(e)).join('\n'));

  try {
    const sessions = [{ path: sessionPath, mtime: Date.now() }];
    const { ranked } = aggregateSkillUsage(sessions);
    assert.equal(ranked[0].name, 'superpowers:brainstorming');
    assert.equal(ranked[0].count, 2);
    assert.equal(ranked[1].count, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('topHeavyOutputs sorts by size desc and respects limit', () => {
  const analysis = {
    largeOutputs: [
      { tool: 'a', size: 100, preview: 'x' },
      { tool: 'b', size: 500, preview: 'y' },
      { tool: 'c', size: 250, preview: 'z' },
    ],
  };
  const top = topHeavyOutputs(analysis, 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].tool, 'b');
  assert.equal(top[1].tool, 'c');
});

test('topHeavyOutputs handles missing field gracefully', () => {
  assert.deepEqual(topHeavyOutputs({}), []);
  assert.deepEqual(topHeavyOutputs(null), []);
});

test('scanSkills returns array (may be empty on this host)', () => {
  const out = scanSkills();
  assert.ok(Array.isArray(out));
});
