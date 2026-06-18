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

function postToolUseBody() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'hooks.js'), 'utf8');
  const start = src.indexOf('async function handlePostToolUse');
  const end = src.indexOf('function handleUserPromptSubmit');
  assert.ok(start >= 0, 'handlePostToolUse exists');
  assert.ok(end > start, 'handleUserPromptSubmit follows handlePostToolUse');
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

function toolNamesReferencedByPostToolHook() {
  const body = postToolUseBody();
  const names = new Set();
  for (const m of body.matchAll(/toolName\s*===\s*['"]([^'"]+)['"]/g)) {
    names.add(m[1]);
  }
  return names;
}

function pluginMatchers(eventName) {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const groups = plugin?.hooks?.[eventName] || [];
  return new Set(groups.map(g => g.matcher || '*'));
}

test('plugin runtime namespace is short and command filenames are not double-prefixed', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'ctx');

  const commandsDir = path.join(ROOT, 'commands');
  const commandNames = fs.readdirSync(commandsDir).filter(name => name.endsWith('.md'));
  assert.ok(commandNames.length > 0, 'commands are packaged');
  assert.deepEqual(commandNames.filter(name => name.startsWith('ctx-')), []);
  assert.ok(commandNames.includes('version.md'), 'expected /ctx:version command source');
  assert.ok(commandNames.includes('snapshot.md'), 'expected /ctx:snapshot command source');
  assert.ok(commandNames.includes('compact.md'), 'expected /ctx:compact command source');
});

test('marketplace plugin entry name matches plugin.json name (Claude Code requires identity)', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = marketplace.plugins.find(p => p.source === './');
  assert.ok(entry, 'self-hosted plugin entry present in marketplace');
  // Slash namespace + MCP prefix derive from plugin.json name; install handle derives
  // from the marketplace entry name. They MUST be identical or install resolution breaks.
  assert.equal(entry.name, plugin.name);
  assert.equal(entry.name, 'ctx');
});

test('plugin PreToolUse manifest reaches every tool-specific pre-tool branch', () => {
  const referenced = toolNamesReferencedByPreToolHook();
  const matchers = pluginMatchers('PreToolUse');

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

test('plugin PostToolUse manifest reaches every tool-specific post-tool branch', () => {
  const referenced = toolNamesReferencedByPostToolHook();
  const matchers = pluginMatchers('PostToolUse');

  assert.ok(referenced.has('Read'), 'sentinel: Read post-tool branch is discovered');
  assert.ok(referenced.has('Bash'), 'sentinel: Bash post-tool branch is discovered');

  if (matchers.has('*')) return;
  const missing = [...referenced].filter(name => !matchers.has(name));
  assert.deepEqual(
    missing,
    [],
    `plugin.json PostToolUse matchers do not reach hook branches for: ${missing.join(', ')}`,
  );
});
