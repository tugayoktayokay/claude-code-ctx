'use strict';

const path = require('path');
const { fmtK } = require('./decision.js');

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
};

const LEVEL_COLOR_KEY = {
  comfortable: 'green',
  watch:       'yellow',
  compact:     'yellow',
  urgent:      'red',
  critical:    'magenta',
};

const LEVEL_ICON = {
  comfortable: '✅',
  watch:       '👀',
  compact:     '⚠️ ',
  urgent:      '🔴',
  critical:    '🚨',
};

function colorFor(level) {
  return C[LEVEL_COLOR_KEY[level]] || '';
}

function stripColor() {
  if (process.env.NO_COLOR || !process.stdout.isTTY) {
    for (const k of Object.keys(C)) C[k] = '';
  }
}

function contextBar(pct, width = 40) {
  const filled = Math.min(Math.max(Math.round((pct / 100) * width), 0), width);
  const barColor = pct > 75 ? C.red : pct > 55 ? C.yellow : C.green;
  return barColor + '█'.repeat(filled) + C.gray + '░'.repeat(width - filled) + C.reset;
}

function printAnalysis(analysis, decision, strategy, sessionPath, modelId) {
  const { metrics, level, reasons, action } = decision;
  const color = colorFor(level);
  const icon  = LEVEL_ICON[level] || '';

  console.log('');
  console.log(C.bold + '╔══════════════════════════════════════════════╗' + C.reset);
  console.log(C.bold + '║             ctx — context analyzer           ║' + C.reset);
  console.log(C.bold + '╚══════════════════════════════════════════════╝' + C.reset);
  console.log('');
  console.log(`  [${contextBar(metrics.contextPct)}] ${metrics.contextPct}%`);
  console.log(
    `  ${fmtK(metrics.contextTokens)} / ${fmtK(metrics.qualityCeiling)} quality ceiling` +
    (metrics.modelMax > metrics.qualityCeiling
      ? `   ${C.gray}(model max ${fmtK(metrics.modelMax)})${C.reset}`
      : '')
  );
  console.log(`  ${color}${icon} ${level.toUpperCase()}${C.reset}`);
  if (modelId) console.log(`  ${C.gray}model: ${modelId}${C.reset}`);
  console.log('');

  console.log(C.dim + '  Metrics:' + C.reset);
  console.log(`    ${C.gray}Messages  :${C.reset} ${metrics.messageCount}`);
  console.log(`    ${C.gray}Tool calls:${C.reset} ${metrics.toolUses}`);
  console.log(`    ${C.gray}Files     :${C.reset} ${metrics.filesModified}`);
  console.log(`    ${C.gray}Output    :${C.reset} ${fmtK(metrics.outputTokens)} tokens`);
  if (metrics.avgGrowthPerTurn > 0) {
    console.log(`    ${C.gray}Growth    :${C.reset} ~${fmtK(metrics.avgGrowthPerTurn)}/turn`);
  }
  console.log('');

  if (reasons.length) {
    console.log(C.dim + '  Analysis:' + C.reset);
    for (const r of reasons) console.log(`    • ${r}`);
    console.log('');
  }

  if (strategy?.keep?.length) {
    console.log(C.green + '  ✓ Keep in compact:' + C.reset);
    for (const s of strategy.keep.slice(0, 5)) console.log(`    • ${s}`);
    console.log('');
  }

  if (analysis.lastNMessages?.length) {
    console.log(C.dim + '  Recent user messages:' + C.reset);
    for (const m of analysis.lastNMessages.slice(-3)) {
      console.log(`    ${C.gray}→${C.reset} ${m.slice(0, 80)}`);
    }
    console.log('');
  }

  if (action) {
    console.log(color + `  ➜ ${action}` + C.reset);
    console.log('');
  }

  if (sessionPath) {
    console.log(C.gray + `  📄 ${path.basename(sessionPath)}` + C.reset);
    console.log('');
  }
}

function printCompactResult(analysis, decision, strategy, sessionPath, modelId, clipboardOk) {
  printAnalysis(analysis, decision, strategy, sessionPath, modelId);

  const line = '─'.repeat(52);
  console.log(line);
  console.log(C.bold + C.cyan + '  /compact prompt (copy + paste):' + C.reset);
  console.log('');
  console.log(C.bold + '  ' + strategy.compactPrompt + C.reset);
  console.log('');
  console.log(line);
  if (clipboardOk) {
    console.log(C.gray + '  ✓ Copied to clipboard' + C.reset);
  }
  console.log('');
}

function printWatchTick(decision, now = new Date()) {
  const { level, metrics } = decision;
  const color = colorFor(level);
  const icon  = LEVEL_ICON[level] || '';
  const ts    = now.toLocaleTimeString('tr-TR', { hour12: false });
  const pct   = metrics.contextPct;
  const tok   = fmtK(metrics.contextTokens);
  return `${color}${icon} [${ts}] Context: %${pct} (${tok} token) — ${level}${C.reset}`;
}

function printSnapshotResult(outPath, indexUpdated) {
  console.log('');
  console.log(C.green + '  ✓ Snapshot written' + C.reset);
  console.log(`    ${outPath}`);
  if (indexUpdated) console.log(C.gray + `    MEMORY.md index updated` + C.reset);
  console.log('');
}

function printHistory(rows) {
  console.log('');
  console.log(C.bold + `  Last ${rows.length} sessions:` + C.reset);
  console.log('');
  for (const r of rows) {
    const color = colorFor(r.level);
    const icon  = LEVEL_ICON[r.level] || '';
    const pct   = String(r.pct).padStart(3);
    console.log(
      `  ${color}${icon} [${pct}%]${C.reset} ${r.age.padEnd(10)} ` +
      `${C.gray}${r.messages} msg · ${fmtK(r.tokens)} tok · ${r.fileName}${C.reset}`
    );
  }
  console.log('');
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function macNotify(title, message) {
  if (process.platform !== 'darwin') return;
  try {
    const { execSync } = require('child_process');
    const escaped = (s) => String(s).replace(/"/g, '\\"');
    execSync(
      `osascript -e 'display notification "${escaped(message)}" with title "${escaped(title)}"'`,
      { stdio: 'ignore' }
    );
  } catch {}
}

module.exports = {
  C,
  LEVEL_COLOR_KEY,
  LEVEL_ICON,
  colorFor,
  stripColor,
  contextBar,
  printAnalysis,
  printCompactResult,
  printWatchTick,
  printSnapshotResult,
  printHistory,
  timeAgo,
  macNotify,
};
