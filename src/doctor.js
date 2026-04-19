'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const hooksInstall = require('./hooks_install.js');
const { PID_FILE, LOG_FILE } = require('./daemon.js');
const { loadConfig, USER_PATH, DEFAULT_PATH } = require('./config.js');
const { CTX_HOOK_EVENTS } = hooksInstall;

const CHECKS = {
  ok:   { icon: '✓', level: 'ok' },
  warn: { icon: '⚠', level: 'warn' },
  fail: { icon: '✗', level: 'fail' },
  info: { icon: 'ℹ', level: 'info' },
};

function runChecks({ cwdBinary = process.argv[1] } = {}) {
  const results = [];

  results.push(checkNodeVersion());
  results.push(...checkConfig());
  results.push(...checkHooksInstalled(cwdBinary));
  results.push(...checkDaemon());
  results.push(...checkBinaryPath(cwdBinary));
  results.push(checkLogRotation());

  return results;
}

function checkNodeVersion() {
  const ver = process.version;
  const major = parseInt(ver.replace(/^v/, '').split('.')[0], 10);
  if (major >= 18) return { ...CHECKS.ok, label: 'Node version', detail: ver };
  return { ...CHECKS.fail, label: 'Node version', detail: `${ver} — need 18+` };
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
      if (key.startsWith('ctx@') || key === 'ctx') {
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

module.exports = { runChecks, CHECKS };
