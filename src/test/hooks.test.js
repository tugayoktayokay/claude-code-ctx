'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// File-level HOME isolation. logHook resolves `os.homedir()` at runtime, so
// without this every hook handler call in this file would append to the real
// `~/.config/ctx/hooks.log` with `session=-` and pollute `ctx metrics` output.
const FILE_TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-test-home-'));
const ORIG_HOME = process.env.HOME;
process.env.HOME = FILE_TMP_HOME;
process.on('exit', () => {
  process.env.HOME = ORIG_HOME;
  try { fs.rmSync(FILE_TMP_HOME, { recursive: true, force: true }); } catch {}
});

const {
  handleSessionStart,
  handleStop,
  handlePreCompact,
  handlePreToolUse,
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

test('stop: auto-copies tailored /compact prompt to clipboard at threshold', async () => {
  const cfg = configWithDirs();
  cfg.hooks.stop = { snapshot_on: [], backup_on: [], clipboard_compact_on: ['urgent', 'critical'] };

  const pipeMock = require('../pipeline.js');
  const original = pipeMock.runAnalyze;
  const copied = [];
  const strategyMod = require('../strategy.js');
  const origCopy = strategyMod.copyToClipboard;
  strategyMod.copyToClipboard = (text) => { copied.push(text); return true; };

  pipeMock.runAnalyze = () => ({
    analysis: { userMessages: 5 },
    decision: { metrics: { contextPct: 80, contextTokens: 160000 }, level: 'urgent' },
    strategy: { compactPrompt: '/compact focus on X — keep: files A,B' },
    session: { path: '/tmp/s', entries: [{}] },
    entries: [{}],
    modelId: 'x', sessionId: 's', limits: {},
  });

  try {
    await handleStop({ cwd: '/tmp/clip' }, cfg);
    assert.equal(copied.length, 1, 'copyToClipboard invoked once');
    assert.match(copied[0], /\/compact focus/);
  } finally {
    pipeMock.runAnalyze = original;
    strategyMod.copyToClipboard = origCopy;
  }
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

test('pre-tool-use denies unbounded find from root with a reason', () => {
  const cfg = configWithDirs();
  cfg.hooks.pre_tool_use = {
    enabled: true,
    default_mode: 'deny',
    rules: [
      { tool: 'Bash', match: '^\\s*find\\s+[/~]', reason: 'unbounded traversal' },
    ],
  };
  const res = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'find / -name test' } }, cfg);
  assert.ok(res.output);
  const out = res.output.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /unbounded traversal/);
});

test('pre-tool-use passes through when no rule matches', () => {
  const cfg = configWithDirs();
  cfg.hooks.pre_tool_use = {
    enabled: true,
    default_mode: 'deny',
    rules: [{ tool: 'Bash', match: '^\\s*find\\s+[/~]', reason: 'x' }],
  };
  const res = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls -la /tmp' } }, cfg);
  assert.equal(res.output, null);
});

test('pre-tool-use disabled returns null regardless of rules', () => {
  const cfg = configWithDirs();
  cfg.hooks.pre_tool_use = {
    enabled: false,
    rules: [{ tool: 'Bash', match: '.*', reason: 'x' }],
  };
  const res = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'anything' } }, cfg);
  assert.equal(res.output, null);
});

test('pre-tool-use ask mode vs deny mode per rule', () => {
  const cfg = configWithDirs();
  cfg.hooks.pre_tool_use = {
    enabled: true,
    default_mode: 'ask',
    rules: [
      { tool: 'Bash', match: '^\\s*ls\\s+-R', reason: 'recursive', mode: 'deny' },
      { tool: 'Bash', match: '^\\s*tree',       reason: 'deep tree' },
    ],
  };
  const deny = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls -R /' } }, cfg);
  assert.equal(deny.output.hookSpecificOutput.permissionDecision, 'deny');
  const ask  = handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'tree' } }, cfg);
  assert.equal(ask.output.hookSpecificOutput.permissionDecision, 'ask');
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

test('pre-tool-use writes structured single-line log entry', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-log-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const cfg = configWithDirs();
    cfg.hooks.pre_tool_use = {
      enabled: true,
      default_mode: 'ask',
      rules: [
        { tool: 'Bash', match: '^\\s*find\\s+[/~]', mode: 'deny', reason: 'use ctx_shell' },
      ],
    };
    const res = handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'find / -name testfile' } },
      cfg
    );
    assert.equal(res.output.hookSpecificOutput.permissionDecision, 'deny');

    const logPath = path.join(tmpHome, '.config', 'ctx', 'hooks.log');
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop();

    // Structured format: <ISO8601> pre_tool session=X action=X tool=Y pattern="..." cmd_head="..." reason="..."
    assert.match(log, /^\S+Z pre_tool session=\S+ action=deny tool=Bash pattern=".+" cmd_head=".+" reason=".+"$/,
      `log line did not match format: ${log}`);
    assert.ok(log.includes('cmd_head="find / -name testfile"'), `cmd_head missing: ${log}`);
    assert.ok(log.includes('reason="use ctx_shell"'), `reason missing: ${log}`);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('pre-tool-use log escapes embedded double quotes and newlines in cmd_head', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-log-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const cfg = configWithDirs();
    cfg.hooks.pre_tool_use = {
      enabled: true,
      default_mode: 'ask',
      rules: [
        { tool: 'Bash', match: '^\\s*find\\s', mode: 'deny', reason: 'heavy' },
      ],
    };
    handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'find / -name "x"\nfoo' } },
      cfg
    );
    const logPath = path.join(tmpHome, '.config', 'ctx', 'hooks.log');
    const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').pop();
    // Inner double quote becomes \"
    assert.ok(log.includes('cmd_head="find / -name \\"x\\" foo"'),
      `expected escaped quotes + newline→space in cmd_head: ${log}`);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('pre_tool log line includes session=<id> when provided', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const hooks = require('../hooks.js');
    const config = {
      hooks: {
        pre_tool_use: {
          enabled: true,
          default_mode: 'ask',
          rules: [{ tool: 'Bash', match: '^grep -r', reason: 'test' }],
        },
      },
    };
    await hooks.handlePreToolUse(
      { session_id: 'abc123', tool_name: 'Bash', tool_input: { command: 'grep -r foo .' } },
      config,
    );
    const logPath = path.join(tmpHome, '.config', 'ctx', 'hooks.log');
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /pre_tool session=abc123 action=ask tool=Bash/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('pre_tool log line writes session=- when session_id missing', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const hooks = require('../hooks.js');
    const config = {
      hooks: {
        pre_tool_use: {
          enabled: true,
          default_mode: 'ask',
          rules: [{ tool: 'Bash', match: '^grep -r', reason: 'test' }],
        },
      },
    };
    await hooks.handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'grep -r foo .' } },
      config,
    );
    const content = fs.readFileSync(path.join(tmpHome, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(content, /pre_tool session=- action=ask/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('post_tool Bash uses stdout+stderr length as size_bytes (real Claude Code payload shape)', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const hooks = require('../hooks.js');
    const config = { hooks: { post_tool_use: { triggers: [] } } };
    await hooks.handlePostToolUse(
      {
        session_id: 'xyz',
        tool_name: 'Bash',
        tool_input: { command: 'grep -r foo' },
        tool_response: {
          stdout: 'a'.repeat(4000),
          stderr: 'b'.repeat(1000),
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
        },
      },
      config,
    );
    const content = fs.readFileSync(path.join(tmpHome, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(content, /post_tool session=xyz tool=Bash cmd_head="grep -r foo" exit=0 size_bytes=5000/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('post_tool Bash with interrupted=true logs exit=124', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const hooks = require('../hooks.js');
    const config = { hooks: { post_tool_use: { triggers: [] } } };
    await hooks.handlePostToolUse(
      {
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 999' },
        tool_response: { stdout: '', stderr: '', interrupted: true },
      },
      config,
    );
    const content = fs.readFileSync(path.join(tmpHome, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(content, /post_tool session=s tool=Bash cmd_head="sleep 999" exit=124 size_bytes=0/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('post_tool logs non-Bash tool with args_head', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const hooks = require('../hooks.js');
    const config = { hooks: { post_tool_use: { triggers: [] } } };
    await hooks.handlePostToolUse(
      {
        session_id: 'xyz',
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/x.txt' },
        tool_response: { content: 'hi' },
      },
      config,
    );
    const content = fs.readFileSync(path.join(tmpHome, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(content, /post_tool session=xyz tool=Read cmd_head=".*x\.txt.*" exit=0 size_bytes=2/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('new Bash rules: rg/grep -R/egrep/awk/sed/wc/find coverage', () => {
  const { loadConfig } = require('../config.js');
  const config = loadConfig();
  const rules = config.hooks.pre_tool_use.rules;

  const testCases = [
    ['rg -r foo src',                  true,  'rg recursive'],
    ['rg --recursive foo src',         true,  'rg --recursive'],
    ['rg foo src',                     false, 'rg bounded (default head_limit)'],
    ['grep -R foo src',                true,  'grep -R capital'],
    ['egrep -r foo src',               true,  'egrep recursive'],
    [`awk '{print}' file.txt`,         true,  'awk unbounded'],
    [`sed 's/a/b/' file.txt`,          true,  'sed unbounded'],
    ['wc -l src/**/*.js',              true,  'wc -l glob'],
    ['find . -name x -print',          true,  'find without -maxdepth'],
    ['find . -maxdepth 3 -name x -print', false, 'find with -maxdepth (first)'],
    ['find . -name x -maxdepth 3 -print', false, 'find with -maxdepth (middle)'],
  ];

  for (const [cmd, expectMatch, label] of testCases) {
    const matched = rules.some(r => {
      if (r.tool !== 'Bash') return false;
      try { return new RegExp(r.match).test(cmd); } catch { return false; }
    });
    assert.equal(matched, expectMatch, `[${label}] "${cmd}" expected ${expectMatch ? 'match' : 'no-match'}`);
  }
});

test('regression: hook handler calls without explicit HOME override do not pollute real log', () => {
  const cfg = configWithDirs();
  cfg.hooks.pre_tool_use = {
    enabled: true,
    default_mode: 'deny',
    rules: [{ tool: 'Bash', match: '^regression-marker', reason: 'isolation check' }],
  };
  handlePreToolUse(
    { tool_name: 'Bash', tool_input: { command: 'regression-marker xyz' } },
    cfg,
  );

  const tmpLog = path.join(FILE_TMP_HOME, '.config', 'ctx', 'hooks.log');
  assert.ok(fs.existsSync(tmpLog), 'log written under FILE_TMP_HOME (file-level isolation works)');
  const tmpContent = fs.readFileSync(tmpLog, 'utf8');
  assert.match(tmpContent, /cmd_head="regression-marker xyz"/);

  if (ORIG_HOME) {
    const realLog = path.join(ORIG_HOME, '.config', 'ctx', 'hooks.log');
    if (fs.existsSync(realLog)) {
      const realContent = fs.readFileSync(realLog, 'utf8');
      assert.equal(realContent.includes('regression-marker xyz'), false,
        'regression marker must NOT leak into real ~/.config/ctx/hooks.log');
    }
  }
});

test('post_tool with missing tool_response logs exit=- size_bytes=0', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-hooks-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const hooks = require('../hooks.js');
    const config = { hooks: { post_tool_use: { triggers: [] } } };
    await hooks.handlePostToolUse(
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'echo hi' } },
      config,
    );
    const content = fs.readFileSync(path.join(tmpHome, '.config', 'ctx', 'hooks.log'), 'utf8');
    assert.match(content, /post_tool session=s tool=Bash cmd_head="echo hi" exit=- size_bytes=0/);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('PreToolUse Read: second identical Read triggers dedup deny + recall hint', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-hook-'));
  const targetFile = path.join(tmp, 'CLAUDE.md');
  const content = 'a'.repeat(2000);
  fs.writeFileSync(targetFile, content);
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: true, min_dedup_size_bytes: 1024, recency_window_turns: 30, ttl_hours: 24 };

    const sid = 'hook-sid-1';
    const wm = require('../working_memory.js');
    wm.recordRead(sid, targetFile, content, { mtime: 'A' });

    const res = handlePreToolUse(
      { session_id: sid, tool_name: 'Read', tool_input: { file_path: targetFile } },
      cfg,
    );

    assert.equal(res.output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(
      res.output.hookSpecificOutput.permissionDecisionReason,
      /working_memory.*Already read.*ctx_recall_read/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Read: first Read passes through (no prior record)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-hook-'));
  const targetFile = path.join(tmp, 'README.md');
  fs.writeFileSync(targetFile, 'x'.repeat(2000));
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: true, min_dedup_size_bytes: 1024, recency_window_turns: 30, ttl_hours: 24 };

    const res = handlePreToolUse(
      { session_id: 'sid-fresh', tool_name: 'Read', tool_input: { file_path: targetFile } },
      cfg,
    );

    assert.equal(res.output, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});

test('PreToolUse Read: disabled flag bypasses dedup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wm-hook-'));
  const targetFile = path.join(tmp, 'CLAUDE.md');
  const content = 'a'.repeat(2000);
  fs.writeFileSync(targetFile, content);
  process.env.CTX_WORKING_MEMORY_DIR = path.join(tmp, 'wm');

  try {
    const cfg = configWithDirs();
    cfg.working_memory = { enabled: false };

    const wm = require('../working_memory.js');
    wm.recordRead('sid-off', targetFile, content, { mtime: 'A' });

    const res = handlePreToolUse(
      { session_id: 'sid-off', tool_name: 'Read', tool_input: { file_path: targetFile } },
      cfg,
    );

    assert.equal(res.output, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.CTX_WORKING_MEMORY_DIR;
  }
});
