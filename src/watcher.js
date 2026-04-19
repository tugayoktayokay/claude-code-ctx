'use strict';

const fs   = require('fs');
const path = require('path');
const { findLatestSession, parseJSONL } = require('./session.js');
const { analyzeEntries } = require('./analyzer.js');
const { makeDecision } = require('./decision.js');
const { detectModel, getLimits } = require('./models.js');
const { printWatchTick, macNotify, C } = require('./output.js');

function watchLoop(cwd, config) {
  const intervalMs = config?.watch?.interval_ms || 10000;
  const notif      = config?.watch?.macos_notifications !== false;
  const status     = config?.watch?.terminal_status !== false;

  let lastLevel  = null;
  let lastPath   = null;
  let lastSize   = 0;
  let alertedAt  = new Set();

  console.log('');
  console.log(C.bold + '  ctx watch — live token % monitor' + C.reset);
  console.log(C.gray + `  interval: ${intervalMs / 1000}s   Ctrl+C to exit` + C.reset);
  console.log('');

  const tick = () => {
    let session;
    try { session = findLatestSession(cwd); } catch { session = null; }
    if (!session) {
      if (status) process.stdout.write(`\r  ${C.gray}(waiting for session...)${C.reset}   `);
      return;
    }

    let stat;
    try { stat = fs.statSync(session.path); } catch { return; }
    if (session.path === lastPath && stat.size === lastSize) return;
    lastPath = session.path;
    lastSize = stat.size;

    let entries;
    try { entries = parseJSONL(session.path); } catch { return; }
    if (!entries.length) return;

    const analysis = analyzeEntries(entries, config);
    const modelId  = detectModel(entries);
    const limits   = getLimits(modelId, config);
    const decision = makeDecision(analysis, limits, config);

    if (status) {
      const line = printWatchTick(decision);
      process.stdout.write('\r' + line + '   ');
    }

    if (decision.level !== lastLevel) {
      process.stdout.write('\n');
      const line = printWatchTick(decision);
      console.log(line);
      if (notif && ['compact', 'urgent', 'critical'].includes(decision.level)) {
        const alertKey = `${session.path}_${decision.level}`;
        if (!alertedAt.has(alertKey)) {
          alertedAt.add(alertKey);
          macNotify(
            `ctx — ${decision.level}`,
            `Context %${decision.metrics.contextPct} — ${decision.action || ''}`
          );
        }
      }
      lastLevel = decision.level;
    }
  };

  tick();
  const iv = setInterval(tick, intervalMs);

  process.on('SIGINT', () => {
    clearInterval(iv);
    console.log('\n\n' + C.green + '  ✅ Watch stopped' + C.reset + '\n');
    process.exit(0);
  });
}

module.exports = { watchLoop };
