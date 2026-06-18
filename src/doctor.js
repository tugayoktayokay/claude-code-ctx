'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const hooksInstall = require('./hooks_install.js');
const { PID_FILE, LOG_FILE } = require('./daemon.js');
const { loadConfig, USER_PATH, DEFAULT_PATH } = require('./config.js');
const { CTX_HOOK_EVENTS } = hooksInstall;

const HOOKS_LOG_FILE = path.join(os.homedir(), '.config', 'ctx', 'hooks.log');

const CHECKS = {
  ok:   { icon: '✓', level: 'ok' },
  warn: { icon: '⚠', level: 'warn' },
  fail: { icon: '✗', level: 'fail' },
  info: { icon: 'ℹ', level: 'info' },
};

function runChecks({ cwdBinary = process.argv[1] } = {}) {
  const results = [];

  results.push(checkNodeVersion());
  results.push(checkBm25Cache());
  results.push(checkWorkingMemory());
  results.push(...checkConfig());
  results.push(...checkHooksInstalled(cwdBinary));
  results.push(...checkPluginVersionDrift());
  results.push(...checkFeatureWiring());
  results.push(...checkRuntimeDrift());
  results.push(...checkDaemon());
  results.push(...checkBinaryPath(cwdBinary));
  results.push(checkLogRotation());

  return results;
}

function localPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

function checkNodeVersion() {
  const ver = process.version;
  const major = parseInt(ver.replace(/^v/, '').split('.')[0], 10);
  if (major >= 18) return { ...CHECKS.ok, label: 'Node version', detail: ver };
  return { ...CHECKS.fail, label: 'Node version', detail: `${ver} — need 18+` };
}

function checkBm25Cache() {
  const dir = path.join(os.homedir(), '.config', 'ctx', 'bm25');
  if (!fs.existsSync(dir)) {
    return { ...CHECKS.info, label: 'BM25 cache', detail: 'not built yet' };
  }
  try {
    const names = fs.readdirSync(dir).filter(n => n.endsWith('.json.gz'));
    let total = 0;
    for (const n of names) total += fs.statSync(path.join(dir, n)).size;
    return { ...CHECKS.ok, label: 'BM25 cache', detail: `${names.length} project(s), ${Math.round(total / 1024)} KB` };
  } catch (err) {
    return { ...CHECKS.warn, label: 'BM25 cache', detail: `unreadable: ${err.message}` };
  }
}

function checkWorkingMemory() {
  const dir = process.env.CTX_WORKING_MEMORY_DIR
    || path.join(os.homedir(), '.config', 'ctx', 'working_memory');
  if (!fs.existsSync(dir)) {
    return { ...CHECKS.info, label: 'Working memory dir', detail: 'not yet created (will create on first use)' };
  }
  try {
    const names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
    return { ...CHECKS.ok, label: 'Working memory dir', detail: `${names.length} session file(s)` };
  } catch (err) {
    return { ...CHECKS.warn, label: 'Working memory dir', detail: `unreadable: ${err.message}` };
  }
}

function checkConfig() {
  const out = [];
  if (!fs.existsSync(DEFAULT_PATH)) {
    out.push({ ...CHECKS.fail, label: 'Defaults config', detail: `missing: ${DEFAULT_PATH}` });
  } else {
    try {
      JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8'));
      out.push({ ...CHECKS.ok, label: 'Defaults config', detail: DEFAULT_PATH });
    } catch (err) {
      out.push({ ...CHECKS.fail, label: 'Defaults config', detail: `invalid JSON: ${err.message}` });
    }
  }
  if (!fs.existsSync(USER_PATH)) {
    out.push({ ...CHECKS.info, label: 'User config', detail: `not created (using defaults)` });
  } else {
    try {
      JSON.parse(fs.readFileSync(USER_PATH, 'utf8'));
      out.push({ ...CHECKS.ok, label: 'User config', detail: USER_PATH });
    } catch (err) {
      out.push({ ...CHECKS.fail, label: 'User config', detail: `invalid JSON: ${err.message}` });
    }
  }
  try { loadConfig(); out.push({ ...CHECKS.ok, label: 'Config merge', detail: 'deepMerge OK' }); }
  catch (err) { out.push({ ...CHECKS.fail, label: 'Config merge', detail: err.message }); }
  return out;
}

function checkPluginRegistration() {
  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) return null;
  try {
    const reg = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const plugins = reg?.plugins || {};
    for (const key of Object.keys(plugins)) {
      if (key.startsWith('claude-code-ctx@') || key === 'claude-code-ctx' || key.startsWith('ctx@') || key === 'ctx') {
        const entries = plugins[key];
        const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
        return { ...CHECKS.ok, label: 'Plugin install', detail: `${key} v${latest?.version || '?'} (${latest?.installPath || 'unknown'})` };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function findCtxPluginInstall() {
  const installedPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installedPath)) return null;
  try {
    const reg = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    const plugins = reg?.plugins || {};
    for (const key of Object.keys(plugins)) {
      if (key.startsWith('claude-code-ctx@') || key === 'claude-code-ctx' || key.startsWith('ctx@') || key === 'ctx') {
        const entries = plugins[key];
        const latest = Array.isArray(entries) ? entries[entries.length - 1] : entries;
        return { key, ...latest };
      }
    }
  } catch {}
  return null;
}

function hookMatchers(installPath, eventName) {
  if (!installPath) return null;
  const manifestPath = path.join(installPath, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const plugin = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const groups = plugin?.hooks?.[eventName] || [];
    return new Set(groups.map(g => g.matcher || '*'));
  } catch {
    return null;
  }
}

function pluginPreToolMatchers(installPath) {
  return hookMatchers(installPath, 'PreToolUse');
}

function checkFeatureWiring() {
  const out = [];
  let config;
  try { config = loadConfig(); } catch { return out; }

  const plugin = findCtxPluginInstall();
  const matchers = pluginPreToolMatchers(plugin?.installPath);
  if (!matchers) return out;
  if (matchers.has('*')) return out;

  const missing = [];
  if (config?.working_memory?.enabled && !matchers.has('Read')) {
    missing.push('Read');
  }
  if (config?.working_memory?.enabled && config?.working_memory?.bash_dedup?.enabled && !matchers.has('Bash')) {
    missing.push('Bash');
  }

  if (missing.length) {
    out.push({
      ...CHECKS.warn,
      label: 'Feature wiring',
      detail: `working_memory enabled but plugin PreToolUse does not reach: ${missing.join(', ')} — run /plugin update claude-code-ctx`,
    });
  } else {
    out.push({ ...CHECKS.ok, label: 'Feature wiring', detail: 'enabled features are reachable from plugin manifest' });
  }
  return out;
}

function checkPluginVersionDrift() {
  const plugin = findCtxPluginInstall();
  if (!plugin) return [];
  const localVersion = localPackageVersion();
  const installedVersion = plugin.version || null;
  if (!localVersion || !installedVersion || installedVersion === localVersion) {
    return [{ ...CHECKS.ok, label: 'Plugin version', detail: installedVersion ? `installed v${installedVersion}` : 'installed version unknown' }];
  }
  return [{
    ...CHECKS.warn,
    label: 'Plugin version',
    detail: `installed v${installedVersion}, source v${localVersion} — run /plugin marketplace update claude-code-ctx && /plugin update claude-code-ctx`,
  }];
}

const DRIFT_DEFAULTS = {
  deny_min_total: 5,
  deny_obey_threshold: 0.5,
  ask_min_total: 5,
  ask_cancel_threshold: 0.5,
  cache_min_writes: 10,
  wm_recording_min_bash: 10,
  range_days: 7,
};

// Pure: detect a silently-dead recorder. When working_memory is enabled and
// bash-call recording is clearly active (>= minBash) but zero reads have been
// recorded, the read recorder is almost certainly broken (e.g. a tool_response
// shape mismatch) rather than idle. Coarse "zero wm events" checks miss this
// because bash activity masks it.
function recordingDriftWarning({ enabled, readsRecorded, bashRecorded, minBash }) {
  if (!enabled) return null;
  if ((bashRecorded || 0) >= minBash && (readsRecorded || 0) === 0) {
    return `${bashRecorded} bash calls recorded but 0 reads in the working_memory store — read content is not being captured (tool_response shape mismatch?), so read-dedup cannot fire`;
  }
  return null;
}

// Sum reads/bash_calls across recent working_memory session files.
function sumWorkingMemoryStore(dir, since = 0) {
  let reads = 0;
  let bash = 0;
  let sessions = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.json')) continue;
      const full = path.join(dir, n);
      try {
        if (since && fs.statSync(full).mtimeMs < since) continue;
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        reads += Object.keys(j.reads || {}).length;
        bash += Object.keys(j.bash_calls || {}).length;
        sessions += 1;
      } catch { /* skip unreadable/partial file */ }
    }
  } catch { /* dir missing */ }
  return { reads, bash, sessions };
}

function driftThresholds(config) {
  const cfg = config?.doctor?.drift || {};
  const out = {};
  for (const k of Object.keys(DRIFT_DEFAULTS)) {
    out[k] = Number.isFinite(cfg[k]) ? cfg[k] : DRIFT_DEFAULTS[k];
  }
  return out;
}

function checkRuntimeDrift(opts = {}) {
  const out = [];
  // Injectable clock: tests pin `now` so fixed-timestamp fixtures don't rot
  // out of the rolling window as wall-clock advances past range_days.
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let config;
  try { config = loadConfig(); } catch { return out; }
  const t = driftThresholds(config);

  if (!fs.existsSync(HOOKS_LOG_FILE)) {
    out.push({ ...CHECKS.info, label: 'Runtime drift', detail: 'hooks.log not created yet' });
    return out;
  }

  let record;
  try {
    const metrics = require('./metrics.js');
    record = metrics.aggregate(HOOKS_LOG_FILE, { now, rangeDays: t.range_days });
  } catch (err) {
    out.push({ ...CHECKS.warn, label: 'Runtime drift', detail: `metrics unavailable: ${err.message}` });
    return out;
  }

  const wm = record.working_memory || {};
  const wmEvents = (wm.dedup_hits || 0) + (wm.recall_calls || 0) + (wm.bash_dedup_hits || 0);
  if (config?.working_memory?.enabled && record.pre_tool?.total > 0 && wmEvents === 0) {
    out.push({ ...CHECKS.warn, label: 'Runtime drift', detail: `working_memory enabled but no working_memory events in last ${t.range_days}d` });
  }

  // Granular: a recorder can be silently dead while bash activity masks the
  // coarse check above (read-dedup death, v0.8.13). Scan the store directly.
  if (config?.working_memory?.enabled) {
    const wmDir = process.env.CTX_WORKING_MEMORY_DIR
      || path.join(os.homedir(), '.config', 'ctx', 'working_memory');
    const store = sumWorkingMemoryStore(wmDir, now - t.range_days * 86_400_000);
    const recDetail = recordingDriftWarning({
      enabled: true,
      readsRecorded: store.reads,
      bashRecorded: store.bash,
      minBash: t.wm_recording_min_bash,
    });
    if (recDetail) out.push({ ...CHECKS.warn, label: 'Working memory recording', detail: recDetail });
  }

  const deny = record.pre_tool?.deny || {};
  if ((deny.total || 0) >= t.deny_min_total && (deny.obeyed || 0) / deny.total < t.deny_obey_threshold) {
    out.push({ ...CHECKS.warn, label: 'Deny obey rate', detail: `${deny.obeyed}/${deny.total} obeyed in last ${t.range_days}d — deny guidance may be too vague` });
  }

  const ask = record.pre_tool?.ask || {};
  if ((ask.total || 0) >= t.ask_min_total && (ask.canceled || 0) / ask.total > t.ask_cancel_threshold) {
    out.push({ ...CHECKS.warn, label: 'Ask cancel rate', detail: `${ask.canceled}/${ask.total} canceled in last ${t.range_days}d — inspect top canceled rules` });
  }

  const cache = record.cache || {};
  const hintWrites = cache.hint_writes ?? cache.writes ?? 0;
  if (hintWrites >= t.cache_min_writes && (cache.read_hits || 0) === 0) {
    out.push({ ...CHECKS.warn, label: 'Cache reuse', detail: `${hintWrites} recallable writes but 0 hit reads in last ${t.range_days}d — ctx_cache_get guidance is not being followed` });
  }

  if (!out.length) {
    out.push({ ...CHECKS.ok, label: 'Runtime drift', detail: 'recent hook metrics look consistent' });
  }
  return out;
}

function checkHooksInstalled(cwdBinary) {
  const out = [];

  const plugin = checkPluginRegistration();
  if (plugin) {
    out.push(plugin);
    out.push({ ...CHECKS.info, label: 'Manual hooks', detail: 'not needed (plugin provides them)' });
    return out;
  }

  const settingsPath = hooksInstall.defaultSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    out.push({ ...CHECKS.warn, label: 'Claude Code settings', detail: `not found: ${settingsPath} — run 'ctx setup' or install as plugin` });
    return out;
  }
  let settings;
  try { settings = hooksInstall.readSettings(settingsPath); }
  catch (err) {
    out.push({ ...CHECKS.fail, label: 'Claude Code settings', detail: `parse error: ${err.message}` });
    return out;
  }

  const installed = hooksInstall.listInstalledEvents(settings);
  const expected  = Object.keys(CTX_HOOK_EVENTS);
  if (!installed.length) {
    out.push({ ...CHECKS.warn, label: 'Hooks', detail: `not installed — run 'ctx setup' or install as plugin` });
    return out;
  }
  const missing = expected.filter(e => !installed.includes(e));
  if (missing.length) {
    out.push({ ...CHECKS.warn, label: 'Hooks', detail: `missing events: ${missing.join(', ')} — run 'ctx install-hooks'` });
  } else {
    out.push({ ...CHECKS.ok, label: 'Hooks', detail: `${installed.length}/${expected.length} events installed` });
  }

  const expectedCmd = cwdBinary && fs.existsSync(cwdBinary) && path.basename(cwdBinary) === 'ctx' ? cwdBinary : 'ctx';
  let orphanCount = 0;
  for (const groups of Object.values(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (h?.source === 'ctx' && typeof h.command === 'string') {
          const bin = h.command.split(/\s+/)[0];
          if (bin !== expectedCmd && bin !== 'ctx' && !fs.existsSync(bin)) {
            orphanCount++;
          }
        }
      }
    }
  }
  if (orphanCount > 0) {
    out.push({ ...CHECKS.warn, label: 'Hook binary path', detail: `${orphanCount} ctx hook(s) point to missing binary — run 'ctx install-hooks' to refresh` });
  } else {
    out.push({ ...CHECKS.ok, label: 'Hook binary path', detail: 'all ctx hooks point to a reachable binary' });
  }
  return out;
}

function checkDaemon() {
  const out = [];
  if (!fs.existsSync(PID_FILE)) {
    out.push({ ...CHECKS.info, label: 'Daemon', detail: 'not running (optional — hooks handle primary path)' });
    return out;
  }
  let pid;
  try { pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim()); } catch { pid = null; }
  if (!Number.isFinite(pid)) {
    out.push({ ...CHECKS.warn, label: 'Daemon', detail: `pid file corrupt: ${PID_FILE}` });
    return out;
  }
  try { process.kill(pid, 0); out.push({ ...CHECKS.ok, label: 'Daemon', detail: `running (pid ${pid})` }); }
  catch { out.push({ ...CHECKS.warn, label: 'Daemon', detail: `stale pid file (${pid}) — daemon not alive` }); }
  return out;
}

function checkBinaryPath(bin) {
  const out = [];
  if (bin && fs.existsSync(bin)) {
    out.push({ ...CHECKS.ok, label: 'ctx binary', detail: bin });
  } else if (bin) {
    out.push({ ...CHECKS.fail, label: 'ctx binary', detail: `argv[1] missing: ${bin}` });
  }
  return out;
}

function checkLogRotation() {
  if (!fs.existsSync(LOG_FILE)) {
    return { ...CHECKS.info, label: 'Daemon log', detail: 'not created yet' };
  }
  try {
    const size = fs.statSync(LOG_FILE).size;
    if (size > 5 * 1024 * 1024) {
      return { ...CHECKS.warn, label: 'Daemon log', detail: `${(size / 1024 / 1024).toFixed(1)} MB — consider rotating` };
    }
    return { ...CHECKS.ok, label: 'Daemon log', detail: `${(size / 1024).toFixed(1)} KB` };
  } catch {
    return { ...CHECKS.warn, label: 'Daemon log', detail: 'unreadable' };
  }
}

module.exports = { runChecks, CHECKS, checkFeatureWiring, checkRuntimeDrift, checkPluginVersionDrift, localPackageVersion, recordingDriftWarning, sumWorkingMemoryStore };
