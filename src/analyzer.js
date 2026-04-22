'use strict';

const { extractText } = require('./session.js');

const CRITICAL_PATTERNS = [
  { re: /(?:karar|decision)[:\s]/i,            label: 'decision' },
  { re: /(?:sonuç|result|outcome)[:\s]/i,      label: 'result' },
  { re: /(?:hata|error)[:\s].{10,80}/i,        label: 'error' },
  { re: /(?:çözüm|solution|fix)[:\s]/i,        label: 'fix' },
  { re: /TODO|FIXME|HACK|NOTE/,                label: 'todo/note' },
  { re: /migration.*(?:add|remove|alter)/i,    label: 'migration' },
  { re: /(?:port|url|endpoint)[:\s]\S+/i,      label: 'endpoint' },
  { re: /(?:env|secret|key)[:\s]\S+/i,         label: 'config' },
  { re: /olmadı|çalışmadı|denedik|başarısız|didn['t\s]*work|failed/i, label: 'failed attempt' },
];

function categorize(text, categories, map) {
  const lower = text.toLowerCase();
  for (const [key, cat] of Object.entries(categories)) {
    const words = cat.words || [];
    if (words.some(w => lower.includes(w.toLowerCase()))) {
      const entry = map.get(key) || { count: 0, examples: [], label: cat.label || key };
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(text.slice(0, 80));
      map.set(key, entry);
    }
  }
}

function extractCritical(text, arr) {
  for (const p of CRITICAL_PATTERNS) {
    const m = text.match(p.re);
    if (m) arr.push({ type: p.label, text: m[0].slice(0, 100) });
  }
}

function analyzeEntries(entries, config) {
  const categories = config?.categories || {};
  const growthWindow = config?.limits?.growth_window || 5;
  const maxEntries = config?.limits?.max_entries;
  if (typeof maxEntries === 'number' && maxEntries > 0 && entries.length > maxEntries) {
    entries = entries.slice(-maxEntries);
  }

  const analysis = {
    messageCount: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolUses: 0,

    contextTokens: 0,
    totalOutput: 0,
    tokenHistory: [],
    tokenPerTurn: [],
    avgGrowthPerTurn: 0,

    activeCategories: new Map(),
    filesModified: new Set(),
    bashCommands: [],
    criticalBits: [],
    userIntents: [],
    decisions: [],
    failedAttempts: [],
    lastNMessages: [],

    toolCounts: {},
    largeOutputs: [],
    recentEditSizes: [],
    editPressureKB: 0,

    lastUserMessage: '',
    lastAssistantPreview: '',
    firstTs: null,
    lastTs: null,
  };

  let turn = 0;
  let assistantTurn = 0;
  let prevInput = 0;
  const toolUseById = new Map();

  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp || '') || null;
    if (ts) {
      if (!analysis.firstTs) analysis.firstTs = ts;
      analysis.lastTs = ts;
    }

    const usage = entry.usage || entry.message?.usage || {};
    const inputTok    = usage.input_tokens || 0;
    const outputTok   = usage.output_tokens || 0;
    const cacheRead   = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const totalInput  = inputTok + cacheRead + cacheCreate;

    if (totalInput > analysis.contextTokens) analysis.contextTokens = totalInput;
    if (outputTok > 0) analysis.totalOutput += outputTok;

    if (entry.type === 'user') {
      analysis.userMessages++;
      analysis.messageCount++;
      turn++;
      const text = extractText(entry.message?.content);
      analysis.lastUserMessage = text.slice(0, 120);
      if (text.length > 10) {
        analysis.userIntents.push(text.slice(0, 120));
        categorize(text, categories, analysis.activeCategories);
        extractCritical(text, analysis.criticalBits);
        if (prevInput > 0 && totalInput > prevInput) {
          analysis.tokenPerTurn.push(totalInput - prevInput);
        }
        prevInput = totalInput;
      }
      analysis.tokenHistory.push({ turn, input: totalInput, output: 0 });
    }

    if (entry.type === 'assistant') {
      analysis.assistantMessages++;
      assistantTurn++;
      const text = extractText(entry.message?.content);
      analysis.lastAssistantPreview = text.slice(0, 120);
      if (text.length > 20) {
        categorize(text, categories, analysis.activeCategories);
        extractCritical(text, analysis.criticalBits);
        if (/(?:karar|decided|seçtik|kullanacağız|yapacağız)/i.test(text)) {
          analysis.decisions.push(text.slice(0, 150));
        }
        if (/(?:olmadı|çalışmadı|başarısız|denedik ama|bu yaklaşım)/i.test(text)) {
          analysis.failedAttempts.push(text.slice(0, 100));
        }
      }
      if (analysis.tokenHistory.length > 0) {
        analysis.tokenHistory[analysis.tokenHistory.length - 1].output = outputTok;
      }

      const msgContent = entry.message?.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block?.type === 'tool_use') {
            recordToolUse(analysis, block.name, block.input);
            // aTurn = assistant turn that issued the tool_use (not when the result returned).
            // Edit-pressure window is keyed by the turn the Edit was INVOKED in.
            if (block.id) toolUseById.set(block.id, { name: block.name, input: block.input, aTurn: assistantTurn });
          }
        }
      }
    }

    if (entry.type === 'tool_use') {
      recordToolUse(analysis, entry.tool || entry.name, entry.input);
      if (entry.id) toolUseById.set(entry.id, { name: entry.tool || entry.name, input: entry.input, aTurn: assistantTurn });
    }

    if (entry.type === 'tool_result' || entry.type === 'user') {
      const msgContent = entry.message?.content;
      if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block?.type === 'tool_result') {
            const out = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content || '');
            // Edit-pressure: capture every Edit-like tool_result size, regardless of threshold
            const editMap = block.tool_use_id ? toolUseById.get(block.tool_use_id) : null;
            if (editMap && ['Edit','edit','MultiEdit','Write','write','str_replace_based_edit_tool'].includes(editMap.name)) {
              analysis.recentEditSizes.push({ turn: editMap.aTurn ?? assistantTurn, size: out.length });
            }
            if (out.length > 2000) {
              const toolName = editMap?.name || 'tool_result';
              const preview = out.slice(0, 100);
              const hint = heavyHintFor(toolName, editMap?.input, out.length);
              analysis.largeOutputs.push({
                tool: toolName,
                size: out.length,
                preview,
                hint,
              });
            }
          }
        }
      }
    }
  }

  analysis.lastNMessages = analysis.userIntents.slice(-5);

  // Edit-pressure: sum sizes from Edits that landed in the last window_turns assistant turns
  const editWindow = config?.limits?.edit_pressure?.window_turns ?? 3;
  const cutoff = assistantTurn - editWindow;
  const pressureBytes = analysis.recentEditSizes
    .filter(e => e.turn > cutoff)
    .reduce((a, b) => a + b.size, 0);
  analysis.editPressureKB = Math.round(pressureBytes / 1024);

  if (analysis.tokenPerTurn.length >= 3) {
    const recent = analysis.tokenPerTurn.slice(-Math.min(growthWindow, analysis.tokenPerTurn.length));
    analysis.avgGrowthPerTurn = Math.round(
      recent.reduce((a, b) => a + b, 0) / recent.length
    );
  }

  return analysis;
}

function heavyHintFor(toolName, input, size) {
  const kb = Math.round(size / 1024);
  const t = (toolName || '').toLowerCase();
  if (t === 'bash') {
    const cmd = (input?.command || '').split(/\s+/)[0];
    if (['ls','find','tree'].includes(cmd)) return `pipe ${cmd} through head -50 or narrow with a specific pattern (${kb}KB now)`;
    if (cmd === 'cat' || cmd === 'less') return `use Read with offset+limit instead of cat (${kb}KB now)`;
    if (cmd === 'grep' || cmd === 'rg') return `add -l or head -50, or use Grep tool with head_limit (${kb}KB now)`;
    return `pipe through head -100 or grep a narrower pattern (${kb}KB now)`;
  }
  if (t === 'read')   return `pass offset + limit to Read, or grep the file first (${kb}KB now)`;
  if (t === 'grep')   return `pass head_limit, or filter with type/glob (${kb}KB now)`;
  if (t === 'glob')   return `narrow the pattern (${kb}KB of paths)`;
  if (t === 'webfetch' || t === 'webfetch') return `make the prompt more specific so the model extracts less (${kb}KB now)`;
  if (t === 'websearch') return `add quoted terms to narrow results (${kb}KB now)`;
  if (t.startsWith('mcp__')) return `this MCP tool returned ${kb}KB — check if it has a limit/filter parameter`;
  return `consider a narrower scope (${kb}KB now)`;
}

function recordToolUse(analysis, toolName, input) {
  if (!toolName) return;
  analysis.toolUses++;
  analysis.toolCounts[toolName] = (analysis.toolCounts[toolName] || 0) + 1;
  const inp = input || {};

  if (['Write','write','Edit','edit','str_replace_based_edit_tool','MultiEdit'].includes(toolName)) {
    const fp = inp.file_path || inp.path || inp.filename;
    if (fp) analysis.filesModified.add(fp);
  }
  if (['bash','Bash'].includes(toolName) && inp.command) {
    const cmd = String(inp.command).trim().slice(0, 80);
    if (!analysis.bashCommands.includes(cmd)) analysis.bashCommands.push(cmd);
  }
}

module.exports = {
  analyzeEntries,
  CRITICAL_PATTERNS,
};
