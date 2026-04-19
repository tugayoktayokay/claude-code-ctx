'use strict';

const fs   = require('fs');
const path = require('path');
const {
  listAllSessions,
  parseJSONL,
} = require('./session.js');
const { analyzeEntries }     = require('./analyzer.js');
const { makeDecision, fmtK } = require('./decision.js');
const { copyToClipboard }    = require('./strategy.js');
const { detectModel, getLimits } = require('./models.js');
const { runAnalyze }         = require('./pipeline.js');
const {
  loadConfig,
  ensureUserConfig,
  DEFAULT_PATH,
  USER_PATH,
} = require('./config.js');
const {
  stripColor,
  printAnalysis,
  printCompactResult,
  printSnapshotResult,
  printHistory,
  printRetrieval,
  timeAgo,
  C,
} = require('./output.js');
const { makeQuery } = require('./query.js');
const { collectProjectCandidates, rank } = require('./retrieval.js');
const { writeSnapshot } = require('./snapshot.js');
const { watchLoop } = require('./watcher.js');
const daemon = require('./daemon.js');
const backup = require('./backup.js');
const prune  = require('./prune.js');
const hooks  = require('./hooks.js');
const hooksInstall = require('./hooks_install.js');
const { resolveMemoryDir } = require('./snapshot.js');

function printHelp() {
  console.log(`
ctx — Claude Code context manager (zero deps)

Integration:
  ctx setup                          One-shot: install Claude Code hooks + ensure config
  ctx install-hooks                  Install just the hooks (idempotent, preserves your own)
  ctx uninstall-hooks                Remove ctx hooks; keep any foreign hooks
  ctx status                         Health snapshot (hooks, daemon, last snapshot, backups)
  ctx hook <event>                   Internal: stdin/stdout handler for Claude Code hooks

Analysis + memory:
  ctx                                Analyze current session (summary + recommendation)
  ctx watch                          Live token % monitor in foreground
  ctx daemon start|stop|status|log   Background watcher + git commit notifications
  ctx compact                        Build tailored /compact prompt, copy to clipboard
  ctx snapshot [--name NAME]         Write session summary into your memory dir
  ctx history [N]                    Last N sessions (default 10)
  ctx prune [--apply] [--older-than 30d] [--keep-last 20] [--per-project]
                                     Clean memory dir; dry-run by default
  ctx restore --list                 List gzipped JSONL backups for this project
  ctx restore <session-id> [--to P]  Gunzip backup to stdout or file
  ctx config                         Show / create config file
  ctx file <path>                    Analyze a specific JSONL file
  ctx --help                         This help

Context thresholds (measured against the model's quality ceiling):
  0-20%   ✅ comfortable
  20-40%  👀 watch
  40-55%  ⚠️  compact approaching
  55-75%  ⚠️  compact recommended
  75-90%  🔴 urgent
  90+%    🚨 critical

Config: ~/.config/ctx/config.json
`);
}

function runAnalyzeCmd(args, config) {
  stripColor();
  const cwd = process.cwd();
  const sessionPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const pipe = runAnalyze({ cwd, sessionPath, config });

  if (!pipe) {
    console.log('');
    console.log(C.yellow + '  ⚠️  No active Claude Code session found' + C.reset);
    console.log(C.gray + '     Is Claude Code running? Or try: ctx file <jsonl-path>' + C.reset);
    console.log('');
    return 1;
  }

  printAnalysis(pipe.analysis, pipe.decision, pipe.strategy, pipe.session.path, pipe.modelId);
  return 0;
}

function runCompact(args, config) {
  stripColor();
  const cwd = process.cwd();
  const sessionPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const pipe = runAnalyze({ cwd, sessionPath, config });

  if (!pipe) {
    console.error('❌ No active session');
    return 1;
  }

  const clipboardOk = copyToClipboard(pipe.strategy.compactPrompt);
  printCompactResult(pipe.analysis, pipe.decision, pipe.strategy, pipe.session.path, pipe.modelId, clipboardOk);
  return 0;
}

function runSnapshot(args, config) {
  stripColor();
  const cwd = process.cwd();
  let customName = null;
  let sessionPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) { customName = args[i + 1]; i++; }
    else if (args[i] === '--file' && args[i + 1]) { sessionPath = args[i + 1]; i++; }
  }

  const pipe = runAnalyze({ cwd, sessionPath, config });
  if (!pipe) {
    console.error('❌ No active session');
    return 1;
  }

  const result = writeSnapshot(pipe.analysis, pipe.decision, pipe.strategy, {
    cwd,
    config,
    customName,
    sessionId: pipe.sessionId,
    modelId: pipe.modelId,
    trigger: 'manual',
  });

  printSnapshotResult(result.outPath, result.indexUpdated);
  return 0;
}

function runHistory(args, config) {
  stripColor();
  const n = parseInt(args[0], 10) || 10;
  const sessions = listAllSessions().slice(0, n);

  if (!sessions.length) {
    console.log(C.gray + '  No sessions found' + C.reset);
    return 0;
  }

  const rows = sessions.map(s => {
    try {
      const entries  = parseJSONL(s.path);
      const analysis = analyzeEntries(entries, config);
      const modelId  = detectModel(entries);
      const limits   = getLimits(modelId, config);
      const decision = makeDecision(analysis, limits, config);
      return {
        path: s.path,
        fileName: path.basename(s.path).slice(0, 40),
        level: decision.level,
        pct: decision.metrics.contextPct,
        tokens: decision.metrics.contextTokens,
        messages: analysis.messageCount,
        age: timeAgo(s.mtime),
      };
    } catch {
      return {
        path: s.path,
        fileName: path.basename(s.path).slice(0, 40),
        level: 'comfortable',
        pct: 0,
        tokens: 0,
        messages: 0,
        age: timeAgo(s.mtime),
      };
    }
  });

  printHistory(rows);
  return 0;
}

function runConfig(_args, _config) {
  const created = !fs.existsSync(USER_PATH);
  ensureUserConfig();
  console.log('');
  console.log(`  ${created ? C.green + '✓ Created:' : '📄 Config:'}${C.reset} ${USER_PATH}`);
  console.log(C.gray + `  default:      ${DEFAULT_PATH}` + C.reset);
  console.log('');
  console.log(C.dim + '  Edit: $EDITOR ~/.config/ctx/config.json' + C.reset);
  console.log('');
  return 0;
}

function runDaemon(args, config) {
  stripColor();
  const sub = args[0] || 'status';
  switch (sub) {
    case 'start':   return daemon.start(process.cwd(), config);
    case 'stop':    return daemon.stop();
    case 'status':  return daemon.status();
    case 'log':     return daemon.tailLog(parseInt(args[1], 10) || 30);
    case '__run__': daemon.runLoop(args[1] || process.cwd(), config); return 0;
    default:
      console.error(`❌ Unknown daemon subcommand: ${sub}`);
      console.error(`   ctx daemon start|stop|status|log`);
      return 1;
  }
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
  if (n >= 1024)        return (n / 1024).toFixed(1) + 'k';
  return `${n}B`;
}

function runRestore(args, config) {
  stripColor();
  const cwd = process.cwd();

  if (args[0] === '--list' || !args[0]) {
    const items = backup.listBackups(cwd, config);
    if (!items.length) {
      console.log(C.gray + '  No backups for this project' + C.reset);
      console.log(C.dim + `    base: ${backup.backupDir(cwd, config)}` + C.reset);
      return 0;
    }
    console.log('');
    console.log(C.bold + '  JSONL backups (most recent first):' + C.reset);
    for (const item of items) {
      console.log(`  ${C.cyan}${item.sessionId.slice(0, 20).padEnd(20)}${C.reset}  ${fmtBytes(item.size).padStart(7)}  ${new Date(item.mtime).toISOString()}`);
      console.log(C.dim + `    ${item.path}` + C.reset);
    }
    console.log('');
    console.log(C.dim + '  Restore: ctx restore <sessionId-prefix> [--to <path>]' + C.reset);
    console.log('');
    return 0;
  }

  const id = args[0];
  let toPath = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--to' && args[i + 1]) { toPath = args[i + 1]; i++; }
  }

  const res = backup.resolveBackup(cwd, config, id);
  if (res.error === 'no-backups') {
    console.error(`❌ No backups for this project`);
    return 1;
  }
  if (res.error === 'not-found') {
    console.error(`❌ No backup matches: ${id}`);
    return 1;
  }
  if (res.error === 'ambiguous') {
    console.error(`❌ Ambiguous — ${res.matches.length} backups match "${id}":`);
    for (const m of res.matches) console.error(`   ${m.name}`);
    return 1;
  }

  const dest = toPath
    ? fs.createWriteStream(path.resolve(toPath))
    : process.stdout;

  return backup.restoreStream(res.match.path, dest).then(() => {
    if (toPath) console.error(C.green + `  ✓ Restored to ${toPath}` + C.reset);
    return 0;
  }).catch(err => {
    console.error(`❌ Restore failed: ${err.message}`);
    return 1;
  });
}

function runInstallHooks(_args, _config) {
  stripColor();
  const settingsPath = hooksInstall.defaultSettingsPath();
  let settings;
  try { settings = hooksInstall.readSettings(settingsPath); }
  catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
  const backupPath = hooksInstall.backupSettings(settingsPath);
  const next = hooksInstall.installHooks(settings);
  hooksInstall.writeSettings(next, settingsPath);

  console.log('');
  console.log(C.green + '  ✓ ctx hooks installed' + C.reset);
  console.log(C.gray + `    settings: ${settingsPath}` + C.reset);
  if (backupPath) console.log(C.gray + `    backup:   ${backupPath}` + C.reset);
  console.log(C.gray + `    events:   ${hooksInstall.listInstalledEvents(next).join(', ')}` + C.reset);
  console.log('');
  console.log(C.dim + '  Undo: ctx uninstall-hooks' + C.reset);
  console.log('');
  return 0;
}

function runUninstallHooks(_args, _config) {
  stripColor();
  const settingsPath = hooksInstall.defaultSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    console.log(C.gray + '  ℹ️  No settings.json — nothing to uninstall' + C.reset);
    return 0;
  }
  let settings;
  try { settings = hooksInstall.readSettings(settingsPath); }
  catch (err) {
    console.error(`❌ ${err.message}`);
    return 1;
  }
  const before = hooksInstall.listInstalledEvents(settings);
  if (!before.length) {
    console.log(C.gray + '  ℹ️  No ctx hooks installed' + C.reset);
    return 0;
  }

  const backupPath = hooksInstall.backupSettings(settingsPath);
  const next = hooksInstall.uninstallHooks(settings);
  hooksInstall.writeSettings(next, settingsPath);

  console.log('');
  console.log(C.green + `  ✓ Removed ctx hooks from ${before.length} event(s)` + C.reset);
  console.log(C.gray + `    removed: ${before.join(', ')}` + C.reset);
  if (backupPath) console.log(C.gray + `    backup:  ${backupPath}` + C.reset);
  console.log('');
  return 0;
}

function runSetup(_args, config) {
  stripColor();
  ensureUserConfig();
  const r1 = runInstallHooks([], config);
  if (r1 !== 0) return r1;

  const daemonRunning = (() => {
    try { return require('fs').existsSync(daemon.PID_FILE) && true; } catch { return false; }
  })();

  if (!daemonRunning) {
    console.log(C.dim + '  Tip: start the daemon for desktop notifications:' + C.reset);
    console.log(C.dim + '       ctx daemon start' + C.reset);
    console.log('');
  }
  return 0;
}

function runStatus(_args, config) {
  stripColor();
  const cwd = process.cwd();
  const { getLatestSnapshotForCwd } = require('./snapshot.js');

  console.log('');
  console.log(C.bold + '  ctx status' + C.reset);
  console.log('');

  // config
  console.log(C.dim + '  Config:' + C.reset);
  console.log(`    ${C.gray}default:${C.reset} ${DEFAULT_PATH}`);
  console.log(`    ${C.gray}user:   ${C.reset} ${USER_PATH}${fs.existsSync(USER_PATH) ? '' : C.gray + ' (not created)' + C.reset}`);
  console.log('');

  // hooks
  let hooksLabel = C.gray + 'not installed' + C.reset;
  try {
    const settings = hooksInstall.readSettings();
    const events = hooksInstall.listInstalledEvents(settings);
    if (events.length) {
      hooksLabel = C.green + `installed (${events.length} events)` + C.reset;
    }
  } catch (err) {
    hooksLabel = C.red + `settings.json error: ${err.message}` + C.reset;
  }
  console.log(C.dim + '  Hooks:' + C.reset);
  console.log(`    ${C.gray}status: ${C.reset}${hooksLabel}`);
  console.log(`    ${C.gray}install:${C.reset} ctx setup`);
  console.log('');

  // daemon
  const pid = (() => {
    try {
      const n = Number(fs.readFileSync(daemon.PID_FILE, 'utf8').trim());
      if (Number.isFinite(n)) { process.kill(n, 0); return n; }
    } catch {}
    return null;
  })();
  console.log(C.dim + '  Daemon:' + C.reset);
  console.log(`    ${C.gray}status: ${C.reset}${pid ? C.green + `running (pid ${pid})` + C.reset : C.gray + 'not running' + C.reset}`);
  console.log('');

  // latest snapshot
  const latest = getLatestSnapshotForCwd(cwd, config);
  console.log(C.dim + '  Latest snapshot (this project):' + C.reset);
  if (latest) {
    const ageM = Math.round((Date.now() - latest.mtime) / 60000);
    console.log(`    ${C.gray}${latest.name}${C.reset}  ${C.gray}${ageM}m ago${C.reset}`);
  } else {
    console.log(`    ${C.gray}none${C.reset}`);
  }
  console.log('');

  // latest backup
  const backups = backup.listBackups(cwd, config);
  console.log(C.dim + '  JSONL backups (this project):' + C.reset);
  if (backups.length) {
    const b = backups[0];
    const ageM = Math.round((Date.now() - b.mtime) / 60000);
    console.log(`    ${C.gray}latest:${C.reset} ${b.name}  ${C.gray}${ageM}m ago, ${fmtBytes(b.size)}${C.reset}`);
    console.log(`    ${C.gray}count: ${C.reset} ${backups.length}`);
  } else {
    console.log(`    ${C.gray}none${C.reset}`);
  }
  console.log('');

  return 0;
}

function buildInjectionBlock(snap) {
  return [
    `[ctx] Relevant past work from: ${snap.name}`,
    '',
    (snap.body || '').split('\n').slice(0, 40).join('\n'),
    '',
    `(source: ${snap.path})`,
  ].join('\n');
}

function runStats(args, config) {
  stripColor();
  let rangeDays = 7;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--week') rangeDays = 7;
    else if (args[i] === '--month') rangeDays = 30;
    else if (args[i] === '--days' && args[i + 1]) { rangeDays = Number(args[i + 1]); i++; }
  }
  const cwd = process.cwd();
  const { aggregate } = require('./stats.js');
  const { printStats } = require('./output.js');
  const memoryDir = resolveMemoryDir(cwd, config);
  printStats(aggregate(memoryDir, { rangeDays }));
  return 0;
}

function runDiff(args, config) {
  stripColor();
  if (args.length < 2) {
    console.error('❌ ctx diff <snapshot-a> <snapshot-b>');
    return 1;
  }
  const cwd = process.cwd();
  const memoryDir = resolveMemoryDir(cwd, config);
  const resolve = (n) => fs.existsSync(n) ? n : path.join(memoryDir, n);
  const aPath = resolve(args[0]);
  const bPath = resolve(args[1]);
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) {
    console.error(`❌ Not found: ${!fs.existsSync(aPath) ? aPath : bPath}`);
    return 1;
  }
  const { diffSnapshots } = require('./diff.js');
  const { printDiff }     = require('./output.js');
  printDiff(diffSnapshots(aPath, bPath));
  return 0;
}

function runTimeline(_args, config) {
  stripColor();
  const cwd = process.cwd();
  const { buildThreads } = require('./timeline.js');
  const { printTimeline } = require('./output.js');
  const memoryDir = resolveMemoryDir(cwd, config);
  const threads = buildThreads(memoryDir);
  printTimeline(threads);
  return 0;
}

function runAsk(args, config) {
  stripColor();
  const cwd = process.cwd();
  const queryParts = [];
  let asJson = false;
  let doInject = false;
  let useGlobal = false;
  let useNotes  = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json')        asJson = true;
    else if (a === '--inject') doInject = true;
    else if (a === '--global') useGlobal = true;
    else if (a === '--notes')  useNotes  = true;
    else queryParts.push(a);
  }
  if (!queryParts.length) {
    console.error('❌ ctx ask "<query>" [--global] [--notes] [--inject] [--json]');
    return 1;
  }

  const raw = queryParts.join(' ');
  const query = makeQuery(raw, config);

  let candidates;
  if (useGlobal) {
    const { CLAUDE_DIR } = require('./session.js');
    const { collectAllProjectsCandidates } = require('./retrieval.js');
    candidates = collectAllProjectsCandidates(CLAUDE_DIR, config);
  } else {
    const memoryDir = resolveMemoryDir(cwd, config);
    candidates = collectProjectCandidates(memoryDir, config);
  }

  if (useNotes) {
    const { collectNotesCandidates } = require('./notes.js');
    const extra = collectNotesCandidates(config?.notes?.roots || [], config);
    candidates = candidates.concat(extra);
  }

  const results = rank(query, candidates, config);
  printRetrieval(results, query, { json: asJson });

  if (doInject && results.length) {
    const top = results[0];
    const { copyToClipboard } = require('./strategy.js');
    const injected = buildInjectionBlock(top.snapshot);
    const ok = copyToClipboard(injected);
    if (!asJson) {
      console.log(ok
        ? C.green + '  ✓ Top match copied to clipboard.' + C.reset
        : C.yellow + '  ⚠ clipboard not available (non-darwin).' + C.reset);
      console.log('');
    }
  }
  return 0;
}

function runHook(args, config) {
  const event = args[0];
  if (!event) {
    console.error('❌ ctx hook <event> — event required');
    console.error('   events: session-start, stop, pre-compact, post-tool-use, user-prompt-submit');
    return 1;
  }
  return hooks.runHookCli(event, config);
}

function runPrune(args, config) {
  stripColor();
  const cwd = process.cwd();
  let apply = false;
  let perProject = false;
  let olderThan = config?.prune?.default_older_than || '30d';
  let keepLast  = config?.prune?.default_keep_last  ?? null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply')        apply = true;
    else if (a === '--per-project') perProject = true;
    else if (a === '--older-than' && args[i + 1]) { olderThan = args[i + 1]; i++; }
    else if (a === '--keep-last'  && args[i + 1]) { keepLast  = Number(args[i + 1]); i++; }
    else if (a === '--no-older-than') olderThan = null;
  }

  const memoryDirs = perProject
    ? prune.listProjectMemoryDirs()
    : [resolveMemoryDir(cwd, config)];

  let totalRemove = 0;
  let totalKeep   = 0;
  let totalApplied = 0;

  console.log('');
  for (const dir of memoryDirs) {
    const plan = prune.planFromOpts(dir, { olderThan, keepLast });
    if (!plan.exists) continue;
    totalRemove += plan.toRemove.length;
    totalKeep   += plan.toKeep.length;

    if (plan.toRemove.length === 0 && !perProject) {
      console.log(C.gray + `  ${dir}` + C.reset);
      console.log(C.dim + `    nothing to prune (${plan.toKeep.length} kept)` + C.reset);
      continue;
    }

    if (plan.toRemove.length) {
      console.log(C.bold + `  ${dir}` + C.reset);
      for (const item of plan.toRemove) {
        const days = Math.round(item.age / 86_400_000);
        console.log(`    ${C.yellow}✗${C.reset} ${item.name}  ${C.gray}${days}d old (${item.reasons.join(',')})${C.reset}`);
      }
      if (apply) {
        const result = prune.applyPrune(plan);
        totalApplied += result.removedFiles;
        console.log(C.green + `    ✓ removed ${result.removedFiles} file(s), ${result.indexRemoved} index line(s)` + C.reset);
      }
      console.log('');
    }
  }

  if (!totalRemove) {
    console.log(C.gray + '  Nothing to prune.' + C.reset);
    console.log('');
    return 0;
  }

  if (!apply) {
    console.log(C.bold + `  Dry run: ${totalRemove} file(s) would be removed, ${totalKeep} kept.` + C.reset);
    console.log(C.dim + '  Rerun with --apply to actually delete.' + C.reset);
  } else {
    console.log(C.bold + C.green + `  ✓ Removed ${totalApplied} file(s) total.` + C.reset);
  }
  console.log('');
  return 0;
}

function runFile(args, config) {
  stripColor();
  if (!args[0]) {
    console.error('❌ ctx file <path> — path required');
    return 1;
  }
  return runAnalyzeCmd([args[0]], config);
}

function main(argv) {
  const [, , cmd, ...rest] = argv;
  const config = loadConfig();

  switch (cmd) {
    case undefined:
    case 'analyze':
      return runAnalyzeCmd(rest, config);
    case 'watch':
      watchLoop(process.cwd(), config);
      return 0;
    case 'daemon':
      return runDaemon(rest, config);
    case 'compact':
      return runCompact(rest, config);
    case 'snapshot':
      return runSnapshot(rest, config);
    case 'history':
      return runHistory(rest, config);
    case 'config':
      return runConfig(rest, config);
    case 'file':
      return runFile(rest, config);
    case 'restore':
      return runRestore(rest, config);
    case 'prune':
      return runPrune(rest, config);
    case 'hook':
      return runHook(rest, config);
    case 'ask':
      return runAsk(rest, config);
    case 'timeline':
      return runTimeline(rest, config);
    case 'diff':
      return runDiff(rest, config);
    case 'stats':
      return runStats(rest, config);
    case 'status':
      return runStatus(rest, config);
    case 'setup':
      return runSetup(rest, config);
    case 'install-hooks':
      return runInstallHooks(rest, config);
    case 'uninstall-hooks':
      return runUninstallHooks(rest, config);
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return 0;
    default:
      if (cmd && !cmd.startsWith('-') && fs.existsSync(path.resolve(cmd))) {
        return runAnalyzeCmd([cmd], config);
      }
      console.error(`❌ Unknown command: ${cmd}`);
      printHelp();
      return 1;
  }
}

module.exports = { main };
