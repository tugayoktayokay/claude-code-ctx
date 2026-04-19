'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync, spawn } = require('child_process');

const { findLatestSession, parseJSONL } = require('./session.js');
const { analyzeEntries } = require('./analyzer.js');
const { makeDecision }   = require('./decision.js');
const { detectModel, getLimits } = require('./models.js');
const { macNotify, C }   = require('./output.js');

const STATE_DIR  = path.join(os.homedir(), '.config', 'ctx');
const PID_FILE   = path.join(STATE_DIR, 'daemon.pid');
const LOG_FILE   = path.join(STATE_DIR, 'daemon.log');
const STATE_FILE = path.join(STATE_DIR, 'daemon.state.json');

function ensureDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function log(msg) {
  ensureDir();
  const ts = new Date().toISOString();
  try { fs.appendFileSync(LOG_FILE, `${ts} ${msg}\n`); } catch {}
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { startedAt: Date.now(), lastLevel: null, lastCommit: null, notifiedAt: {} }; }
}

function saveState(state) {
  ensureDir();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isFinite(pid) && pidAlive(pid)) return pid;
  } catch {}
  return null;
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim();
  } catch { return null; }
}

function gitSubject(cwd) {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim();
  } catch { return null; }
}

function tick(cwd, config, state) {
  let session;
  try { session = findLatestSession(cwd); } catch { return; }
  if (!session) return;

  let entries;
  try { entries = parseJSONL(session.path); } catch { return; }
  if (!entries.length) return;

  const analysis = analyzeEntries(entries, config);
  const modelId  = detectModel(entries);
  const limits   = getLimits(modelId, config);
  const decision = makeDecision(analysis, limits, config);

  if (decision.level !== state.lastLevel && ['compact', 'urgent', 'critical'].includes(decision.level)) {
    const key = `level:${decision.level}`;
    const last = state.notifiedAt[key] || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      state.notifiedAt[key] = Date.now();
      macNotify(
        `ctx — ${decision.level}`,
        `Context ${decision.metrics.contextPct}% — ${decision.action || ''}`
      );
      log(`[level] ${decision.level} at ${decision.metrics.contextPct}%`);
    }
  }
  state.lastLevel = decision.level;

  const head = gitHead(cwd);
  if (head && state.lastCommit && head !== state.lastCommit) {
    const subject = gitSubject(cwd) || head.slice(0, 8);
    macNotify(
      'ctx — new commit',
      `"${subject.slice(0, 60)}" — good moment for a snapshot`
    );
    log(`[git] new commit ${head.slice(0, 8)} "${subject.slice(0, 80)}"`);
  }
  if (head) state.lastCommit = head;
}

function runLoop(cwd, config) {
  ensureDir();
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
  log(`[start] pid=${process.pid} cwd=${cwd}`);

  let state = loadState();
  state.startedAt = Date.now();
  state.cwd = cwd;
  const head = gitHead(cwd);
  if (head) state.lastCommit = head;
  saveState(state);

  const intervalMs = config?.watch?.interval_ms || 10000;
  const iv = setInterval(() => {
    try {
      state = loadState();
      tick(cwd, config, state);
      saveState(state);
    } catch (err) {
      log(`[error] ${err.message}`);
    }
  }, intervalMs);

  const shutdown = (sig) => {
    clearInterval(iv);
    log(`[stop] signal=${sig}`);
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  tick(cwd, config, state);
  saveState(state);
}

function start(cwd, config, { detach = true } = {}) {
  ensureDir();
  const existing = readPid();
  if (existing) {
    console.log(C.yellow + `  ⚠️  Daemon already running (pid ${existing})` + C.reset);
    console.log(C.gray + `     Stop it with: ctx daemon stop` + C.reset);
    return 1;
  }
  try { fs.unlinkSync(PID_FILE); } catch {}

  if (!detach) {
    runLoop(cwd, config);
    return 0;
  }

  const out = fs.openSync(LOG_FILE, 'a');
  const err = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [process.argv[1], 'daemon', '__run__', cwd], {
    detached: true,
    stdio: ['ignore', out, err],
    env: { ...process.env, CTX_DAEMON_CHILD: '1' },
  });
  child.unref();

  console.log('');
  console.log(C.green + `  ✓ ctx daemon started (pid ${child.pid})` + C.reset);
  console.log(C.gray + `    cwd: ${cwd}` + C.reset);
  console.log(C.gray + `    log: ${LOG_FILE}` + C.reset);
  console.log(C.gray + `    stop: ctx daemon stop` + C.reset);
  console.log('');
  return 0;
}

function stop() {
  const pid = readPid();
  if (!pid) {
    console.log(C.gray + '  ℹ️  No daemon running' + C.reset);
    try { fs.unlinkSync(PID_FILE); } catch {}
    return 0;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  try { fs.unlinkSync(PID_FILE); } catch {}
  console.log(C.green + `  ✓ daemon stopped (pid ${pid})` + C.reset);
  return 0;
}

function status() {
  const pid = readPid();
  const state = loadState();
  console.log('');
  if (pid) {
    console.log(C.green + `  ✓ daemon running (pid ${pid})` + C.reset);
  } else {
    console.log(C.gray + '  ✗ daemon not running' + C.reset);
  }
  if (state.startedAt) {
    const mins = Math.round((Date.now() - state.startedAt) / 60000);
    console.log(C.gray + `    uptime: ${mins}m` + C.reset);
  }
  if (state.cwd)       console.log(C.gray + `    cwd: ${state.cwd}` + C.reset);
  if (state.lastLevel) console.log(C.gray + `    last level: ${state.lastLevel}` + C.reset);
  if (state.lastCommit)console.log(C.gray + `    last commit: ${state.lastCommit.slice(0, 8)}` + C.reset);
  console.log(C.gray + `    log: ${LOG_FILE}` + C.reset);
  console.log('');
  return pid ? 0 : 1;
}

function tailLog(n = 30) {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(C.gray + '  ℹ️  No log yet' + C.reset);
    return 0;
  }
  const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n);
  console.log('');
  for (const line of lines) console.log('  ' + line);
  console.log('');
  return 0;
}

module.exports = {
  start,
  stop,
  status,
  tailLog,
  runLoop,
  tick,
  gitHead,
  PID_FILE,
  LOG_FILE,
  STATE_FILE,
};
