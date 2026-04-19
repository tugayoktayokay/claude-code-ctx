'use strict';

const fs   = require('fs');
const path = require('path');
const {
  findLatestSession,
  listAllSessions,
  parseJSONL,
} = require('./session.js');
const { analyzeEntries }     = require('./analyzer.js');
const { makeDecision, fmtK } = require('./decision.js');
const { buildStrategy, copyToClipboard } = require('./strategy.js');
const { detectModel, getLimits } = require('./models.js');
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
  timeAgo,
  C,
} = require('./output.js');
const { writeSnapshot } = require('./snapshot.js');
const { watchLoop } = require('./watcher.js');
const daemon = require('./daemon.js');

function printHelp() {
  console.log(`
ctx — Claude Code context manager (zero deps)

Commands:
  ctx                          Aktif session'ı analiz et (özet + öneri)
  ctx watch                    Canlı token % monitor + macOS notif (foreground)
  ctx daemon start|stop|status|log   Arka plan izleme + git commit notif
  ctx compact                  /compact prompt üret + clipboard
  ctx snapshot [--name NAME]   Memory'e session özeti yaz
  ctx history [N]              Son N session (default 10)
  ctx config                   Config path göster, yoksa oluştur
  ctx file <path>              Belirli JSONL'i analiz et
  ctx --help                   Bu yardım

Context thresholds (quality ceiling üzerinden):
  0-20%   ✅ comfortable
  20-40%  👀 watch
  40-55%  ⚠️  compact zamanı yaklaşıyor
  55-75%  ⚠️  compact öneri
  75-90%  🔴 urgent
  90+%    🚨 critical

Config: ~/.config/ctx/config.json
`);
}

function loadSession(sessionPath, cwd) {
  const target = sessionPath
    ? { path: path.resolve(sessionPath) }
    : findLatestSession(cwd);
  if (!target) return null;
  if (!fs.existsSync(target.path)) return null;
  const entries = parseJSONL(target.path);
  return { entries, path: target.path };
}

function runAnalyze(args, config) {
  stripColor();
  const cwd = process.cwd();
  const sessionPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const session = loadSession(sessionPath, cwd);

  if (!session) {
    console.log('');
    console.log(C.yellow + '  ⚠️  Aktif Claude Code session bulunamadı' + C.reset);
    console.log(C.gray + '     Claude Code çalışıyor mu? ya da: ctx file <jsonl-path>' + C.reset);
    console.log('');
    return 1;
  }

  const analysis = analyzeEntries(session.entries, config);
  const modelId  = detectModel(session.entries);
  const limits   = getLimits(modelId, config);
  const decision = makeDecision(analysis, limits, config);
  const strategy = buildStrategy(analysis, decision, config);

  printAnalysis(analysis, decision, strategy, session.path, modelId);
  return 0;
}

function runCompact(args, config) {
  stripColor();
  const cwd = process.cwd();
  const sessionPath = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const session = loadSession(sessionPath, cwd);

  if (!session) {
    console.error('❌ Aktif session yok');
    return 1;
  }

  const analysis = analyzeEntries(session.entries, config);
  const modelId  = detectModel(session.entries);
  const limits   = getLimits(modelId, config);
  const decision = makeDecision(analysis, limits, config);
  const strategy = buildStrategy(analysis, decision, config);

  const clipboardOk = copyToClipboard(strategy.compactPrompt);
  printCompactResult(analysis, decision, strategy, session.path, modelId, clipboardOk);
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

  const session = loadSession(sessionPath, cwd);
  if (!session) {
    console.error('❌ Aktif session yok');
    return 1;
  }

  const analysis = analyzeEntries(session.entries, config);
  const modelId  = detectModel(session.entries);
  const limits   = getLimits(modelId, config);
  const decision = makeDecision(analysis, limits, config);
  const strategy = buildStrategy(analysis, decision, config);

  const sessionId = path.basename(session.path, '.jsonl');
  const result = writeSnapshot(analysis, decision, strategy, {
    cwd,
    config,
    customName,
    sessionId,
    modelId,
  });

  printSnapshotResult(result.outPath, result.indexUpdated);
  return 0;
}

function runHistory(args, config) {
  stripColor();
  const n = parseInt(args[0], 10) || 10;
  const sessions = listAllSessions().slice(0, n);

  if (!sessions.length) {
    console.log(C.gray + '  Session bulunamadı' + C.reset);
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
  console.log(`  ${created ? C.green + '✓ Oluşturuldu:' : '📄 Config:'}${C.reset} ${USER_PATH}`);
  console.log(C.gray + `  default:      ${DEFAULT_PATH}` + C.reset);
  console.log('');
  console.log(C.dim + '  Düzenle: $EDITOR ~/.config/ctx/config.json' + C.reset);
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
      console.error(`❌ Bilinmeyen daemon komutu: ${sub}`);
      console.error(`   ctx daemon start|stop|status|log`);
      return 1;
  }
}

function runFile(args, config) {
  stripColor();
  if (!args[0]) {
    console.error('❌ ctx file <path> — yol gerekli');
    return 1;
  }
  return runAnalyze([args[0]], config);
}

function main(argv) {
  const [, , cmd, ...rest] = argv;
  const config = loadConfig();

  switch (cmd) {
    case undefined:
    case 'analyze':
      return runAnalyze(rest, config);
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
    case '--help':
    case '-h':
    case 'help':
      printHelp();
      return 0;
    default:
      if (cmd && !cmd.startsWith('-') && fs.existsSync(path.resolve(cmd))) {
        return runAnalyze([cmd], config);
      }
      console.error(`❌ Bilinmeyen komut: ${cmd}`);
      printHelp();
      return 1;
  }
}

module.exports = { main };
