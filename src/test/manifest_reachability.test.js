'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..', '..');

function preToolUseBody() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'hooks.js'), 'utf8');
  const start = src.indexOf('function handlePreToolUse');
  const end = src.indexOf('async function handlePostToolUse');
  assert.ok(start >= 0, 'handlePreToolUse exists');
  assert.ok(end > start, 'handlePostToolUse follows handlePreToolUse');
  return src.slice(start, end);
}

function toolNamesReferencedByPreToolHook() {
  const body = preToolUseBody();
  const names = new Set();
  for (const m of body.matchAll(/input\.tool_name\s*===\s*['"]([^'"]+)['"]/g)) {
    names.add(m[1]);
  }
  return names;
}

function pluginPreToolMatchers() {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const groups = plugin?.hooks?.PreToolUse || [];
  return new Set(groups.map(g => g.matcher || '*'));
}

test('plugin PreToolUse manifest reaches every tool-specific pre-tool branch', () => {
  const referenced = toolNamesReferencedByPreToolHook();
  const matchers = pluginPreToolMatchers();

  assert.ok(referenced.has('Read'), 'sentinel: Read pre-tool branch is discovered');
  assert.ok(referenced.has('Bash'), 'sentinel: Bash pre-tool branch is discovered');

  if (matchers.has('*')) return;
  const missing = [...referenced].filter(name => !matchers.has(name));
  assert.deepEqual(
    missing,
    [],
    `plugin.json PreToolUse matchers do not reach hook branches for: ${missing.join(', ')}`,
  );
});
