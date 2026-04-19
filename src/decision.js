'use strict';

const LEVELS = ['comfortable', 'watch', 'compact', 'urgent', 'critical'];

function makeDecision(analysis, limits, config) {
  const thresholds = config?.limits?.thresholds || {};
  const ceiling = limits.quality_ceiling || limits.max || 200000;
  const absoluteMax = limits.max || ceiling;
  const ctx = analysis.contextTokens;

  const pctCeiling = ctx / ceiling;
  const pctMax     = ctx / absoluteMax;

  const order = [
    ['critical',    thresholds.critical    ?? 0.90],
    ['urgent',      thresholds.urgent      ?? 0.75],
    ['compact',     thresholds.compact     ?? 0.55],
    ['watch',       thresholds.watch       ?? 0.40],
    ['comfortable', thresholds.comfortable ?? 0.20],
  ];

  let level = 'ok';
  for (const [name, threshold] of order) {
    if (pctCeiling >= threshold) { level = name; break; }
  }
  if (level === 'ok') level = 'comfortable';

  const reasons = [];
  const action = actionFor(level, pctCeiling, ctx);

  reasons.push(
    `Context ${Math.round(pctCeiling * 100)}% of ${fmtK(ceiling)} quality ceiling (${fmtK(ctx)} tokens)`
  );

  if (absoluteMax > ceiling) {
    reasons.push(`Model max: ${fmtK(absoluteMax)}, but quality degrades past ${fmtK(ceiling)}`);
  }

  if (analysis.avgGrowthPerTurn > 0) {
    const growthWarn = config?.limits?.growth_warn || 5000;
    if (analysis.avgGrowthPerTurn >= growthWarn / 5) {
      const threshold = (thresholds.compact ?? 0.55) * ceiling;
      const remaining = threshold - ctx;
      if (remaining > 0) {
        const turnsLeft = Math.round(remaining / analysis.avgGrowthPerTurn);
        reasons.push(
          `Growth ~${fmtK(analysis.avgGrowthPerTurn)}/turn — ~${turnsLeft} turns until compact`
        );
      }
    }
  }

  if (analysis.totalOutput > 0 && ctx > 20000) {
    const ratio = analysis.totalOutput / ctx;
    const warn = config?.limits?.output_ratio_warn || 0.4;
    if (ratio >= warn) {
      reasons.push(
        `Output ratio high (${Math.round(ratio * 100)}%) — Claude is verbose, consider a "keep responses short" instruction`
      );
    }
  }

  if (analysis.toolUses > 30 && analysis.messageCount > 0) {
    const perMsg = analysis.toolUses / analysis.messageCount;
    if (perMsg > 4) {
      reasons.push(`Heavy tool use (${perMsg.toFixed(1)} tools/message)`);
    }
  }

  return {
    level,
    action,
    reasons,
    metrics: {
      contextTokens: ctx,
      contextPct: Math.round(pctCeiling * 100),
      contextPctMax: Math.round(pctMax * 100),
      qualityCeiling: ceiling,
      modelMax: absoluteMax,
      outputTokens: analysis.totalOutput,
      messageCount: analysis.messageCount,
      toolUses: analysis.toolUses,
      filesModified: analysis.filesModified.size,
      avgGrowthPerTurn: analysis.avgGrowthPerTurn,
    },
  };
}

function actionFor(level, pct, ctx) {
  switch (level) {
    case 'critical':    return '/clear — snapshot first, then clear';
    case 'urgent':      return 'Run ctx compact, or /snapshot + /clear';
    case 'compact':     return 'ctx compact — prepare a tailored /compact prompt';
    case 'watch':       return 'Watch the growth rate';
    case 'comfortable': return 'Comfortable zone';
    default:            return null;
  }
}

function fmtK(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

module.exports = {
  makeDecision,
  LEVELS,
  fmtK,
};
