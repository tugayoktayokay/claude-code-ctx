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

function printRetrieval(results, query, opts = {}) {
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      query: query.raw,
      tokens: query.nonStop,
      categories: query.categories,
      results: results.map(r => ({
        score: +r.score.toFixed(3),
        breakdown: r.breakdown,
        name: r.snapshot.name,
        path: r.snapshot.path,
        categories: r.snapshot.categories,
      })),
    }, null, 2) + '\n');
    return;
  }
  console.log('');
  console.log(C.bold + `  ctx ask — "${query.raw}"` + C.reset);
  console.log(C.dim + `    query tokens: ${query.nonStop.join(' ')} | categories: ${query.categories.join(', ') || '(none)'}` + C.reset);
  console.log('');
  if (!results.length) {
    console.log(C.gray + '  No matches above min_score.' + C.reset);
    console.log('');
    return;
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const b = r.breakdown;
    const age = timeAgo(r.snapshot.mtime);
    const cite = citeFor(r.snapshot);
    console.log(`  ${C.bold}#${i + 1}${C.reset}  ${C.green}score ${r.score.toFixed(2)}${C.reset}  ${C.magenta}${cite}${C.reset}  ${r.snapshot.name}`);
    console.log(`      ${C.gray}matched: category=${b.category.toFixed(2)} keyword=${b.keyword.toFixed(2)} recency=${b.recency.toFixed(2)}${C.reset}`);
    console.log(`      ${C.gray}cats: ${(r.snapshot.categories || []).join(', ') || '(none)'} | ${age}${C.reset}`);
    const firstBody = (r.snapshot.body || '').split('\n').filter(l => l.trim()).slice(0, 3).join(' ').slice(0, 140);
    if (firstBody) console.log(`      ${firstBody}`);
    console.log(C.dim + `      ${r.snapshot.path}` + C.reset);
    console.log('');
  }
  if (results.length) {
    console.log(C.dim + `  Cite a snapshot by pasting its id (e.g. ${citeFor(results[0].snapshot)}) into Claude.` + C.reset);
    console.log('');
  }
}

function citeFor(snap) {
  const fp = snap?.meta?.fingerprint || '';
  if (fp) return `#${fp.slice(0, 8)}`;
  const name = snap?.name || '';
  const m = name.match(/^project_([a-z0-9_]+)/i);
  return m ? `#${m[1].slice(0, 12)}` : `#${(name || 'x').slice(0, 8)}`;
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
  printRetrieval,
  printTimeline,
  printDiff,
  printStats,
  printBloat,
  printUsage,
  printHeavy,
  timeAgo,
  macNotify,
};

function fmtBytesShort(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
  if (n >= 1024)        return (n / 1024).toFixed(1) + 'k';
  return `${n}B`;
}

function printBloat(report) {
  console.log('');
  console.log(C.bold + '  ctx bloat — system prompt footprint' + C.reset);
  console.log('');
  console.log(C.dim + '  CLAUDE.md files (every-turn cost):' + C.reset);
  let total = 0;
  for (const cmd of report.claudeMd) {
    total += cmd.bytes;
    const bad = cmd.bytes > 4000;
    console.log(`  ${bad ? C.yellow + '⚠' + C.reset : C.green + '✓' + C.reset} ${cmd.path}  ${fmtBytesShort(cmd.bytes)}`);
    for (const s of cmd.topSections) {
      console.log(`      ${C.gray}${s.heading.padEnd(40)}${C.reset} ${fmtBytesShort(s.bytes).padStart(6)}`);
    }
  }
  if (!report.claudeMd.length) console.log(C.gray + '  (no CLAUDE.md found)' + C.reset);
  console.log('');

  console.log(C.dim + '  Skills — description line is the per-session cost (body lazy-loaded):' + C.reset);
  console.log(C.gray + `    ${report.skills.length} total installed` + C.reset);
  const totalDescBytes = report.skills.reduce((a, s) => a + (s.descBytes || 0), 0);
  console.log(C.gray + `    ~${fmtBytesShort(totalDescBytes)} description lines in system-reminder each session` + C.reset);
  console.log('');

  if (report.unusedSkills && report.unusedSkills.length) {
    console.log(C.yellow + `  ⚠ ${report.unusedSkills.length} skill(s) not invoked in last ${report.scanThresholdDays || 30}d:` + C.reset);
    let unusedDescBytes = 0;
    for (const s of report.unusedSkills.slice(0, 15)) {
      unusedDescBytes += s.descBytes || 0;
      console.log(`    ${C.gray}${s.name.padEnd(38)}${C.reset} desc ${fmtBytesShort(s.descBytes || 0).padStart(5)}  body ${fmtBytesShort(s.bytes).padStart(6)}`);
    }
    if (report.unusedSkills.length > 15) {
      console.log(C.gray + `    … and ${report.unusedSkills.length - 15} more` + C.reset);
    }
    console.log('');
    console.log(C.green + `    → removing these unused skills saves ~${fmtBytesShort(unusedDescBytes)} per session` + C.reset);
    console.log('');
  }
}

function printUsage(title, ranked, meta) {
  console.log('');
  console.log(C.bold + `  ${title}` + C.reset);
  console.log(C.gray + `    scanned ${meta.scanned} session(s)` + C.reset);
  console.log('');
  if (!ranked.length) {
    console.log(C.gray + '    (no data)' + C.reset);
    console.log('');
    return;
  }
  const max = ranked[0].count || 1;
  for (const r of ranked.slice(0, 30)) {
    const bar = '█'.repeat(Math.round((r.count / max) * 20));
    const warn = r.count === 0 ? C.yellow + '⚠ 0 uses' + C.reset : '';
    console.log(`    ${C.gray}${r.name.padEnd(38)}${C.reset} ${String(r.count).padStart(4)}  ${C.cyan}${bar}${C.reset} ${warn}`);
  }
  console.log('');
}

function printHeavy(items) {
  console.log('');
  console.log(C.bold + '  ctx heavy — largest tool outputs (current session)' + C.reset);
  console.log('');
  if (!items.length) {
    console.log(C.gray + '    (no large outputs in this session)' + C.reset);
    console.log('');
    return;
  }
  for (const it of items) {
    console.log(`    ${C.yellow}${fmtBytesShort(it.size).padStart(8)}${C.reset}  ${C.gray}${it.tool.padEnd(20)}${C.reset}  ${(it.preview || '').slice(0, 60)}`);
  }
  console.log('');
}

function printStats(stats) {
  console.log('');
  console.log(C.bold + `  ctx stats — last ${stats.rangeDays} days` + C.reset);
  console.log('');
  console.log(`    Snapshots: ${C.green}${stats.snapshots}${C.reset}`);
  console.log('');
  console.log(C.dim + '  Triggers:' + C.reset);
  const trigEntries = Object.entries(stats.triggers);
  if (!trigEntries.length) console.log(C.gray + '    (none)' + C.reset);
  for (const [k, v] of trigEntries) {
    console.log(`    ${C.gray}${k.padEnd(20)}${C.reset} ${v}`);
  }
  console.log('');
  console.log(C.dim + '  Top categories:' + C.reset);
  if (!stats.topCategories.length) console.log(C.gray + '    (none)' + C.reset);
  for (const c of stats.topCategories) {
    console.log(`    ${C.gray}${c.name.padEnd(20)}${C.reset} ${c.count}`);
  }
  console.log('');
}

function printDiff(delta) {
  console.log('');
  console.log(C.bold + `  diff: ${delta.a}  →  ${delta.b}` + C.reset);
  console.log('');
  for (const [label, dd] of [['Files', delta.files], ['Decisions', delta.decisions], ['Failed attempts', delta.failedAttempts]]) {
    console.log(C.bold + `  ${label}:` + C.reset);
    if (dd.added.length)   for (const x of dd.added)   console.log(`    ${C.green}+ ${x}${C.reset}`);
    if (dd.removed.length) for (const x of dd.removed) console.log(`    ${C.red}- ${x}${C.reset}`);
    if (!dd.added.length && !dd.removed.length) console.log(C.gray + '    (no changes)' + C.reset);
    console.log('');
  }
}

function printTimeline(threads) {
  console.log('');
  console.log(C.bold + `  ctx timeline — ${threads.length} thread(s)` + C.reset);
  console.log('');
  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const last = thread[thread.length - 1];
    console.log(C.cyan + `  ▸ thread #${i + 1} (${thread.length} snapshots, last: ${timeAgo(last.mtime)})` + C.reset);
    for (const snap of thread) {
      const cats = (snap.categories || []).join(', ') || '-';
      console.log(`    ${C.gray}${new Date(snap.mtime).toISOString().slice(0, 10)}${C.reset}  ${snap.name}  ${C.dim}[${cats}]${C.reset}`);
    }
    console.log('');
  }
}
