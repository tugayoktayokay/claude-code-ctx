'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_PATH = path.join(__dirname, '..', 'config.default.json');
const USER_DIR     = path.join(os.homedir(), '.config', 'ctx');
const USER_PATH    = path.join(USER_DIR, 'config.json');

function loadDefaults() {
  return JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8'));
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override !== undefined ? override : base;
}

function loadConfig() {
  const defaults = loadDefaults();
  if (!fs.existsSync(USER_PATH)) return defaults;
  try {
    const user = JSON.parse(fs.readFileSync(USER_PATH, 'utf8'));
    return deepMerge(defaults, user);
  } catch (err) {
    console.error(`⚠️  ~/.config/ctx/config.json geçersiz JSON: ${err.message} — default'lar kullanılıyor`);
    return defaults;
  }
}

function ensureUserConfig() {
  if (fs.existsSync(USER_PATH)) return USER_PATH;
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.copyFileSync(DEFAULT_PATH, USER_PATH);
  return USER_PATH;
}

module.exports = {
  DEFAULT_PATH,
  USER_PATH,
  loadDefaults,
  loadConfig,
  ensureUserConfig,
  deepMerge,
};
