'use strict';

const { execSync } = require('child_process');
const path = require('path');
const { runAnalyze } = require('./pipeline.js');

function execLines(cmd, cwd, max = 50, { trim = true } = {}) {
  try {
    return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map(s => trim ? s.trim() : s.replace(/\s+$/, ''))
      .filter(Boolean)
      .slice(0, max);
  } catch {
    return [];
  }
}

function parseGitStatus(cwd) {
  return execLines('git status --short', cwd, 100, { trim: false }).map(line => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3).trim(),
  }));
}

function lastMatching(arr, re) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = String(arr[i] || '');
    if (re.test(s)) return s;
  }
  return null;
}

function buildWorkingSet({ cwd = process.cwd(), config } = {}) {
  const pipe = runAnalyze({ cwd, config });
  const analysis = pipe?.analysis || null;
  const gitChanges = parseGitStatus(cwd);
  const recentCommands = (analysis?.bashCommands || []).slice(-10).reverse();
  const filesModified = analysis ? [...analysis.filesModified].slice(-20).reverse() : [];
  const largeOutputs = (analysis?.largeOutputs || []).slice().sort((a, b) => b.size - a.size).slice(0, 5);
  const lastUser = analysis?.lastUserMessage || '';
  const lastAssistant = analysis?.lastAssistantPreview || '';
  const lastTest = lastMatching(recentCommands, /^\s*(?:cd\s+[^&]+&&\s*)?(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint)\b|^\s*node\s+--test\b|^\s*(?:vitest|jest)\b/i);
  const lastGuard = lastMatching([...(analysis?.failedAttempts || []), ...(analysis?.criticalBits || []).map(x => x.text)], /error|failed|hata|olmadı|çalışmadı/i);

  return {
    cwd,
    session: pipe?.session?.path || null,
    model: pipe?.modelId || null,
    level: pipe?.decision?.level || null,
    context_pct: pipe?.decision?.metrics?.contextPct ?? null,
    git_changes: gitChanges,
    files_modified: filesModified,
    recent_commands: recentCommands,
    last_test: lastTest,
    last_guard_or_error: lastGuard,
    large_outputs: largeOutputs,
    last_user: lastUser,
    last_assistant: lastAssistant,
  };
}

function formatWorkingSet(ws) {
  const rel = p => {
    if (!p) return p;
    const r = path.relative(ws.cwd, p);
    return r && !r.startsWith('..') ? r : p;
  };
  const lines = [];
  lines.push('');
  lines.push('  ctx working-set');
  lines.push('');
  lines.push(`  project: ${ws.cwd}`);
  if (ws.session) lines.push(`  session: ${path.basename(ws.session)}`);
  if (ws.level) lines.push(`  context: ${ws.context_pct}% (${ws.level})`);
  lines.push('');
  lines.push('  Git changes:');
  if (!ws.git_changes.length) lines.push('    (none)');
  for (const g of ws.git_changes.slice(0, 20)) lines.push(`    ${g.status.padEnd(2)} ${g.path}`);
  lines.push('');
  lines.push('  Active files:');
  if (!ws.files_modified.length) lines.push('    (none)');
  for (const f of ws.files_modified.slice(0, 12)) lines.push(`    ${rel(f)}`);
  lines.push('');
  lines.push('  Recent commands:');
  if (!ws.recent_commands.length) lines.push('    (none)');
  for (const c of ws.recent_commands.slice(0, 8)) lines.push(`    ${c}`);
  lines.push('');
  lines.push(`  Last test/build: ${ws.last_test || '(none)'}`);
  lines.push(`  Last guard/error: ${ws.last_guard_or_error || '(none)'}`);
  if (ws.large_outputs.length) {
    lines.push('');
    lines.push('  Largest recent outputs:');
    for (const o of ws.large_outputs) lines.push(`    ${o.tool}: ${Math.round(o.size / 1024)}KB ${o.hint ? '- ' + o.hint : ''}`);
  }
  if (ws.last_user) {
    lines.push('');
    lines.push(`  Last user: ${ws.last_user}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { buildWorkingSet, formatWorkingSet };
