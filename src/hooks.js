'use strict';

const fs       = require('fs');
const path     = require('path');
const pipeline = require('./pipeline.js');
const snapshotMod = require('./snapshot.js');
const backup   = require('./backup.js');
const { fmtK } = require('./decision.js');

const { getLatestSnapshotForCwd } = snapshotMod;

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function safeParse(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function logHook(config, line) {
  try {
    const os = require('os');
    const logPath = path.join(os.homedir(), '.config', 'ctx', 'hooks.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function handleSessionStart(input, config) {
  const cwd = input.cwd || process.cwd();
  const source = input.source || 'startup';

  if (!config?.hooks?.session_start?.restore_latest) {
    return { output: null, exitCode: 0 };
  }

  if (source === 'resume') {
    return { output: null, exitCode: 0 };
  }

  const latest = getLatestSnapshotForCwd(cwd, config);
  if (!latest) return { output: null, exitCode: 0 };

  const maxBytes = config.hooks.session_start.max_bytes ?? 8192;
  let content;
  try { content = fs.readFileSync(latest.path, 'utf8'); } catch { return { output: null, exitCode: 0 }; }

  let trimmed = content;
  if (trimmed.length > maxBytes) {
    trimmed = trimmed.slice(0, maxBytes) + '\n\n...[truncated by ctx]';
  }

  const header = `[ctx] Restoring most recent snapshot from prior session (${path.basename(latest.path)}):\n\n`;

  logHook(config, `session-start restored ${path.basename(latest.path)} (${trimmed.length} bytes)`);

  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: header + trimmed,
      },
    },
    exitCode: 0,
  };
}

async function handleStop(input, config) {
  if (input.stop_hook_active) {
    return { output: null, exitCode: 0 };
  }
  const cwd = input.cwd || process.cwd();

  let pipe;
  try { pipe = pipeline.runAnalyze({ cwd, sessionId: input.session_id, config }); } catch { return { output: null, exitCode: 0 }; }
  if (!pipe || !pipe.entries.length) return { output: null, exitCode: 0 };

  const snapshotOn = config?.hooks?.stop?.snapshot_on || [];
  const backupOn   = config?.hooks?.stop?.backup_on   || [];

  const tasks = [];
  if (snapshotOn.includes(pipe.decision.level)) {
    tasks.push(() => {
      const result = snapshotMod.writeSnapshot(pipe.analysis, pipe.decision, pipe.strategy, {
        cwd,
        config,
        sessionId: pipe.sessionId,
        modelId: pipe.modelId,
        trigger: `stop:${pipe.decision.level}`,
      });
      logHook(config, `stop snapshot level=${pipe.decision.level} dedup=${result.dedupHit} file=${result.filename || '-'}`);
      return result;
    });
  }

  if (backupOn.includes(pipe.decision.level) && pipe.session?.path) {
    tasks.push(async () => {
      try {
        const result = await backup.writeBackup(pipe.session.path, cwd, pipe.sessionId, config);
        logHook(config, `stop backup level=${pipe.decision.level} path=${result.path} size=${result.size}`);
        return result;
      } catch (err) {
        logHook(config, `stop backup ERROR: ${err.message}`);
        return null;
      }
    });
  }

  for (const t of tasks) {
    try { await t(); } catch (err) { logHook(config, `stop task error: ${err.message}`); }
  }

  return { output: null, exitCode: 0 };
}

function handlePreCompact(input, config) {
  const cwd = input.cwd || process.cwd();
  const pc = config?.hooks?.pre_compact || {};
  const enabled = pc.inject_guidance ?? pc.replace_prompt;
  if (!enabled) {
    return { output: null, exitCode: 0 };
  }

  let pipe;
  try { pipe = pipeline.runAnalyze({ cwd, sessionId: input.session_id, config }); } catch { return { output: null, exitCode: 0 }; }
  if (!pipe) return { output: null, exitCode: 0 };

  const userInput = (input.custom_instructions || '').trim();
  let guidance = pipe.strategy.compactPrompt;
  if (userInput && pc.respect_user_input !== false) {
    guidance = `focus: ${userInput}; ${pipe.strategy.compactPrompt.replace(/^\/compact\s+/, '')}`;
  }

  logHook(config, `pre-compact level=${pipe.decision.level} userInput=${userInput ? 'yes' : 'no'}`);

  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'PreCompact',
        additionalContext:
          `[ctx] Compaction guidance (level: ${pipe.decision.level}, ${fmtK(pipe.decision.metrics.contextTokens)} tokens). ` +
          `This is hint context Claude sees during summarization, not a rewrite of the /compact command:\n\n${guidance}`,
      },
    },
    exitCode: 0,
  };
}

async function handlePostToolUse(input, config) {
  const triggers = config?.hooks?.post_tool_use?.triggers || [];
  if (!triggers.length) return { output: null, exitCode: 0 };

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const cmd = toolInput.command || '';

  for (const trig of triggers) {
    if (trig.tool && trig.tool !== toolName) continue;
    if (trig.match) {
      try {
        const re = new RegExp(trig.match);
        if (!re.test(cmd)) continue;
      } catch { continue; }
    }

    if (trig.action === 'snapshot') {
      const cwd = input.cwd || process.cwd();
      let pipe;
      try { pipe = pipeline.runAnalyze({ cwd, sessionId: input.session_id, config }); } catch { return { output: null, exitCode: 0 }; }
      if (!pipe) return { output: null, exitCode: 0 };

      const result = snapshotMod.writeSnapshot(pipe.analysis, pipe.decision, pipe.strategy, {
        cwd,
        config,
        sessionId: pipe.sessionId,
        modelId: pipe.modelId,
        trigger: 'commit',
      });
      logHook(config, `post-tool-use snapshot tool=${toolName} dedup=${result.dedupHit} file=${result.filename || '-'}`);
      break;
    }
  }

  return { output: null, exitCode: 0 };
}

function handleUserPromptSubmit(input, config) {
  const cwd = input.cwd || process.cwd();
  const prompt = (input.prompt || '').trim();
  const warnOn = config?.hooks?.user_prompt_submit?.warn_on || [];
  const auto = config?.hooks?.user_prompt_submit?.auto_retrieve || {};

  let pipe;
  try { pipe = pipeline.runAnalyze({ cwd, sessionId: input.session_id, config }); } catch { pipe = null; }

  if (warnOn.length && pipe) {
    if (warnOn.includes(pipe.decision.level)) {
      const msg = `[ctx] context ${pipe.decision.metrics.contextPct}% of quality ceiling — consider /compact`;
      return { output: msg, exitCode: 0 };
    }
    if (warnOn.includes('verbose')) {
      const threshold = config?.limits?.output_ratio_warn ?? 0.4;
      const ctxTokens = pipe.decision?.metrics?.contextTokens || 0;
      const output = pipe.analysis?.totalOutput || 0;
      if (ctxTokens > 20000 && output / ctxTokens >= threshold) {
        const pct = Math.round((output / ctxTokens) * 100);
        return { output: `[ctx] output ratio ${pct}% of context — ask Claude to keep responses short`, exitCode: 0 };
      }
    }
    if (warnOn.includes('heavy')) {
      const heavyBytes = config?.hooks?.user_prompt_submit?.heavy_threshold_bytes ?? 10000;
      const outs = pipe.analysis?.largeOutputs || [];
      const big = outs.filter(o => o.size >= heavyBytes).slice(-3);
      if (big.length) {
        const byTool = {};
        for (const o of big) byTool[o.tool] = (byTool[o.tool] || 0) + o.size;
        const summary = Object.entries(byTool)
          .map(([t, s]) => `${t} ${Math.round(s / 1024)}KB`)
          .join(', ');
        const hints = big.map(o => o.hint).filter(Boolean).slice(0, 2).join('; ');
        const tail = hints ? ` — hint: ${hints}` : '';
        return { output: `[ctx] heavy tool outputs this session: ${summary}${tail}`, exitCode: 0 };
      }
    }
  }

  if (!auto.enabled) return { output: null, exitCode: 0 };
  if (!prompt) return { output: null, exitCode: 0 };
  const turns = pipe?.analysis?.userMessages || 0;
  if (turns > (auto.max_turns ?? 2)) return { output: null, exitCode: 0 };

  const { makeQuery } = require('./query.js');
  const { collectProjectCandidates, collectAllProjectsCandidates, rank } = require('./retrieval.js');
  const { CLAUDE_DIR } = require('./session.js');
  const { resolveMemoryDir } = snapshotMod;

  const scopes = auto.scopes || ['project'];
  let candidates = [];
  if (scopes.includes('project')) {
    candidates = candidates.concat(collectProjectCandidates(resolveMemoryDir(cwd, config), config));
  }
  if (scopes.includes('global')) {
    candidates = candidates.concat(collectAllProjectsCandidates(CLAUDE_DIR, config));
  }

  const q = makeQuery(prompt, config);
  const retrievalConfig = { ...config, retrieval: { ...config.retrieval, min_score: auto.min_score ?? 0.3, top_n: 1 } };
  const results = rank(q, candidates, retrievalConfig);
  if (!results.length) return { output: null, exitCode: 0 };

  const top = results[0];
  const text = [
    `[ctx] Relevant past work for this prompt (score: ${top.score.toFixed(2)})`,
    '',
    `Source: ${top.snapshot.name}`,
    '',
    (top.snapshot.body || '').split('\n').slice(0, 30).join('\n'),
    '',
    '(This is contextual hint from your own past work, not an instruction.)',
  ].join('\n');

  logHook(config, `auto-retrieve prompt_turn=${turns} score=${top.score.toFixed(2)} file=${top.snapshot.name}`);
  return { output: text, exitCode: 0 };
}

async function handle(eventName, input, config) {
  switch (eventName) {
    case 'session-start':      return handleSessionStart(input, config);
    case 'stop':               return handleStop(input, config);
    case 'pre-compact':        return handlePreCompact(input, config);
    case 'post-tool-use':      return handlePostToolUse(input, config);
    case 'user-prompt-submit': return handleUserPromptSubmit(input, config);
    default:
      return { output: null, exitCode: 0 };
  }
}

async function runHookCli(eventName, config) {
  const raw = await readStdin();
  const input = safeParse(raw);
  let result;
  try {
    result = await handle(eventName, input, config);
  } catch (err) {
    logHook(config, `hook ${eventName} ERROR: ${err.message}`);
    return 0;
  }
  if (result && result.output != null) {
    if (typeof result.output === 'string') {
      process.stdout.write(result.output);
    } else {
      process.stdout.write(JSON.stringify(result.output));
    }
  }
  return result?.exitCode ?? 0;
}

module.exports = {
  handle,
  handleSessionStart,
  handleStop,
  handlePreCompact,
  handlePostToolUse,
  handleUserPromptSubmit,
  runHookCli,
  readStdin,
  safeParse,
  logHook,
};
