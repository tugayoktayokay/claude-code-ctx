'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  installHooks,
  uninstallHooks,
  listInstalledEvents,
  readSettings,
  writeSettings,
  backupSettings,
  isCtxEntry,
  CTX_HOOK_EVENTS,
} = require('../hooks_install.js');

test('installHooks adds all events into empty settings', () => {
  const next = installHooks({});
  assert.ok(next.hooks);
  for (const ev of Object.keys(CTX_HOOK_EVENTS)) {
    assert.ok(Array.isArray(next.hooks[ev]), `event ${ev} has array`);
    const flat = next.hooks[ev].flatMap(g => g.hooks || []);
    assert.ok(flat.some(isCtxEntry), `event ${ev} has ctx entry`);
  }
});

test('installHooks honors explicit commandPrefix (absolute path)', () => {
  const next = installHooks({}, { commandPrefix: '/opt/bin/ctx' });
  const flat = next.hooks.Stop.flatMap(g => g.hooks || []);
  const stopEntry = flat.find(isCtxEntry);
  assert.match(stopEntry.command, /^\/opt\/bin\/ctx /, `got: ${stopEntry.command}`);
});

test('installHooks preserves foreign user hooks', () => {
  const user = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'my-own-script' }] },
      ],
      OtherEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
    },
    otherKey: 'keep-me',
  };
  const next = installHooks(user);
  assert.equal(next.otherKey, 'keep-me');
  assert.ok(next.hooks.OtherEvent, 'foreign event preserved');
  const stopGroups = next.hooks.Stop;
  const userStill = stopGroups.some(g => (g.hooks || []).some(h => h.command === 'my-own-script'));
  assert.ok(userStill, 'user own Stop hook preserved');
  const ctxAdded = stopGroups.some(g => (g.hooks || []).some(isCtxEntry));
  assert.ok(ctxAdded, 'ctx Stop hook added alongside');
});

test('installHooks is idempotent — no duplicate ctx entries', () => {
  const once = installHooks({});
  const twice = installHooks(once);
  for (const ev of Object.keys(CTX_HOOK_EVENTS)) {
    const ctxCount = (twice.hooks[ev] || []).flatMap(g => g.hooks || []).filter(isCtxEntry).length;
    assert.equal(ctxCount, 1, `${ev} has exactly one ctx entry after double install`);
  }
});

test('uninstallHooks removes only ctx entries; keeps foreign', () => {
  const user = {
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: 'my-own-script' }] },
      ],
    },
  };
  const installed = installHooks(user);
  const removed = uninstallHooks(installed);

  const stopGroups = removed.hooks.Stop || [];
  const flat = stopGroups.flatMap(g => g.hooks || []);
  assert.equal(flat.filter(isCtxEntry).length, 0, 'no ctx entries remain');
  assert.ok(flat.some(h => h.command === 'my-own-script'), 'foreign hook kept');
});

test('uninstallHooks leaves empty settings untouched structurally', () => {
  const empty = {};
  const installed = installHooks(empty);
  const removed = uninstallHooks(installed);
  assert.deepEqual(removed.hooks, {}, 'all ctx-only events cleaned out');
});

test('listInstalledEvents returns events with ctx entries only', () => {
  const user = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'u' }] }] } };
  assert.deepEqual(listInstalledEvents(user), []);
  const installed = installHooks(user);
  const events = listInstalledEvents(installed);
  assert.ok(events.length === Object.keys(CTX_HOOK_EVENTS).length);
});

test('read/write/backup round-trip on a temp file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-inst-'));
  const target = path.join(tmp, 'settings.json');
  fs.writeFileSync(target, JSON.stringify({ some: 'value' }, null, 2));

  const read1 = readSettings(target);
  assert.equal(read1.some, 'value');

  const backupPath = backupSettings(target);
  assert.ok(backupPath && fs.existsSync(backupPath));

  const installed = installHooks(read1);
  writeSettings(installed, target);
  const read2 = readSettings(target);
  assert.ok(read2.hooks);

  fs.rmSync(tmp, { recursive: true, force: true });
});
