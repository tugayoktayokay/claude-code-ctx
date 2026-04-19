'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const SOURCE_TAG    = 'ctx';
const SCHEMA_VERSION = 1;

const CTX_HOOK_EVENTS = {
  SessionStart: {
    command: 'ctx hook session-start',
    matcher: null,
  },
  Stop: {
    command: 'ctx hook stop',
    matcher: null,
  },
  PreCompact: {
    command: 'ctx hook pre-compact',
    matcher: null,
  },
  PreToolUse: {
    command: 'ctx hook pre-tool-use',
    matcher: 'Bash',
  },
  PostToolUse: {
    command: 'ctx hook post-tool-use',
    matcher: 'Bash',
  },
  UserPromptSubmit: {
    command: 'ctx hook user-prompt-submit',
    matcher: null,
  },
};

function defaultSettingsPath() {
  return SETTINGS_PATH;
}

function readSettings(settingsPath = SETTINGS_PATH) {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`settings.json parse failed: ${err.message}`);
  }
}

function writeSettings(settings, settingsPath = SETTINGS_PATH) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.settings.json.ctx-tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, settingsPath);
}

function resolveCtxCommand() {
  const scriptPath = process.argv[1];
  if (scriptPath && fs.existsSync(scriptPath) && path.basename(scriptPath) === 'ctx') {
    return scriptPath;
  }
  return 'ctx';
}

function backupSettings(settingsPath = SETTINGS_PATH) {
  if (!fs.existsSync(settingsPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${settingsPath}.ctx-backup-${ts}`;
  fs.copyFileSync(settingsPath, backupPath);
  return backupPath;
}

function makeCtxEntry(commandStr) {
  return {
    type: 'command',
    command: commandStr,
    source: SOURCE_TAG,
    ctxSchemaVersion: SCHEMA_VERSION,
  };
}

function isCtxEntry(entry) {
  return entry && typeof entry === 'object' && entry.source === SOURCE_TAG;
}

function installHooks(settings, opts = {}) {
  const commandPrefix = opts.commandPrefix || resolveCtxCommand();
  const out = { ...settings };
  out.hooks = { ...(settings.hooks || {}) };

  for (const [eventName, spec] of Object.entries(CTX_HOOK_EVENTS)) {
    const existing = Array.isArray(out.hooks[eventName]) ? [...out.hooks[eventName]] : [];
    const stripped = existing.filter(group => {
      if (!group || typeof group !== 'object') return true;
      const hooksArr = Array.isArray(group.hooks) ? group.hooks : [];
      return !hooksArr.some(isCtxEntry);
    });

    const command = spec.command.replace(/^ctx\b/, commandPrefix);
    const newEntry = makeCtxEntry(command);
    const group = spec.matcher
      ? { matcher: spec.matcher, hooks: [newEntry] }
      : { hooks: [newEntry] };

    stripped.push(group);
    out.hooks[eventName] = stripped;
  }

  out.mcpServers = { ...(settings.mcpServers || {}) };
  const serveCmd = commandPrefix;
  out.mcpServers.ctx = {
    command: serveCmd,
    args: ['serve'],
    source: SOURCE_TAG,
    ctxSchemaVersion: SCHEMA_VERSION,
  };

  return out;
}

function uninstallHooks(settings) {
  const out = { ...settings };
  if (out.hooks && typeof out.hooks === 'object') {
    const nextHooks = {};
    for (const [eventName, groups] of Object.entries(out.hooks)) {
      if (!Array.isArray(groups)) { nextHooks[eventName] = groups; continue; }
      const filtered = [];
      for (const group of groups) {
        if (!group || typeof group !== 'object') { filtered.push(group); continue; }
        const hooksArr = Array.isArray(group.hooks) ? group.hooks : [];
        const kept = hooksArr.filter(h => !isCtxEntry(h));
        if (kept.length === 0 && hooksArr.length > 0) continue;
        if (kept.length !== hooksArr.length) {
          filtered.push({ ...group, hooks: kept });
        } else {
          filtered.push(group);
        }
      }
      if (filtered.length > 0) nextHooks[eventName] = filtered;
    }
    out.hooks = nextHooks;
  }

  if (out.mcpServers && typeof out.mcpServers === 'object') {
    const nextMcp = {};
    for (const [k, v] of Object.entries(out.mcpServers)) {
      if (v && v.source === SOURCE_TAG) continue;
      nextMcp[k] = v;
    }
    out.mcpServers = nextMcp;
  }

  return out;
}

function listInstalledEvents(settings) {
  if (!settings?.hooks) return [];
  const events = [];
  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooksArr = Array.isArray(group?.hooks) ? group.hooks : [];
      if (hooksArr.some(isCtxEntry)) {
        events.push(eventName);
        break;
      }
    }
  }
  return events;
}

module.exports = {
  SETTINGS_PATH,
  SOURCE_TAG,
  SCHEMA_VERSION,
  CTX_HOOK_EVENTS,
  defaultSettingsPath,
  readSettings,
  writeSettings,
  backupSettings,
  installHooks,
  uninstallHooks,
  listInstalledEvents,
  isCtxEntry,
  makeCtxEntry,
  resolveCtxCommand,
};
