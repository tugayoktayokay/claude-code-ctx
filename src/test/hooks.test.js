'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  handleSessionStart,
  handleStop,
  handlePreCompact,
  handlePostToolUse,
  handleUserPromptSubmit,
} = require('../hooks.js');
const { loadDefaults } = require('../config.js');
const { parseJSONL } = require('../session.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'demo-session.jsonl');

function tmpMemoryDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
}

function configWithDirs({ memoryDir, backupDir } = {}) {
  const cfg = loadDefaults();
  if (memoryDir) {
    cfg.snapshot = { ...cfg.snapshot, memory_dir: memoryDir, auto_index_update: true };
  }
  if (backupDir) {
    cfg.backup = { ...cfg.backup, dir: backupDir };
  }
  return cfg;
}

test('session-start: returns null output when restore_latest is false', () => {
  const cfg = configWithDirs();
  cfg.hooks.session_start.restore_latest = false;
  const res = handleSessionStart({ cwd: '/tmp/nope', source: 'startup' }, cfg);
  assert.equal(res.output, null);
});

test('session-start: skips when source=resume even with restore_latest on', () => {
  const cfg = configWithDirs();
  cfg.hooks.session_start.restore_latest = true;
  const res = handleSessionStart({ cwd: '/tmp/nope', source: 'resume' }, cfg);
  assert.equal(res.output, null);
});

test('session-start: emits additionalContext when snapshot exists', () => {
  const base = tmpMemoryDir();
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, 'project_recent.md'),
    '---\nname: recent\nfingerprint: abcabcabcabcabca\n---\nBody content here'
  );

  const cfg = configWithDirs({ memoryDir });
  cfg.hooks.session_start.restore_latest = true;
  const res = handleSessionStart({ cwd: '/tmp/x', source: 'startup' }, cfg);

  assert.ok(res.output);
  assert.equal(res.output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(res.output.hookSpecificOutput.additionalContext, /Restoring most recent snapshot/);
  assert.match(res.output.hookSpecificOutput.additionalContext, /Body content here/);

  fs.rmSync(base, { recursive: true, force: true });
});

test('session-start: truncates to max_bytes', () => {
  const base = tmpMemoryDir();
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const bigBody = 'A'.repeat(20000);
  fs.writeFileSync(
    path.join(memoryDir, 'project_big.md'),
    `---\nname: big\nfingerprint: 1111111111111111\n---\n${bigBody}`
  );

  const cfg = configWithDirs({ memoryDir });
  cfg.hooks.session_start.restore_latest = true;
  cfg.hooks.session_start.max_bytes = 1024;
  const res = handleSessionStart({ cwd: '/tmp/x', source: 'startup' }, cfg);

  assert.match(res.output.hookSpecificOutput.additionalContext, /\[truncated by ctx\]/);
  fs.rmSync(base, { recursive: true, force: true });
});

test('stop: respects stop_hook_active loop guard', async () => {
  const cfg = configWithDirs();
  const res = await handleStop({ cwd: '/tmp', stop_hook_active: true }, cfg);
  assert.equal(res.output, null);
  assert.equal(res.exitCode, 0);
});

test('stop: writes snapshot when level matches snapshot_on', async () => {
  const base = tmpMemoryDir();
  const memoryDir = path.join(base, 'memory');
  const cfg = configWithDirs({ memoryDir });
  cfg.hooks.stop.snapshot_on = ['critical', 'urgent', 'compact', 'watch', 'comfortable'];
  cfg.hooks.stop.backup_on   = [];

  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  const entries = parseJSONL(FIXTURE);
  pipeMock.runAnalyze = () => {
    const { analyzeEntries } = require('../analyzer.js');
    const { makeDecision }   = require('../decision.js');
    const { buildStrategy }  = require('../strategy.js');
    const analysis = analyzeEntries(entries, cfg);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, cfg);
    const strategy = buildStrategy(analysis, decision, cfg);
    return {
      entries,
      analysis,
      decision,
      strategy,
      modelId: 'claude-opus-4-7',
      sessionId: 'test-stop',
      session: { path: FIXTURE, entries },
      limits: { max: 200000, quality_ceiling: 200000 },
    };
  };

  try {
    const res = await handleStop({ cwd: '/tmp/stop-test' }, cfg);
    assert.equal(res.output, null);
    const entries2 = fs.readdirSync(memoryDir);
    const projectFiles = entries2.filter(n => n.startsWith('project_'));
    assert.ok(projectFiles.length >= 1, `expected snapshot file, got: ${entries2.join(',')}`);
  } finally {
    pipeMock.runAnalyze = original;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('pre-compact: returns tailored prompt; merges user input', () => {
  const cfg = configWithDirs();
  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  const entries = parseJSONL(FIXTURE);
  pipeMock.runAnalyze = () => {
    const { analyzeEntries } = require('../analyzer.js');
    const { makeDecision }   = require('../decision.js');
    const { buildStrategy }  = require('../strategy.js');
    const analysis = analyzeEntries(entries, cfg);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, cfg);
    const strategy = buildStrategy(analysis, decision, cfg);
    return {
      entries, analysis, decision, strategy,
      modelId: 'claude-opus-4-7', sessionId: 'x', session: { path: FIXTURE, entries },
      limits: { max: 200000, quality_ceiling: 200000 },
    };
  };

  try {
    const res = handlePreCompact({ cwd: '/tmp/x', custom_instructions: '' }, cfg);
    assert.ok(res.output);
    assert.equal(res.output.hookSpecificOutput.hookEventName, 'PreCompact');
    assert.match(res.output.hookSpecificOutput.additionalContext, /Compaction guidance/);
    assert.match(res.output.hookSpecificOutput.additionalContext, /hint context Claude sees/);

    const resWithUser = handlePreCompact({ cwd: '/tmp/x', custom_instructions: 'remember stripe webhook' }, cfg);
    assert.match(resWithUser.output.hookSpecificOutput.additionalContext, /focus: remember stripe webhook/);
  } finally {
    pipeMock.runAnalyze = original;
  }
});

test('post-tool-use: matches git commit trigger, ignores other commands', async () => {
  const base = tmpMemoryDir();
  const memoryDir = path.join(base, 'memory');
  const cfg = configWithDirs({ memoryDir });

  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  const entries = parseJSONL(FIXTURE);
  pipeMock.runAnalyze = () => {
    const { analyzeEntries } = require('../analyzer.js');
    const { makeDecision }   = require('../decision.js');
    const { buildStrategy }  = require('../strategy.js');
    const analysis = analyzeEntries(entries, cfg);
    const decision = makeDecision(analysis, { max: 200000, quality_ceiling: 200000 }, cfg);
    const strategy = buildStrategy(analysis, decision, cfg);
    return {
      entries, analysis, decision, strategy,
      modelId: 'claude-opus-4-7', sessionId: 'x', session: { path: FIXTURE, entries },
      limits: { max: 200000, quality_ceiling: 200000 },
    };
  };

  try {
    await handlePostToolUse({
      cwd: '/tmp/ptu', tool_name: 'Bash', tool_input: { command: 'ls -la' },
    }, cfg);
    assert.equal(fs.existsSync(memoryDir) && fs.readdirSync(memoryDir).length > 0, false, 'ls should not trigger');

    await handlePostToolUse({
      cwd: '/tmp/ptu2', tool_name: 'Bash', tool_input: { command: 'git commit -m "test"' },
    }, cfg);
    const memDir2 = cfg.snapshot.memory_dir;
    const files = fs.readdirSync(memDir2).filter(n => n.startsWith('project_'));
    assert.ok(files.length >= 1, 'git commit should trigger snapshot');
  } finally {
    pipeMock.runAnalyze = original;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('user-prompt-submit: silent when warn_on empty and auto_retrieve disabled', () => {
  const cfg = configWithDirs();
  cfg.hooks.user_prompt_submit.warn_on = [];
  cfg.hooks.user_prompt_submit.auto_retrieve = { enabled: false };
  const res = handleUserPromptSubmit({ cwd: '/tmp/x', prompt: 'hi' }, cfg);
  assert.equal(res.output, null);
});

test('user-prompt-submit warn_on heavy injects tool-size summary with hint', () => {
  const cfg = configWithDirs();
  cfg.hooks.user_prompt_submit = { warn_on: ['heavy'], heavy_threshold_bytes: 5000, auto_retrieve: { enabled: false } };

  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  pipeMock.runAnalyze = () => ({
    analysis: {
      userMessages: 3,
      largeOutputs: [
        { tool: 'Bash', size: 48000, preview: '...', hint: 'pipe through head -100 (47KB now)' },
        { tool: 'Read', size: 22000, preview: '...', hint: 'pass offset + limit (21KB now)' },
      ],
    },
    decision: { metrics: { contextPct: 30, contextTokens: 60000 }, level: 'watch' },
    strategy: {},
    session: {}, entries: [],
    modelId: 'x', sessionId: 'x', limits: {},
  });

  try {
    const res = handleUserPromptSubmit({ cwd: '/tmp/h', prompt: 'continue' }, cfg);
    assert.ok(res.output);
    assert.match(String(res.output), /heavy tool outputs/);
    assert.match(String(res.output), /Bash/);
    assert.match(String(res.output), /hint:/);
  } finally {
    pipeMock.runAnalyze = original;
  }
});

test('user-prompt-submit auto-retrieves past snapshot on first prompt', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-auto-'));
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const now = Date.now();
  const snapFile = path.join(memoryDir, 'project_stripe.md');
  fs.writeFileSync(snapFile, [
    '---',
    'name: stripe',
    'categories: [stripe, api]',
    'fingerprint: stripeaaaaaaaaaa',
    '---',
    'stripe webhook idempotency header',
  ].join('\n'));
  fs.utimesSync(snapFile, new Date(now - 86_400_000), new Date(now - 86_400_000));

  const cfg = configWithDirs({ memoryDir });
  cfg.hooks.user_prompt_submit = {
    warn_on: [],
    auto_retrieve: { enabled: true, max_turns: 2, min_score: 0.01, scopes: ['project'] },
  };

  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  pipeMock.runAnalyze = () => ({
    analysis: { userMessages: 1, messageCount: 1, filesModified: new Set(), decisions: [], failedAttempts: [], activeCategories: new Map(), lastNMessages: [] },
    decision: { metrics: { contextPct: 10, contextTokens: 1000 }, level: 'comfortable' },
    strategy: { compactPrompt: '/compact x' },
    session: { path: '/tmp/fake', entries: [] },
    entries: [],
    modelId: 'x', sessionId: 'x', limits: {},
  });

  try {
    const res = handleUserPromptSubmit({ cwd: '/tmp/auto-x', session_id: 'x', prompt: 'stripe webhook ekleyelim' }, cfg);
    assert.ok(res.output, 'output produced');
    assert.ok(String(res.output).includes('project_stripe.md'), 'matched snapshot referenced');
  } finally {
    pipeMock.runAnalyze = original;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
