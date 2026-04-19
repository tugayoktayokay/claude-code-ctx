'use strict';

const path = require('path');

function buildStrategy(analysis, decision, config) {
  const categories = config?.categories || {};
  const { metrics } = decision;

  const strategy = {
    urgency: decision.level,
    keep: [],
    drop: [],
    compactPrompt: '',
    reasoning: [],
  };

  const sortedCats = [...analysis.activeCategories.entries()]
    .sort((a, b) => b[1].count - a[1].count);
  const topCatKeys = sortedCats.slice(0, 4).map(([k]) => k);
  const topCatLabels = topCatKeys.map(k => categories[k]?.label || k);

  if (topCatLabels.length) {
    strategy.keep.push(`active areas: ${topCatLabels.join(', ')}`);
  }

  if (analysis.filesModified.size > 0) {
    const files = [...analysis.filesModified]
      .slice(-8)
      .map(f => path.basename(f));
    strategy.keep.push(`modified files (${analysis.filesModified.size}): ${files.join(', ')}`);
    strategy.reasoning.push(`${analysis.filesModified.size} files modified — keep in context`);
  }

  if (analysis.decisions.length) {
    strategy.keep.push(`architectural decisions (${analysis.decisions.length})`);
    strategy.reasoning.push('Architectural decisions must be explicit in the summary');
  }

  const critTypes = [...new Set(analysis.criticalBits.map(c => c.type))];
  if (critTypes.length) {
    strategy.keep.push(`critical signals: ${critTypes.join(', ')}`);
  }

  if (analysis.lastNMessages.length) {
    const last = analysis.lastNMessages[analysis.lastNMessages.length - 1];
    strategy.keep.push(`last task: "${last.slice(0, 60)}"`);
  }

  if (analysis.failedAttempts.length) {
    strategy.keep.push(`failed approaches (${analysis.failedAttempts.length}) — do not retry`);
    strategy.reasoning.push('Without failed attempts in the summary, the same mistakes repeat');
  }

  if (analysis.largeOutputs.length) {
    const totalKb = Math.round(
      analysis.largeOutputs.reduce((a, b) => a + b.size, 0) / 1024
    );
    strategy.drop.push(
      `large tool outputs (${analysis.largeOutputs.length} items, ~${totalKb}kb)`
    );
    strategy.reasoning.push(
      `Tool outputs dominate context — keep only their conclusions`
    );
  }

  const repeatedPrefixes = new Map();
  for (const cmd of analysis.bashCommands) {
    const prefix = cmd.split(' ')[0];
    repeatedPrefixes.set(prefix, (repeatedPrefixes.get(prefix) || 0) + 1);
  }
  const repeated = [...repeatedPrefixes.entries()].filter(([, c]) => c > 2);
  if (repeated.length) {
    strategy.drop.push('repeated bash output');
  }

  strategy.compactPrompt = buildCompactPrompt(analysis, topCatLabels, strategy);

  return strategy;
}

function buildCompactPrompt(analysis, topCatLabels, strategy) {
  const parts = ['focus on'];

  if (topCatLabels.length) {
    parts.push(topCatLabels.slice(0, 3).join(' + '));
  }

  const preserve = [];

  if (analysis.filesModified.size > 0) {
    const files = [...analysis.filesModified]
      .slice(-5)
      .map(f => path.basename(f));
    preserve.push(`files: ${files.join(', ')}`);
  }

  if (analysis.decisions.length) {
    preserve.push(`${analysis.decisions.length} architectural decisions`);
  }

  if (analysis.failedAttempts.length) {
    preserve.push('failed attempts');
  }

  const critTypes = [...new Set(analysis.criticalBits.map(c => c.type))].slice(0, 3);
  if (critTypes.length) {
    preserve.push(critTypes.join(', '));
  }

  if (preserve.length) {
    parts.push(`— keep: ${preserve.join('; ')}`);
  }

  if (strategy.drop.length) {
    parts.push(`— drop: ${strategy.drop.slice(0, 2).join(', ')}`);
  }

  if (analysis.lastNMessages.length) {
    const last = analysis.lastNMessages[analysis.lastNMessages.length - 1];
    parts.push(`— continue: "${last.slice(0, 60)}"`);
  }

  return '/compact ' + parts.join(' ');
}

function copyToClipboard(text) {
  if (process.platform !== 'darwin') return false;
  try {
    const { execSync } = require('child_process');
    execSync('pbcopy', { input: text });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  buildStrategy,
  buildCompactPrompt,
  copyToClipboard,
};
