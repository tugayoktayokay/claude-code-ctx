'use strict';

const fs   = require('fs');
const path = require('path');
const {
  findLatestSession,
  findSessionById,
  parseJSONL,
} = require('./session.js');
const { analyzeEntries }       = require('./analyzer.js');
const { makeDecision }         = require('./decision.js');
const { buildStrategy }        = require('./strategy.js');
const { detectModel, getLimits } = require('./models.js');

function loadSession({ cwd, sessionPath, sessionId }) {
  let target;
  if (sessionPath) {
    target = { path: path.resolve(sessionPath) };
  } else if (sessionId && cwd) {
    target = findSessionById(cwd, sessionId) || findLatestSession(cwd);
  } else {
    target = findLatestSession(cwd);
  }
  if (!target) return null;
  if (!fs.existsSync(target.path)) return null;
  const entries = parseJSONL(target.path);
  return { entries, path: target.path };
}

function runAnalyze({ cwd, sessionPath, sessionId: hintedId, config, entries: entriesIn }) {
  let session;
  let entries;

  if (entriesIn) {
    entries = entriesIn;
    session = { path: sessionPath || null, entries };
  } else {
    session = loadSession({ cwd, sessionPath, sessionId: hintedId });
    if (!session) return null;
    entries = session.entries;
  }

  const analysis = analyzeEntries(entries, config);
  const modelId  = detectModel(entries);
  const limits   = getLimits(modelId, config);
  const decision = makeDecision(analysis, limits, config);
  const strategy = buildStrategy(analysis, decision, config);
  const sessionId = session.path ? path.basename(session.path, '.jsonl') : (hintedId || null);

  return {
    session,
    entries,
    analysis,
    decision,
    strategy,
    modelId,
    limits,
    sessionId,
  };
}

module.exports = {
  loadSession,
  runAnalyze,
};
