'use strict';

function detectModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const model = e?.message?.model || e?.model;
    if (e?.type === 'assistant' && model) return model;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const model = entries[i]?.message?.model || entries[i]?.model;
    if (model) return model;
  }
  return 'default';
}

function normalizeModelId(id) {
  if (!id) return 'default';
  return String(id)
    .replace(/^anthropic\//, '')
    .replace(/-20\d{6}$/, '')
    .replace(/\[[^\]]+\]$/, '')
    .trim();
}

function getLimits(modelId, config) {
  const models = config?.limits?.models || {};
  const norm = normalizeModelId(modelId);
  if (models[modelId]) return { model: modelId, ...models[modelId] };
  if (models[norm])    return { model: norm,    ...models[norm] };
  return { model: 'default', ...(models.default || { max: 200000, quality_ceiling: 200000 }) };
}

module.exports = {
  detectModel,
  normalizeModelId,
  getLimits,
};
