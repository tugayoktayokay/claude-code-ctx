'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

function withDoctorFixture(matchers, fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-doctor-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  delete require.cache[require.resolve('../config.js')];
  delete require.cache[require.resolve('../doctor.js')];

  const installPath = path.join(tmpHome, '.claude', 'plugins', 'cache', 'claude-code-ctx', 'claude-code-ctx', 'test');
  fs.mkdirSync(path.join(installPath, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'claude-code-ctx',
    version: 'test',
    hooks: {
      PreToolUse: matchers.map(m => ({
        matcher: m,
        hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/ctx hook pre-tool-use' }],
      })),
    },
  }, null, 2));

  const installedPath = path.join(tmpHome, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.writeFileSync(installedPath, JSON.stringify({
    version: 2,
    plugins: {
      'claude-code-ctx@claude-code-ctx': [{
        scope: 'user',
        installPath,
        version: 'test',
      }],
    },
  }, null, 2));

  const configPath = path.join(tmpHome, '.config', 'ctx', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    working_memory: {
      enabled: true,
      bash_dedup: { enabled: true },
    },
  }, null, 2));

  try {
    const doctor = require('../doctor.js');
    return fn(doctor);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    delete require.cache[require.resolve('../config.js')];
    delete require.cache[require.resolve('../doctor.js')];
  }
}

test('doctor warns when enabled working_memory is not reachable from plugin manifest', () => {
  withDoctorFixture(['Bash'], (doctor) => {
    const rows = doctor.checkFeatureWiring();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, 'warn');
    assert.match(rows[0].detail, /Read/);
  });
});

test('doctor accepts plugin manifest that reaches working_memory tool hooks', () => {
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkFeatureWiring();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, 'ok');
  });
});
