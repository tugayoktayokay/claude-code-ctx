'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

function withDoctorFixture(matchers, fn, opts = {}) {
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
    ...(opts.configOverlay || {}),
  }, null, 2));
  if (opts.hooksLog) {
    const logPath = path.join(tmpHome, '.config', 'ctx', 'hooks.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, opts.hooksLog);
  }
  if (opts.store) {
    const wmDir = path.join(tmpHome, '.config', 'ctx', 'working_memory');
    fs.mkdirSync(wmDir, { recursive: true });
    for (const [sid, state] of Object.entries(opts.store)) {
      fs.writeFileSync(path.join(wmDir, `${sid}.json`), JSON.stringify(state));
    }
  }

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
    assert.match(rows[0].detail, /\/plugin update claude-code-ctx\b/);
    assert.doesNotMatch(rows[0].detail, /claude-code-ctx@claude-code-ctx/);
  });
});

test('doctor warns when runtime metrics show enabled features are unused', () => {
  const hooksLog = [
    '2026-05-18T10:00:00.000Z pre_tool session=S action=deny tool=Bash pattern="^grep" cmd_head="grep -r foo ." reason="recursive"',
    '2026-05-18T10:01:00.000Z cache-write ref=aaa bytes=5000 source=mcp',
    '2026-05-18T10:02:00.000Z cache-write ref=bbb bytes=6000 source=mcp',
    '2026-05-18T10:03:00.000Z cache-write ref=ccc bytes=7000 source=mcp',
    '2026-05-18T10:04:00.000Z cache-write ref=ddd bytes=8000 source=mcp',
    '2026-05-18T10:05:00.000Z cache-write ref=eee bytes=9000 source=mcp',
    '2026-05-18T10:06:00.000Z cache-write ref=fff bytes=10000 source=mcp',
    '2026-05-18T10:07:00.000Z cache-write ref=ggg bytes=11000 source=mcp',
    '2026-05-18T10:08:00.000Z cache-write ref=hhh bytes=12000 source=mcp',
    '2026-05-18T10:09:00.000Z cache-write ref=iii bytes=13000 source=mcp',
    '2026-05-18T10:10:00.000Z cache-write ref=jjj bytes=14000 source=mcp',
  ].join('\n');
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkRuntimeDrift({ now: Date.parse('2026-05-18T11:00:00Z') });
    assert.ok(rows.some(r => r.label === 'Runtime drift' && r.level === 'warn'));
    assert.ok(rows.some(r => r.label === 'Cache reuse' && r.level === 'warn'));
  }, { hooksLog });
});

test('doctor accepts plugin manifest that reaches working_memory tool hooks', () => {
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkFeatureWiring();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, 'ok');
  });
});

test('doctor warns when installed plugin version differs from source version', () => {
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkPluginVersionDrift();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].level, 'warn');
    assert.match(rows[0].detail, /installed vtest, source v/);
    assert.match(rows[0].detail, /\/plugin update claude-code-ctx\b/);
    assert.doesNotMatch(rows[0].detail, /claude-code-ctx@claude-code-ctx/);
  });
});

test('recordingDriftWarning flags enabled wm with bash activity but zero reads recorded', () => {
  const doctor = require('../doctor.js');
  // silent recorder death: bash recording works, reads never land
  assert.ok(doctor.recordingDriftWarning({ enabled: true, readsRecorded: 0, bashRecorded: 30, minBash: 10 }));
  // healthy: reads are being captured
  assert.equal(doctor.recordingDriftWarning({ enabled: true, readsRecorded: 4, bashRecorded: 30, minBash: 10 }), null);
  // too little bash activity to conclude anything
  assert.equal(doctor.recordingDriftWarning({ enabled: true, readsRecorded: 0, bashRecorded: 3, minBash: 10 }), null);
  // feature disabled: never warn
  assert.equal(doctor.recordingDriftWarning({ enabled: false, readsRecorded: 0, bashRecorded: 30, minBash: 10 }), null);
});

test('doctor warns when working_memory records bash calls but never reads (silent recorder death)', () => {
  const hooksLog = '2026-05-18T10:00:00.000Z pre_tool session=S action=deny tool=Bash pattern="^grep" cmd_head="grep -r foo ." reason="recursive"\n';
  const bash = {};
  for (let i = 0; i < 15; i++) bash[`/cwd|cmd${i}`] = [{ turn: i, cmd_norm: `cmd${i}` }];
  const store = { sessA: { session_id: 'sessA', next_turn: 16, reads: {}, bash_calls: bash } };
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkRuntimeDrift();
    assert.ok(rows.some(r => r.label === 'Working memory recording' && r.level === 'warn'),
      `expected recorder-death warn; got: ${rows.map(r => r.label).join(',')}`);
  }, { hooksLog, store });
});

test('doctor does NOT warn recorder-death when reads are being recorded', () => {
  const hooksLog = '2026-05-18T10:00:00.000Z pre_tool session=S action=deny tool=Bash pattern="^grep" cmd_head="grep -r foo ." reason="recursive"\n';
  const bash = {};
  for (let i = 0; i < 15; i++) bash[`/cwd|cmd${i}`] = [{ turn: i, cmd_norm: `cmd${i}` }];
  const store = { sessA: { session_id: 'sessA', next_turn: 16, reads: { '/a.md': [{ turn: 1, hash: 'x', size: 9 }] }, bash_calls: bash } };
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkRuntimeDrift();
    assert.ok(!rows.some(r => r.label === 'Working memory recording'),
      `expected no recorder-death warn; got: ${rows.map(r => r.label).join(',')}`);
  }, { hooksLog, store });
});

test('doctor drift thresholds honor config.doctor.drift overrides', () => {
  // 4 cache writes — below default min (10), would be silent. Lower threshold to 3 → warn fires.
  const hooksLog = [
    '2026-05-18T10:00:00.000Z cache-write ref=a bytes=5000 source=mcp',
    '2026-05-18T10:01:00.000Z cache-write ref=b bytes=5000 source=mcp',
    '2026-05-18T10:02:00.000Z cache-write ref=c bytes=5000 source=mcp',
    '2026-05-18T10:03:00.000Z cache-write ref=d bytes=5000 source=mcp',
  ].join('\n');
  withDoctorFixture(['Bash', 'Read'], (doctor) => {
    const rows = doctor.checkRuntimeDrift({ now: Date.parse('2026-05-18T11:00:00Z') });
    assert.ok(rows.some(r => r.label === 'Cache reuse' && r.level === 'warn'),
      `expected Cache reuse warn at lowered threshold; got: ${rows.map(r=>r.label).join(',')}`);
  }, { hooksLog, configOverlay: { doctor: { drift: { cache_min_writes: 3 } } } });
});
